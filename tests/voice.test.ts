import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, text, type TestCtx } from './helpers.ts';
import { buildSystemPrompt } from '../server/ai/agent.ts';
import { getSettings } from '../server/services/settings.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

describe('sound like me', () => {
  it('learns from the user’s own messages, skips private chats, and shapes drafts', async () => {
    const c = await signup(ctx);
    const conv = (await c.post('/api/conversations', {})).data;
    const secret = (await c.post('/api/conversations', {})).data;
    await c.patch(`/api/conversations/${secret.id}/local-only`, { local_only: true });
    const db = ctx.services.db;
    const add = (convId: string, content: string) => db.insert('messages', { user_id: c.user.id, conversation_id: convId, role: 'user', content, meta: '{}' });
    for (let i = 0; i < 6; i++) add(conv.id, `hey!! quick one — can u sort the pharmacy order before fri? cheers x (${i})`);
    add(secret.id, 'PRIVATE: my bank pin is something');
    ctx.provider.steps.push((req) => {
      const prompt = JSON.stringify(req.messages);
      expect(prompt).toContain('quick one');
      expect(prompt).not.toContain('PRIVATE');
      return text('Write short, casual lines in lower case. Start with "hey". Sign off with "cheers x".');
    });
    const r = await c.post('/api/settings/voice/learn', {});
    expect(r.status).toBe(200);
    const s = getSettings(db, c.user.id);
    expect(s.profile.assistantStyle).toBe('mine');
    expect(buildSystemPrompt(c.user as any, s)).toContain('Sign off with "cheers x"');
    expect((await c.del('/api/settings/voice')).status).toBe(200);
    expect(getSettings(db, c.user.id).profile.voiceProfile).toBe('');
  });

  it('asks for more writing when there is too little', async () => {
    const c = await signup(ctx);
    expect((await c.post('/api/settings/voice/learn', {})).status).toBe(400);
  });
});
