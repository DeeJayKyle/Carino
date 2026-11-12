import type { Services } from '../context.ts';
import { badRequest } from '../context.ts';
import { nowIso } from '../db/index.ts';
import { decryptSecret, encryptSecret } from './secrets.ts';
import { notify } from './activity.ts';
import { transcribe } from './transcribe.ts';

/**
 * Phone calls Carino places for the user, through their own Twilio account. A call follows a
 * script the user approved: Carino says it is an AI assistant calling on the user's behalf, says
 * what the call is about, asks each question and records the answer (or the person can hang up).
 * When the call ends, the answers are transcribed and reported back in the chat. It is not a
 * free-form conversation: Carino can't improvise or agree to anything on the call.
 */
export class PhoneError extends Error {}

const API = 'https://api.twilio.com/2010-04-01';

export function phoneSettings(services: Services, userId: string) {
  const r = services.db.get('SELECT account_sid, from_number, updated_at FROM phone_service WHERE user_id = ?', userId);
  return r ? { configured: true, account_sid: r.account_sid, from_number: r.from_number } : { configured: false };
}

export function savePhoneSettings(services: Services, userId: string, i: { account_sid: string; auth_token: string; from_number: string }) {
  if (!/^AC[0-9a-f]{32}$/i.test(i.account_sid)) throw badRequest('That doesn’t look like a Twilio Account SID (it starts with AC).');
  if (!/^\+[1-9]\d{6,14}$/.test(i.from_number)) throw badRequest('Give the Twilio number in international format, like +256700000000.');
  if (i.auth_token.length < 20) throw badRequest('That auth token looks too short.');
  services.db.run(
    `INSERT INTO phone_service (user_id, account_sid, secret, from_number, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET account_sid = excluded.account_sid, secret = excluded.secret, from_number = excluded.from_number, updated_at = excluded.updated_at`,
    userId, i.account_sid, encryptSecret(services.config.DATA_DIR, i.auth_token), i.from_number, nowIso(),
  );
  return phoneSettings(services, userId);
}

export function forgetPhoneSettings(services: Services, userId: string) {
  services.db.run('DELETE FROM phone_service WHERE user_id = ?', userId);
  return { ok: true };
}

function creds(services: Services, userId: string) {
  const r = services.db.get('SELECT * FROM phone_service WHERE user_id = ?', userId);
  const token = r ? decryptSecret(services.config.DATA_DIR, r.secret) : null;
  if (!r || !token) throw new PhoneError('Phone calls need your Twilio account. Add it in Settings → Phone calls.');
  return { sid: String(r.account_sid), token, from: String(r.from_number), auth: `Basic ${Buffer.from(`${r.account_sid}:${token}`).toString('base64')}` };
}

const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** The call script: an AI disclosure first, the purpose, then each question with a recorded answer. */
export function callScript(i: { assistant: string; user: string; purpose: string; questions: string[]; language?: string }) {
  const lang = i.language ? ` language="${esc(i.language)}"` : '';
  const say = (t: string) => `<Say${lang}>${esc(t)}</Say>`;
  const parts = [
    say(`Hello. This is ${i.assistant}, an AI assistant calling on behalf of ${i.user}. This call is recorded so I can pass your answers on.`),
    say(i.purpose),
    ...i.questions.flatMap((q) => [say(`${q} Please answer after the beep.`), '<Record maxLength="45" timeout="4" playBeep="true" trim="trim-silence"/>']),
    say(`Thank you. I'll pass this on to ${i.user}. Goodbye.`),
    '<Hangup/>',
  ];
  return `<Response>${parts.join('')}</Response>`;
}

async function twilio(services: Services, c: ReturnType<typeof creds>, path: string, init: RequestInit = {}) {
  const f = services.netFetch ?? fetch;
  const res = await f(`${API}/Accounts/${c.sid}${path}`, { ...init, headers: { authorization: c.auth, ...(init.headers ?? {}) } });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new PhoneError(`Twilio: ${body?.message ?? `HTTP ${res.status}`}`);
  return body;
}

/** Places the approved call and follows it in the background; the result arrives in the chat. */
export async function placeCall(services: Services, userId: string, conversationId: string | null, i: { to: string; purpose: string; questions: string[]; language?: string; assistant: string; user: string }) {
  const c = creds(services, userId);
  const twiml = callScript(i);
  const body = new URLSearchParams({ To: i.to, From: c.from, Twiml: twiml, Timeout: '30' });
  const call = await twilio(services, c, '/Calls.json', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const now = nowIso();
  const row = services.db.insert('phone_calls', {
    user_id: userId, conversation_id: conversationId, call_sid: call.sid, to_number: i.to, purpose: i.purpose,
    questions: JSON.stringify(i.questions), status: 'calling', created_at: now, updated_at: now,
  });
  void follow(services, userId, String(row.id), i.questions).catch(() => {});
  return { call_id: row.id, status: 'calling', note: 'The call is under way. The answers will appear in this chat when it ends (usually within a few minutes).' };
}

const DONE = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Waits for the call to end, then transcribes each recorded answer and reports back. */
export async function follow(services: Services, userId: string, callId: string, questions: string[], pollMs = 5000) {
  const db = services.db;
  const row = db.getOwned('phone_calls', userId, callId)!;
  const c = creds(services, userId);
  let status = 'calling';
  for (let i = 0; i < 180 && !DONE.has(status); i++) {
    await wait(pollMs);
    status = String((await twilio(services, c, `/Calls/${row.call_sid}.json`)).status);
  }
  const answers: { question: string; answer: string }[] = [];
  if (status === 'completed') {
    const recs = ((await twilio(services, c, `/Calls/${row.call_sid}/Recordings.json`)).recordings ?? []) as any[];
    recs.sort((a, b) => String(a.date_created).localeCompare(String(b.date_created)));
    for (const [n, q] of questions.entries()) {
      const rec = recs[n];
      if (!rec) {
        answers.push({ question: q, answer: '(no answer recorded — they may have hung up)' });
        continue;
      }
      const f = services.netFetch ?? fetch;
      const res = await f(`${API}/Accounts/${c.sid}/Recordings/${rec.sid}.wav`, { headers: { authorization: c.auth } });
      const audio = new Uint8Array(await res.arrayBuffer());
      const text = await transcribe(services, audio, `answer-${n + 1}.wav`, 'audio/wav').catch((e) => `(couldn’t transcribe: ${e.message})`);
      answers.push({ question: q, answer: text || '(silence)' });
    }
  }
  const outcome = status === 'completed' ? 'completed' : status;
  db.run('UPDATE phone_calls SET status = ?, answers = ?, updated_at = ? WHERE id = ?', outcome, JSON.stringify(answers), nowIso(), callId);
  const summary = status === 'completed'
    ? `**Call to ${row.to_number} finished.**\n\n${answers.map((a) => `- **${a.question}** ${a.answer}`).join('\n')}`
    : `**Call to ${row.to_number} didn’t go through** (${status.replace('-', ' ')}). Want me to try again later?`;
  if (row.conversation_id && db.getOwned('conversations', userId, String(row.conversation_id))) {
    db.insert('messages', { user_id: userId, conversation_id: row.conversation_id, role: 'assistant', content: summary, meta: JSON.stringify({ phone_call: callId }) });
  }
  notify(db, userId, { kind: 'phone_call', title: status === 'completed' ? 'Call finished' : 'Call didn’t go through', body: summary.replace(/\*\*/g, '').slice(0, 300), link: row.conversation_id ? `/chat/${row.conversation_id}` : '/notifications' });
  return { status: outcome, answers };
}
