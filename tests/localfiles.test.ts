import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync, utimesSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, signup, text, toolCall, type TestCtx } from './helpers.ts';
import { NodeLocalFs, safeRel } from '../server/services/localfs.ts';
import { approveAction } from '../server/tools/registry.ts';

let ctx: TestCtx;
let root: string;
let outside: string;
beforeEach(() => {
  ctx = setup();
  ctx.services.localFs = new NodeLocalFs(join(ctx.dataDir, 'recovery'));
  root = mkdtempSync(join(tmpdir(), 'carino-folder-'));
  outside = mkdtempSync(join(tmpdir(), 'carino-outside-'));
  // A made-up Documents folder.
  const put = (rel: string, body: string | Buffer, year = 2026) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
    const t = new Date(`${year}-03-01T10:00:00Z`);
    utimesSync(join(root, rel), t, t);
  };
  put('Price list.txt', 'Paracetamol: UGX 2,000\nAmoxicillin: UGX 5,500');
  put('Stock/October stock.csv', 'item,qty\nGloves,40\nParacetamol,120');
  put('notes.md', '# Supplier\nAbacus delivers on Fridays.');
  put('Copy of Price list.txt', 'Paracetamol: UGX 2,000\nAmoxicillin: UGX 5,500');
  put('scan-receipt.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  for (const n of ['a.md', 'b.md', 'c.md']) put(`Loose ${n}`, `Loose note ${n}`, 2025);
  writeFileSync(join(outside, 'secret.txt'), 'Not shared with Carino');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link-to-outside.txt'));
});
afterEach(() => {
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function withFolder() {
  const c = await signup(ctx);
  const r = await c.post('/api/files/folders', { root, label: 'Documents' });
  expect(r.status).toBe(201);
  return { c, folder: r.data.folder };
}

describe('folders: read only', () => {
  it('indexes what’s in a chosen folder, and finds words inside files', async () => {
    const { c } = await withFolder();
    const list = (await c.get('/api/files/list')).data.files.map((f: any) => f.rel_path).sort();
    expect(list).toEqual(['Copy of Price list.txt', 'Loose a.md', 'Loose b.md', 'Loose c.md', 'Price list.txt', 'Stock/October stock.csv', 'notes.md', 'scan-receipt.jpg']);
    expect(list).not.toContain('link-to-outside.txt'); // a link out of the folder is ignored
    const hits = (await c.get('/api/files/search?q=Abacus')).data.results;
    expect(hits.map((h: any) => h.rel_path)).toEqual(['notes.md']);
    const gloves = (await c.get('/api/files/search?q=Gloves')).data.results;
    expect(gloves[0].rel_path).toBe('Stock/October stock.csv');
    const scan = (await c.get('/api/files/list?q=scan')).data.files[0];
    expect(scan).toMatchObject({ kind: 'image', text_chars: 0 });
  });

  it('finds duplicates and suggests tidying up', async () => {
    const { c } = await withFolder();
    const dups = (await c.get('/api/files/duplicates')).data.groups;
    expect(dups).toHaveLength(1);
    expect(dups[0].files.map((f: any) => f.rel_path).sort()).toEqual(['Copy of Price list.txt', 'Price list.txt']);
    const s = (await c.get('/api/files/suggestions')).data.suggestions;
    expect(s.map((x: any) => x.title)).toEqual(expect.arrayContaining([expect.stringMatching(/^Delete 1 extra copy of/), 'Move 3 notes into Notes/2025']));
  });

  it('never reads outside the folder', async () => {
    expect(() => safeRel('../outside/secret.txt')).toThrow();
    expect(() => safeRel('C:/Windows/system.ini')).toThrow();
    expect(() => safeRel('/etc/passwd')).toThrow();
    const fs = ctx.services.localFs!;
    await expect(fs.read(root, 'link-to-outside.txt', 1000)).rejects.toThrow(/outside the folder/);
    await expect(fs.read(root, '../' + outside.split('/').pop() + '/secret.txt', 1000)).rejects.toThrow();
  });

  it('notices new, changed and removed files on the next scan', async () => {
    const { c, folder } = await withFolder();
    writeFileSync(join(root, 'new.txt'), 'A brand new file about insurance');
    rmSync(join(root, 'notes.md'));
    const r = (await c.post(`/api/files/folders/${folder.id}/scan`, {})).data;
    expect(r.read).toBe(1);
    expect((await c.get('/api/files/search?q=insurance')).data.results[0].rel_path).toBe('new.txt');
    expect((await c.get('/api/files/search?q=Abacus')).data.results).toEqual([]);
  });

  it('removing the folder forgets everything about it', async () => {
    const { c, folder } = await withFolder();
    await c.del(`/api/files/folders/${folder.id}`);
    expect((await c.get('/api/files/list')).data.files).toEqual([]);
    expect((await c.get('/api/files/search?q=Abacus')).data.results).toEqual([]);
    expect(existsSync(join(root, 'notes.md'))).toBe(true); // the files themselves are untouched
  });

  it('is private to its owner', async () => {
    const { folder } = await withFolder();
    const other = await signup(ctx, 'Other');
    expect((await other.get('/api/files/list')).data.files).toEqual([]);
    expect((await other.post(`/api/files/folders/${folder.id}/scan`, {})).status).toBe(404);
    expect((await other.del(`/api/files/folders/${folder.id}`)).status).toBe(404);
  });
});

describe('changes: preview, approval, undo', () => {
  it('nothing changes in a read-only folder, even when asked', async () => {
    const { c, folder } = await withFolder();
    const r = await c.post('/api/files/changes', { ops: [{ op: 'delete', grant_id: folder.id, path: 'Copy of Price list.txt' }] });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('aren’t allowed');
    expect(existsSync(join(root, 'Copy of Price list.txt'))).toBe(true);
  });

  it('a change waits for approval, then happens, and can be undone', async () => {
    const { c, folder } = await withFolder();
    await c.patch(`/api/files/folders/${folder.id}`, { can_change: true });
    const s = (await c.get('/api/files/suggestions')).data.suggestions.find((x: any) => x.title.startsWith('Delete'));
    const tidy = (await c.get('/api/files/suggestions')).data.suggestions.find((x: any) => x.title === 'Move 3 notes into Notes/2025');
    const del = (await c.post('/api/files/changes', { ops: s.ops })).data;
    expect(del.status).toBe('pending_approval');
    expect(existsSync(join(root, 'Copy of Price list.txt'))).toBe(true); // not yet
    const action = (await c.get('/api/actions?status=pending')).data.actions[0];
    expect(action.summary).toContain('Delete Copy of Price list.txt (a copy is kept to undo)');
    await approveAction(ctx.services, c.user.id, del.actionId);
    expect(existsSync(join(root, 'Copy of Price list.txt'))).toBe(false);
    expect(existsSync(join(root, 'Price list.txt'))).toBe(true);

    const mv = (await c.post('/api/files/changes', { ops: tidy.ops })).data;
    await approveAction(ctx.services, c.user.id, mv.actionId);
    expect(existsSync(join(root, 'Notes/2025/Loose a.md'))).toBe(true);
    expect(existsSync(join(root, 'Loose a.md'))).toBe(false);

    const hist = (await c.get('/api/files/history')).data.history;
    expect(hist.map((h: any) => h.op).sort()).toEqual(['delete', 'move', 'move', 'move']);
    // Undo: the delete comes back from its checked copy, a move goes back.
    const d = hist.find((h: any) => h.op === 'delete');
    expect((await c.post(`/api/files/history/${d.id}/undo`, {})).status).toBe(200);
    expect(readFileSync(join(root, 'Copy of Price list.txt'), 'utf8')).toBe('Paracetamol: UGX 2,000\nAmoxicillin: UGX 5,500');
    const m = hist.find((h: any) => h.from_rel === 'Loose a.md');
    await c.post(`/api/files/history/${m.id}/undo`, {});
    expect(existsSync(join(root, 'Loose a.md'))).toBe(true);
    expect((await c.post(`/api/files/history/${m.id}/undo`, {})).status).toBe(400); // only once
  });

  it('a file that changed after the preview is left alone', async () => {
    const { c, folder } = await withFolder();
    await c.patch(`/api/files/folders/${folder.id}`, { can_change: true });
    const res = (await c.post('/api/files/changes', { ops: [{ op: 'delete', grant_id: folder.id, path: 'notes.md' }] })).data;
    writeFileSync(join(root, 'notes.md'), '# Supplier\nChanged after the preview.');
    const done: any = await approveAction(ctx.services, c.user.id, res.actionId);
    expect(done.result.failed[0].error).toContain('changed since the preview');
    expect(existsSync(join(root, 'notes.md'))).toBe(true);
  });

  it('the assistant can search and read, but changing files always asks first', async () => {
    const { c, folder } = await withFolder();
    await c.patch(`/api/files/folders/${folder.id}`, { can_change: true });
    ctx.provider.steps.push(
      () => toolCall('search_local_files', { query: 'Amoxicillin' }),
      (req) => {
        const r = JSON.parse((req.messages.at(-1)!.content[0] as any).content);
        return toolCall('read_local_file', { file_id: r.results[0].file_id });
      },
      () => toolCall('change_local_files', { ops: [{ op: 'delete', grant_id: folder.id, path: 'Copy of Price list.txt' }] }),
      () => text('Amoxicillin is UGX 5,500. I’ve asked to delete the duplicate; approve it if you agree.'),
    );
    const conv = (await c.post('/api/conversations', {})).data;
    await c.post(`/api/conversations/${conv.id}/messages`, { text: 'how much is amoxicillin? and remove the duplicate price list' });
    expect(JSON.stringify(ctx.provider.calls[2].messages.at(-1))).toContain('Amoxicillin: UGX 5,500');
    expect(JSON.stringify(ctx.provider.calls[3].messages.at(-1))).toContain('pending_approval');
    expect(existsSync(join(root, 'Copy of Price list.txt'))).toBe(true);
  });
});
