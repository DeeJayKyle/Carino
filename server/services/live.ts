import type { Services } from '../context.ts';
import { getSettings } from './settings.ts';
import { buildSystemPrompt } from '../ai/agent.ts';

/**
 * Live voice: a real-time spoken conversation with an AI service the user connected (OpenAI
 * Realtime or Google Gemini Live). The app's page streams audio straight to the service with a
 * short-lived token made here, so the user's real key never reaches the page. During the call the
 * model can use a few of Carino's tools; those run here, under the same approval rules as chat.
 */
export class LiveError extends Error {}

/** What the voice model may do during a call (changes and deletions still ask first). */
export const LIVE_TOOLS = ['list_tasks', 'get_daily_overview', 'create_task', 'complete_task', 'create_reminder', 'recall_memories', 'save_memory', 'web_search', 'find_places'];

export const OPENAI_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];
export const GEMINI_VOICES = ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Leda', 'Orus', 'Puck', 'Zephyr'];

function keyFor(services: Services, kind: 'openai' | 'gemini') {
  for (const c of services.providers.connections()) {
    if (!c.apiKey) continue;
    if (kind === 'openai' && /api\.openai\.com/.test(c.baseUrl)) return c.apiKey;
    if (kind === 'gemini' && /generativelanguage\.googleapis\.com/.test(c.baseUrl)) return c.apiKey;
  }
  return null;
}

/** Which live services the user can use right now. */
export function liveOptions(services: Services, userId: string) {
  const s = getSettings(services.db, userId);
  if (s.ai.localOnly) return { available: [], reason: 'You keep everything on your devices, so online live voice is off.' };
  const available = [
    ...(keyFor(services, 'openai') ? [{ id: 'openai', label: 'OpenAI Realtime', voices: OPENAI_VOICES }] : []),
    ...(keyFor(services, 'gemini') ? [{ id: 'gemini', label: 'Google Gemini Live', voices: GEMINI_VOICES }] : []),
  ];
  return { available, voice: s.voice.liveVoice, reason: available.length ? undefined : 'Live voice needs an OpenAI or Google Gemini key. Add one in Settings → AI & connections.' };
}

async function toolDeclarations() {
  const { toolSpecs } = await import('../tools/registry.ts');
  return toolSpecs('full').filter((t) => LIVE_TOOLS.includes(t.name));
}

/** Starts a live session: a short-lived token and the settings for the page to connect with. */
export async function startLive(services: Services, userId: string, provider: 'openai' | 'gemini') {
  const opts = liveOptions(services, userId);
  if (!opts.available.some((a) => a.id === provider)) throw new LiveError(opts.reason ?? 'That live service isn’t set up.');
  const s = getSettings(services.db, userId);
  const user = services.db.get('SELECT id, name, email FROM users WHERE id = ?', userId)!;
  const instructions = `${buildSystemPrompt(user as any, s)}\n\nYou are speaking out loud in a live voice conversation: keep replies short and natural, one or two sentences unless asked for more. Never read out links or long lists.`;
  const tools = await toolDeclarations();
  const f = services.netFetch ?? fetch;
  if (provider === 'openai') {
    const voice = OPENAI_VOICES.includes(s.voice.liveVoice) ? s.voice.liveVoice : 'marin';
    const res = await f('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { authorization: `Bearer ${keyFor(services, 'openai')}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 600 },
        session: {
          type: 'realtime', model: 'gpt-realtime', instructions,
          audio: { output: { voice } },
          tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema })),
        },
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.value) throw new LiveError(`OpenAI: ${body?.error?.message ?? `HTTP ${res.status}`}`);
    return { provider, token: body.value as string, model: 'gpt-realtime', voice };
  }
  const voice = GEMINI_VOICES.includes(s.voice.liveVoice) ? s.voice.liveVoice : 'Aoede';
  const model = 'gemini-live-2.5-flash-preview';
  const res = await f('https://generativelanguage.googleapis.com/v1alpha/auth_tokens', {
    method: 'POST',
    headers: { 'x-goog-api-key': keyFor(services, 'gemini')!, 'content-type': 'application/json' },
    body: JSON.stringify({ uses: 1, expireTime: new Date(Date.now() + 30 * 60_000).toISOString(), newSessionExpireTime: new Date(Date.now() + 60_000).toISOString() }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.name) throw new LiveError(`Gemini: ${body?.error?.message ?? `HTTP ${res.status}`}`);
  return {
    provider, token: body.name as string, model, voice,
    setup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      systemInstruction: { parts: [{ text: instructions }] },
      tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) }],
    },
  };
}

/** A tool the live model asked for: run with the user's normal permissions (changes may wait for approval). */
export async function liveTool(services: Services, userId: string, name: string, args: unknown) {
  if (!LIVE_TOOLS.includes(name)) return { error: 'Not available during a live call.' };
  const { executeTool, makeContext } = await import('../tools/registry.ts');
  const out = await executeTool(name, args, { ...makeContext(services, userId, null), cloud: true });
  if (out.status === 'pending_approval') return { status: 'waiting for the user to approve in the app', summary: out.summary };
  if (out.status === 'error') return { error: out.error };
  return out.result;
}
