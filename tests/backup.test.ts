import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, type TestCtx } from './helpers.ts';
import { decryptBackup, encryptBackup, collect } from '../server/services/backup.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

const PASS = 'correct horse battery staple';
type C = Awaited<ReturnType<typeof signup>>;

/** Made-up data across the app, plus things that must never be backed up. */
async function seed(c: C) {
  await c.patch('/api/settings', { money: { currency: 'UGX' }, profile: { displayName: 'Herbert' } });
  const task = (await c.post('/api/tasks', { title: 'Renew pharmacy licence', priority: 1 })).data;
  await c.post('/api/expenses', { amount: 87500, category: 'groceries', merchant: 'Capital Shoppers', source: 'receipt' });
  await c.post('/api/expenses', { amount: 20, currency: 'USD', category: 'bills' });
  const ph = (await c.post('/api/money/books', { name: 'Pharmacy' })).data;
  await c.post('/api/income', { amount: 2300000, source: 'Sales', book: ph.id });
  await c.post('/api/memories', { content: 'Prefers short answers', category: 'preference' });
  const form = new FormData();
  form.set('file', new Blob(['Price list: Paracetamol UGX 2,000'], { type: 'text/plain' }), 'prices.txt');
  const doc = (await c.req('POST', '/api/documents', form)).data.document;
  // Saved sign-ins: these must stay out of backups.
  ctx.services.db.insert('app_accounts', { user_id: c.user.id, provider: 'google', external_id: 'g1', label: 'me@example.com', secret: 'SECRET-TOKEN-DO-NOT-BACKUP' });
  return { task, ph, doc };
}

async function makeBackup(c: C) {
  const r = await c.post('/api/backup', { passphrase: PASS });
  expect(r.status).toBe(201);
  return r.data;
}

describe('encrypted backup', () => {
  it('is encrypted, verified, test-restored, and leaves sign-ins out', async () => {
    const c = await signup(ctx);
    await seed(c);
    const b = await makeBackup(c);
    expect(b).toMatchObject({ verified: true, files: 1 });
    const raw = new Uint8Array((await c.get(`/api/backup/files/${b.name}`)).data);
    const text = new TextDecoder().decode(raw);
    expect(text.startsWith('CARINO-BACKUP\n')).toBe(true);
    for (const plain of ['Renew pharmacy licence', 'Capital Shoppers', 'Paracetamol', 'SECRET-TOKEN']) expect(text).not.toContain(plain);
    const p = await decryptBackup(raw, PASS);
    expect(p.tables.tasks[0].title).toBe('Renew pharmacy licence');
    expect(p.tables.app_accounts).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain('SECRET-TOKEN');
    expect(p.tables.expenses.map((e: any) => [e.source, e.currency])).toEqual([['receipt', 'UGX'], ['manual', 'USD']]);
    expect((await c.get('/api/backup')).data.backups[0].name).toBe(b.name);
  });

  it('refuses short passphrases, wrong passphrases and changed files', async () => {
    const c = await signup(ctx);
    await seed(c);
    expect((await c.post('/api/backup', { passphrase: 'short' })).status).toBe(400);
    const b = await makeBackup(c);
    const wrong = await c.post('/api/backup/inspect', { name: b.name, passphrase: 'not the passphrase' });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error).toContain('Wrong passphrase');
    const raw = new Uint8Array((await c.get(`/api/backup/files/${b.name}`)).data);
    const tampered = raw.slice();
    tampered[tampered.length - 40] ^= 1;
    await expect(decryptBackup(tampered, PASS)).rejects.toThrow(/changed or damaged/);
    // Even the header is protected: changing the date breaks it.
    const head = new TextDecoder().decode(raw.subarray(0, 200)).replace(/"created_at":"\d/, '"created_at":"9');
    const swapped = new Uint8Array(raw);
    swapped.set(new TextEncoder().encode(head));
    await expect(decryptBackup(swapped, PASS)).rejects.toThrow();
    await expect(decryptBackup(new TextEncoder().encode('hello'), PASS)).rejects.toThrow(/isn’t a Carino backup/);
  });

  it('a backup whose contents don’t match their checksums is refused', async () => {
    const c = await signup(ctx);
    await seed(c);
    const p = collect(ctx.services.db, c.user.id, new Date());
    p.tables.tasks[0].title = 'Changed after the checksum';
    await expect(decryptBackup(await encryptBackup(p, PASS, 100_000), PASS)).rejects.toThrow(/don’t match its checksum/);
  });
});

