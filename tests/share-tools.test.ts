import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, type TestCtx } from './helpers.ts';
import { settle } from '../server/tools/share-tools.ts';
import { executeTool, makeContext } from '../server/tools/registry.ts';
import { handleIncoming } from '../server/services/channels.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

describe('splitting costs', () => {
  it('settles an even split with the fewest payments', () => {
    const r = settle([{ name: 'Ann', paid: 90 }, { name: 'Ben', paid: 30 }], ['Ann', 'Ben', 'Cy']);
    expect(r.total).toBe(120);
    expect(r.balances).toEqual({ Ann: 50, Ben: -10, Cy: -40 });
    expect(r.transfers).toEqual([{ from: 'Cy', to: 'Ann', amount: 40 }, { from: 'Ben', to: 'Ann', amount: 10 }]);
  });

  it('respects a person’s own share', () => {
    const r = settle([{ name: 'Ann', paid: 100 }, { name: 'Ben', paid: 0, share: 10 }], ['Ann', 'Ben']);
    expect(r.transfers).toEqual([{ from: 'Ben', to: 'Ann', amount: 10 }]);
  });
});

describe('group catch-up', () => {
  it('keeps group messages only when the owner turned it on, and summarises from them', async () => {
    const c = await signup(ctx);
    const db = ctx.services.db;
    const ch = db.insert('channels', { user_id: c.user.id, kind: 'telegram', enabled: 1, config: '{}' });
    const chat = db.insert('channel_chats', { user_id: c.user.id, channel_id: ch.id, external_id: 'g1', owner_external_id: 'u1', title: 'Family', is_group: 1 });
    const say = (text: string) => handleIncoming(ctx.services, ch, { chatId: 'g1', senderId: 'u2', senderName: 'Mum', chatTitle: 'Family', isGroup: true, addressed: false, text });
    await say('Dinner at ours on Sunday?');
    expect(db.all('SELECT * FROM group_log')).toHaveLength(0);
    await c.patch(`/api/channel-chats/${chat.id}`, { catchup: true });
    await say('Bring a dessert please');
    const out: any = await executeTool('group_catchup', { group: 'fam' }, makeContext(ctx.services, c.user.id, null));
    expect(out.result.messages.map((m: any) => m.text)).toEqual(['Bring a dessert please']);
    expect(out.result.messages[0].sender).toBe('Mum');
    await c.patch(`/api/channel-chats/${chat.id}`, { catchup: false });
    expect(db.all('SELECT * FROM group_log')).toHaveLength(0);
  });
});
