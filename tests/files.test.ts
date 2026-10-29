import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { setup, signup, type TestCtx } from './helpers.ts';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Document, Packer, Paragraph } from 'docx';

// Test fixtures: a one-page PDF and a one-paragraph Word file.
async function makePdf(text: string) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  page.drawText(text, { x: 50, y: 700, size: 12, font: await pdf.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await pdf.save());
}
const makeDocx = (text: string) => Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(text)] }] }));

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

const fileForm = (name: string, content: BlobPart | Buffer, extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.append('file', new File([content as BlobPart], name));
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  return f;
};

describe('document upload and processing', () => {
  it('uploads text, makes it searchable with source locations, and downloads the original', async () => {
    const c = await signup(ctx);
    const r = await c.req('POST', '/api/documents', fileForm('policy.md', '# Returns policy\n\nCustomers may return unopened medicine within 7 days.'));
    expect(r.status).toBe(201);
    const doc = r.data.document;
    expect(doc.kind).toBe('markdown');
    const hits = (await c.get('/api/search?q=unopened medicine')).data.results;
    expect(hits[0]).toMatchObject({ entity: 'document', id: doc.id, title: 'policy.md' });
    const dl = await c.get(`/api/documents/${doc.id}/download`);
    expect(dl.headers.get('content-type')).toBe('application/octet-stream');
    expect(dl.headers.get('content-disposition')).toMatch(/attachment; filename="policy.md"/);
    expect(Buffer.from(dl.data).toString()).toContain('Returns policy');
  });

  it('reads text from PDF and DOCX attachments, with page markers', async () => {
    const c = await signup(ctx);
    const pdf = await makePdf('Paracetamol stock is low. Reorder by Friday.');
    const p = (await c.req('POST', '/api/documents', fileForm('report.pdf', pdf))).data.document;
    expect(p.kind).toBe('pdf');
    const detail = (await c.get(`/api/documents/${p.id}`)).data;
    expect(detail.chunks[0].locator).toBe('page 1');
    expect(detail.chunks[0].text).toContain('Paracetamol stock is low');
    const docx = await makeDocx('The board approved the new pharmacy branch.');
    const d = (await c.req('POST', '/api/documents', fileForm('minutes.docx', docx))).data.document;
    expect((await c.get(`/api/documents/${d.id}`)).data.chunks[0].text).toContain('approved the new pharmacy branch');
  });

  it('rejects unsupported, disguised, empty and oversized files', async () => {
    const c = await signup(ctx);
    const exe = await c.req('POST', '/api/documents', fileForm('virus.exe', 'MZ\x90\x00'));
    expect(exe.status).toBe(400);
    expect(exe.data.error).toMatch(/Unsupported file type/);
    const fakePdf = await c.req('POST', '/api/documents', fileForm('report.pdf', 'just text'));
    expect(fakePdf.status).toBe(400);
    const fakeXlsx = await c.req('POST', '/api/documents', fileForm('sheet.xlsx', 'not a zip'));
    expect(fakeXlsx.status).toBe(400);
    const binaryTxt = await c.req('POST', '/api/documents', fileForm('notes.txt', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])));
    expect(binaryTxt.status).toBe(400);
    expect((await c.req('POST', '/api/documents', fileForm('empty.txt', ''))).status).toBe(400);
    const small = setup({ env: { MAX_UPLOAD_MB: '1' } });
    try {
      const s = await signup(small);
      const big = await s.req('POST', '/api/documents', fileForm('big.txt', 'a'.repeat(1.5 * 1024 * 1024)));
      expect(big.status).toBe(400);
      expect(big.data.error).toMatch(/too large/);
    } finally {
      small.cleanup();
    }
  });

  it('allows uploads up to 100 MB by default', async () => {
    const c = await signup(ctx);
    expect((await c.get('/api/documents/supported')).data.maxMb).toBe(100);
    const line = 'Stock count for the Kampala branch was checked and recorded today.\n';
    const body = line.repeat(Math.ceil((10 * 1024 * 1024) / line.length)).slice(0, 10 * 1024 * 1024);
    const r = await c.req('POST', '/api/documents', fileForm('stock-log.txt', body));
    expect(r.status).toBe(201);
    expect(r.data.document.size).toBe(10 * 1024 * 1024);
  }, 60_000);

  it('sanitises file names to prevent path tricks', async () => {
    const c = await signup(ctx);
    const r = await c.req('POST', '/api/documents', fileForm('../../etc/passwd.txt', 'hello'));
    expect(r.status).toBe(201);
    expect(r.data.document.filename).not.toContain('/');
    expect(r.data.document.filename).not.toMatch(/^\./);
  });

  it('deletes the stored file and its index entries', async () => {
    const c = await signup(ctx);
    const doc = (await c.req('POST', '/api/documents', fileForm('temp.txt', 'ephemeral kangaroo content'))).data.document;
    const path = ctx.services.db.get('SELECT storage_path FROM documents WHERE id = ?', doc.id)!.storage_path;
    expect(existsSync(path)).toBe(true);
    await c.del(`/api/documents/${doc.id}`);
    expect(existsSync(path)).toBe(false);
    expect((await c.get('/api/search?q=kangaroo')).data.results).toHaveLength(0);
  });
});