describe('restore', () => {
  it('previews first, then merge adds what’s missing and keeps what’s here', async () => {
    const c = await signup(ctx);
    const { task } = await seed(c);
    const b = await makeBackup(c);
    await c.del(`/api/tasks/${task.id}`);
    await c.post('/api/memories', { content: 'New since the backup' });
    const exp = (await c.get('/api/money')).data.expenses[0];
    await c.patch(`/api/expenses/${exp.id}`, { note: 'Edited after the backup' });
    const pv = (await c.post('/api/backup/inspect', { name: b.name, passphrase: PASS })).data;
    expect(pv.tables.find((t: any) => t.table === 'tasks')).toMatchObject({ in_backup: 1, new: 1 });
    expect(pv.tables.find((t: any) => t.table === 'expenses')).toMatchObject({ different: 1, same: 1 });
    expect(pv.left_out).toContain('Sign-ins to your apps');
    // Inspecting changed nothing.
    expect((await c.get('/api/tasks?view=all')).data.tasks).toHaveLength(0);
    expect((await c.post('/api/backup/restore', { name: b.name, passphrase: PASS, mode: 'merge' })).status).toBe(400); // must confirm
    const r = (await c.post('/api/backup/restore', { name: b.name, passphrase: PASS, mode: 'merge', confirm: true })).data;
    expect(r.restored.tasks).toEqual({ added: 1, kept: 0 });
    expect((await c.get('/api/tasks?view=all')).data.tasks[0].title).toBe('Renew pharmacy licence');
    expect((await c.get('/api/money')).data.expenses.find((e: any) => e.id === exp.id).note).toBe('Edited after the backup');
    expect((await c.get('/api/memories?status=active')).data.memories.map((m: any) => m.content)).toContain('New since the backup');
    // Search works for restored records.
    expect(JSON.stringify((await c.get('/api/search?q=licence')).data)).toContain('Renew pharmacy licence');
  });

  it('replace makes it exactly the backup, and the safety copy undoes it', async () => {
    const c = await signup(ctx);
    await seed(c);
    const b = await makeBackup(c);
    await c.post('/api/tasks', { title: 'Made after the backup' });
    const r = (await c.post('/api/backup/restore', { name: b.name, passphrase: PASS, mode: 'replace', confirm: true })).data;
    expect((await c.get('/api/tasks?view=all')).data.tasks.map((t: any) => t.title)).toEqual(['Renew pharmacy licence']);
    // Undo: restore the safety copy that was saved first.
    expect(r.undo).toMatch(/^before-restore-/);
    await c.post('/api/backup/restore', { name: r.undo, passphrase: PASS, mode: 'replace', confirm: true });
    expect((await c.get('/api/tasks?view=all')).data.tasks.map((t: any) => t.title).sort()).toEqual(['Made after the backup', 'Renew pharmacy licence']);
  });

  it('restores onto a new phone (a new account), files included', async () => {
    const c = await signup(ctx);
    const { doc, ph } = await seed(c);
    const b = await makeBackup(c);
    const file = new Uint8Array((await c.get(`/api/backup/files/${b.name}`)).data);
    // A new phone: a separate, empty Carino.
    const phone2 = setup();
    const fresh = await signup(phone2, 'New phone');
    const form = new FormData();
    form.set('file', new Blob([file]), b.name);
    form.set('passphrase', PASS);
    form.set('mode', 'replace');
    form.set('confirm', 'true');
    const r = await fresh.req('POST', '/api/backup/restore', form);
    expect(r.status).toBe(200);
    const money = (await fresh.get(`/api/money?book=${ph.id}`)).data;
    expect(money).toMatchObject({ income: 2300000 });
    expect((await fresh.get('/api/money')).data.expenses.map((e: any) => e.source)).toContain('receipt');
    const dl = await fresh.get(`/api/documents/${doc.id}/download`);
    expect(new TextDecoder().decode(dl.data)).toBe('Price list: Paracetamol UGX 2,000');
    expect((await fresh.get('/api/settings')).data.money.currency).toBe('UGX');
    expect(JSON.stringify((await fresh.get('/api/search?q=licence')).data)).toContain('Renew pharmacy licence');
    // The old phone's account is untouched.
    expect((await c.get('/api/tasks?view=all')).data.tasks).toHaveLength(1);
    phone2.cleanup();
  });

  it('a failed restore changes nothing', async () => {
    const c = await signup(ctx);
    await seed(c);
    const p = collect(ctx.services.db, c.user.id, new Date());
    p.tables.tasks.push({ ...p.tables.tasks[0], id: 'broken', project_id: 'no-such-project' });
    const { restore } = await import('../server/services/backup.ts');
    await c.post('/api/tasks', { title: 'Still here' });
    expect(() => restore(ctx.services.db, c.user.id, ctx.dataDir, p, 'replace')).toThrow();
    expect((await c.get('/api/tasks?view=all')).data.tasks.map((t: any) => t.title).sort()).toEqual(['Renew pharmacy licence', 'Still here']);
  });

  it('only the owner can see or use their backups', async () => {
    const c = await signup(ctx);
    await seed(c);
    const b = await makeBackup(c);
    const other = await signup(ctx, 'Other');
    expect((await other.get(`/api/backup/files/${b.name}`)).status).toBe(404);
    expect((await other.post('/api/backup/inspect', { name: b.name, passphrase: PASS })).status).toBe(400);
    expect((await other.get('/api/backup')).data.backups).toEqual([]);
    expect((await c.get('/api/backup/files/..%2F..%2Fsecret.key')).status).toBe(404);
  });
});
