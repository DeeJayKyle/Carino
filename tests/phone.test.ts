import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, type TestCtx } from './helpers.ts';
import { callScript, follow, savePhoneSettings } from '../server/services/phone.ts';
import { executeTool, makeContext } from '../server/tools/registry.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

const SID = 'AC' + 'a'.repeat(32);

describe('phone calls', () => {
  it('starts every call by saying it is an AI calling on the user’s behalf, and escapes the script', () => {
    const xml = callScript({ assistant: 'Carino', user: 'Herbert', purpose: 'I’d like to ask about <your> hours & prices.', questions: ['Are you open on Sunday?'] });
    expect(xml.indexOf('an AI assistant calling on behalf of Herbert')).toBeLessThan(xml.indexOf('hours'));
    expect(xml).toContain('&lt;your&gt; hours &amp; prices');
    expect(xml).toContain('<Record');
  });

  it('refuses bad account details', async () => {
    const c = await signup(ctx);
    expect(() => savePhoneSettings(ctx.services, c.user.id, { account_sid: 'nope', auth_token: 'x'.repeat(32), from_number: '+256700000000' })).toThrow(/Account SID/);
    expect(() => savePhoneSettings(ctx.services, c.user.id, { account_sid: SID, auth_token: 'x'.repeat(32), from_number: '0700' })).toThrow(/international/);
  });

  it('asks before calling, and reports the answers in the chat when the call ends', async () => {
    const c = await signup(ctx);
    savePhoneSettings(ctx.services, c.user.id, { account_sid: SID, auth_token: 't'.repeat(32), from_number: '+256700000001' });
    const conv = (await c.post('/api/conversations', {})).data;
    const queued: any = await executeTool('place_call', { to: '+256700000002', purpose: 'Asking about a table for four.', questions: ['Do you have a table at 7pm?'] }, makeContext(ctx.services, c.user.id, conv.id));
    expect(queued.status).toBe('pending_approval');

    ctx.services.netFetch = (async (url: string) => {
      if (url.endsWith('/Calls/CA1.json')) return new Response(JSON.stringify({ status: 'completed' }));
      if (url.endsWith('/Calls/CA1/Recordings.json')) return new Response(JSON.stringify({ recordings: [{ sid: 'RE1', date_created: '1' }] }));
      if (url.endsWith('/Recordings/RE1.wav')) return new Response(new Uint8Array([1, 2, 3]));
      return new Response('{}', { status: 404 });
    }) as any;
    const now = new Date().toISOString();
    const row = ctx.services.db.insert('phone_calls', { user_id: c.user.id, conversation_id: conv.id, call_sid: 'CA1', to_number: '+256700000002', purpose: 'x', questions: '["Do you have a table at 7pm?"]', status: 'calling', created_at: now, updated_at: now });
    const out = await follow(ctx.services, c.user.id, String(row.id), ['Do you have a table at 7pm?'], 1);
    expect(out.status).toBe('completed');
    const msgs = (await c.get(`/api/conversations/${conv.id}`)).data.messages;
    expect(msgs.at(-1).content).toContain('Call to +256700000002 finished');
    expect(ctx.services.db.all("SELECT * FROM notifications WHERE kind = 'phone_call'")).toHaveLength(1);
  });
});
