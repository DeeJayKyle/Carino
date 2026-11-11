import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, type TestCtx } from './helpers.ts';

/** Two Carinos: a phone and a PC, joined by the phone's network calls going to the PC's sync endpoint. */
let phone: TestCtx;
let pc: TestCtx;
const PC = 'http://192.168.1.20:47900';
let tamper: ((body: string) => string) | null = null;
let pcDown = false;

beforeEach(() => {
  phone = setup();
  pc = setup();
  tamper = null;
  pcDown = false;
  phone.services.netFetch = (async (url: any, init: any = {}) => {
    if (!String(url).startsWith(`${PC}/carino-sync`)) throw new Error(`unexpected ${url}`);
    if (pcDown) throw new TypeError('fetch failed');
    const body = tamper ? tamper(String(init.body)) : String(init.body);
    return pc.app.request('/carino-sync', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(() => {
  phone.cleanup();
  pc.cleanup();
});

type C = Awaited<ReturnType<typeof signup>>;
async function pair(p: C, d: C, confirm = true) {
  const start = (await d.post('/api/sync/pair/start', { addresses: [PC] })).data;
  const joined = await p.post('/api/sync/pair/join', { link: start.link });
  expect(joined.status).toBe(200);
  const peerOnPc = (await d.get('/api/sync')).data.peers[0];
  const pcCheck = (await d.get(`/api/sync/peers/${peerOnPc.device_id}/check`)).data.check;
  expect(joined.data.check).toBe(pcCheck); // the same number on both screens
  if (confirm) {
    await p.post(`/api/sync/peers/${joined.data.peer}/confirm`, {});
    await d.post(`/api/sync/peers/${peerOnPc.device_id}/confirm`, {});
  }
  return { pcId: joined.data.peer as string, phoneId: peerOnPc.device_id as string, check: joined.data.check as string };
}
const syncNow = async (p: C) => (await p.post('/api/sync/now', {})).data;
const titles = async (c: C) => (await c.get('/api/tasks?view=all')).data.tasks.map((t: any) => t.title).sort();

describe('pairing', () => {
  it('pairs with a code, shows matching check numbers, and syncs only after both confirm', async () => {
    const p = await signup(phone, 'Herbert');
    const d = await signup(pc, 'Herbert');
    await p.post('/api/tasks', { title: 'From the phone' });
    const { check } = await pair(p, d, false);
    expect(check).toMatch(/^\d{3} \d{3}$/);
    const before = await syncNow(p);
    expect(before.results).toEqual([]); // not confirmed on the phone yet: nothing to sync with
    const pcPeer = (await p.get('/api/sync')).data.peers[0];
    await p.post(`/api/sync/peers/${pcPeer.device_id}/confirm`, {});
    const refused = await syncNow(p);
    expect(refused.results[0].error).toContain('Confirm the check number on the PC');
    expect(await titles(d)).toEqual([]);
  });

  it('pairs with the code and address typed in (no QR code)', async () => {
    const p = await signup(phone);
    const d = await signup(pc);
    const start = (await d.post('/api/sync/pair/start', { addresses: [] })).data;
    const r = await p.post('/api/sync/pair/join', { code: start.code.toLowerCase(), address: PC });
    expect(r.status).toBe(200);
    const pcPeer = (await d.get('/api/sync')).data.peers[0];
    expect((await d.get(`/api/sync/peers/${pcPeer.device_id}/check`)).data.check).toBe(r.data.check);
  });

  it('refuses a wrong code, and stops after 10 tries', async () => {
    const p = await signup(phone);
    const d = await signup(pc);
    const start = (await d.post('/api/sync/pair/start', { addresses: [PC] })).data;
    const wrong = { offer: start.offer, code: 'AAAAA-AAAAA', address: PC };
    const r = await p.post('/api/sync/pair/join', wrong);
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('doesn’t match');
    expect(pc.services.db.get('SELECT attempts FROM sync_pairing')!.attempts).toBe(1);
    for (let i = 0; i < 9; i++) await p.post('/api/sync/pair/join', wrong);
    // After 10 wrong codes the pairing is gone: the right code no longer works either.
    expect(pc.services.db.get('SELECT COUNT(*) AS n FROM sync_pairing')!.n).toBe(0);
    expect((await p.get('/api/sync')).data.peers).toEqual([]);
  });

  it('a message that was changed on the way is refused', async () => {
    const p = await signup(phone);
    const d = await signup(pc);
    await pair(p, d);
    await p.post('/api/tasks', { title: 'Secret plan' });
    tamper = (body) => {
      const env = JSON.parse(body);
      if (env.ct) env.ct = env.ct.slice(0, -4) + (env.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA');
      return JSON.stringify(env);
    };
    const r = await syncNow(p);
    expect(r.results[0].error).toContain('couldn’t be opened');
    expect(await titles(d)).toEqual([]);
  });

  it('says plainly when the PC can’t be reached, and catches up later', async () => {
    const p = await signup(phone);
    const d = await signup(pc);
    await pair(p, d);
    pcDown = true;
    await p.post('/api/tasks', { title: 'Made offline' });
    expect((await syncNow(p)).results[0].error).toContain('Can’t reach your PC');
    pcDown = false;
    await syncNow(p);
    expect(await titles(d)).toEqual(['Made offline']);
  });
});

describe('sync', () => {
  it('everything already there goes both ways, then edits and deletions follow', async () => {
    const p = await signup(phone, 'Herbert');
    const d = await signup(pc, 'Herbert');
    await p.patch('/api/settings', { money: { currency: 'UGX' } });
    await d.patch('/api/settings', { money: { currency: 'UGX' } });
    const t = (await p.post('/api/tasks', { title: 'Renew licence' })).data;
    await p.post('/api/expenses', { amount: 87500, category: 'groceries', source: 'receipt' });
    await d.post('/api/tasks', { title: 'Order stock (from PC)' });
    await d.post('/api/memories', { content: 'Supplier is Abacus', context: 'work' });
    await pair(p, d);
    const r = await syncNow(p);
    expect(r.results[0]).toMatchObject({ conflicts: 0 });
    expect(await titles(d)).toEqual(['Order stock (from PC)', 'Renew licence']);
    expect(await titles(p)).toEqual(['Order stock (from PC)', 'Renew licence']);
    expect((await d.get('/api/money')).data.expenses[0]).toMatchObject({ amount: 87500, source: 'receipt', currency: 'UGX' });
    expect((await p.get('/api/memories?status=active&context=work')).data.memories[0].content).toBe('Supplier is Abacus');
    // Search works for what arrived.
    expect(JSON.stringify((await d.get('/api/search?q=licence')).data)).toContain('Renew licence');

    await d.patch(`/api/tasks/${t.id}`, { title: 'Renew licence (done online)' });
    await syncNow(p);
    expect(await titles(p)).toContain('Renew licence (done online)');
    await p.del(`/api/tasks/${t.id}`);
    await syncNow(p);
    expect(await titles(d)).toEqual(['Order stock (from PC)']);
    // Nothing more to send: a second sync is quiet.
    expect((await syncNow(p)).results[0]).toMatchObject({ sent: 0, received: 0 });
  });

  it('a record changed on both is a conflict, never overwritten, and the choice settles it on both', async () => {
    const p = await signup(phone);
    const d = await signup(pc);
    const t = (await p.post('/api/tasks', { title: 'Call the bank' })).data;
    await pair(p, d);
    await syncNow(p);
    await p.patch(`/api/tasks/${t.id}`, { title: 'Call the bank at 9' });
    await d.patch(`/api/tasks/${t.id}`, { title: 'Call the bank about fees' });
    const r = await syncNow(p);
    expect(r.conflicts).toBe(1);
    expect(await titles(p)).toEqual(['Call the bank at 9']);
    expect(await titles(d)).toEqual(['Call the bank about fees']);
    const conflict = (await p.get('/api/sync')).data.conflicts[0];
    expect(conflict).toMatchObject({ tbl: 'tasks', row_id: t.id, mine: { title: 'Call the bank at 9' }, theirs: { title: 'Call the bank about fees' } });
    expect((await d.get('/api/sync')).data.conflicts).toHaveLength(1);
    await p.post(`/api/sync/conflicts/${conflict.id}`, { keep: 'mine' });
    await syncNow(p);
    expect(await titles(d)).toEqual(['Call the bank at 9']);
    expect((await d.get('/api/sync')).data.conflicts).toEqual([]);
    expect((await p.get('/api/sync')).data.conflicts).toEqual([]);
  });

  it('“take theirs” brings the other device’s version here', async () => {
    const p = await signup(phone);
    const d = await signup(pc);
    const t = (await p.post('/api/tasks', { title: 'A' })).data;
    await pair(p, d);
    await syncNow(p);
    await p.patch(`/api/tasks/${t.id}`, { title: 'B (phone)' });
    await d.patch(`/api/tasks/${t.id}`, { title: 'C (pc)' });
    await syncNow(p);
    const conflict = (await p.get('/api/sync')).data.conflicts[0];
    await p.post(`/api/sync/conflicts/${conflict.id}`, { keep: 'theirs' });
    expect(await titles(p)).toEqual(['C (pc)']);
    await syncNow(p);
    expect((await d.get('/api/sync')).data.conflicts).toEqual([]);
    expect(await titles(d)).toEqual(['C (pc)']);
  });

  it('files come across, and chats can be continued with a handoff', async () => {
    const p = await signup(phone);
    const d = await signup(pc);
    const form = new FormData();
    form.set('file', new Blob(['Price list: Paracetamol UGX 2,000'], { type: 'text/plain' }), 'prices.txt');
    const doc = (await p.req('POST', '/api/documents', form)).data.document;
    const conv = (await p.post('/api/conversations', { title: 'Plan the week' })).data;
    phone.provider.steps.push(() => ({ content: [{ type: 'text', text: 'Start with the stock order.' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'f' }) as any);
    await p.post(`/api/conversations/${conv.id}/messages`, { text: 'help me plan the week' });
    await pair(p, d);
    const h = await p.post('/api/handoffs', { kind: 'chat', ref_id: conv.id, note: 'Finish this on the PC', files: [doc.id] });
    expect(h.status).toBe(201);
    await syncNow(p);
    const onPc = (await d.get('/api/handoffs')).data.handoffs;
    expect(onPc).toHaveLength(1);
    expect(onPc[0]).toMatchObject({ kind: 'chat', ref_id: conv.id, title: 'Plan the week', note: 'Finish this on the PC', files: [doc.id], from_here: false });
    expect((await p.get('/api/handoffs')).data.handoffs[0].from_here).toBe(true);
    const msgs = (await d.get(`/api/conversations/${conv.id}`)).data.messages.map((m: any) => m.content);
    expect(msgs).toEqual(['help me plan the week', 'Start with the stock order.']);
    const file = await d.get(`/api/documents/${doc.id}/download`);
    expect(new TextDecoder().decode(file.data)).toBe('Price list: Paracetamol UGX 2,000');
    await d.post(`/api/handoffs/${onPc[0].id}/done`, {});
    await syncNow(p);
    expect((await p.get('/api/handoffs')).data.handoffs).toEqual([]);
  });

  it('approvals and routines stay on their own device (they would otherwise run twice)', async () => {
    const p = await signup(phone);
    const d = await signup(pc);
    await p.post('/api/routines', { title: 'Friday wins', prompt: 'List my wins', time_local: '16:30', days: [5] });
    phone.services.db.insert('actions', { user_id: p.user.id, tool: 'gmail_send', risk: 'consequential', input: '{}', summary: 'x', status: 'pending', payload_hash: 'h' });
    await pair(p, d);
    await syncNow(p);
    expect(pc.services.db.get('SELECT COUNT(*) AS n FROM routines WHERE kind = ?', 'custom')!.n).toBe(0);
    expect(pc.services.db.get('SELECT COUNT(*) AS n FROM actions')!.n).toBe(0);
  });

  it('a device that is forgotten stops syncing', async () => {
    const p = await signup(phone);
    const d = await signup(pc);
    const { pcId } = await pair(p, d);
    await p.del(`/api/sync/peers/${pcId}`);
    await p.post('/api/tasks', { title: 'Private now' });
    expect((await syncNow(p)).results).toEqual([]);
    expect(await titles(d)).toEqual([]);
  });
});
