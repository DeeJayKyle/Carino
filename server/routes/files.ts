import { Hono } from 'hono';
import type { AppEnv } from '../context.ts';
import { notFound, badRequest } from '../context.ts';
import { parseJson } from '../db/index.ts';
import { storeDocument, readDocumentFile, deleteDocument, SUPPORTED } from '../services/documents.ts';
import { rateLimit } from '../middleware.ts';

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function fileRoutes() {
  const r = new Hono<AppEnv>();
  const uid = (c: any) => c.var.user.id as string;
  const db = (c: any) => c.var.services.db as AppEnv['Variables']['services']['db'];
  const uploadLimit = rateLimit({ name: 'upload', windowMs: 60_000, max: 15, key: (c) => c.var.user.id });

  r.get('/documents/supported', (c) => c.json({ extensions: Object.keys(SUPPORTED), maxMb: c.var.services.config.MAX_UPLOAD_MB }));

  r.post('/documents', uploadLimit, async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw badRequest('Attach a file in the "file" field.');
    const buf = Buffer.from(await file.arrayBuffer());
    // Files are chat attachments: photos, PDFs and documents Carino reads with you.
    const { doc, chunks } = await storeDocument(
      db(c), c.var.services.config.DATA_DIR, uid(c), { name: file.name, buf }, {}, c.var.services.config.MAX_UPLOAD_MB * 1024 * 1024,
    );
    const { storage_path, ...out } = doc;
    void storage_path;
    return c.json({ document: { ...out, key_points: [], tags: parseJson(doc.tags, []) }, chunks }, 201);
  });

  r.get('/documents/:id', (c) => {
    const d = db(c).getOwned('documents', uid(c), c.req.param('id'));
    if (!d) throw notFound('Document');
    const { storage_path, ...out } = d;
    void storage_path;
    const chunks = db(c).all('SELECT seq, locator, text FROM doc_chunks WHERE document_id = ? ORDER BY seq LIMIT 400', d.id);
    return c.json({ ...out, key_points: parseJson(d.key_points, []), tags: parseJson(d.tags, []), chunks });
  });

  r.get('/documents/:id/download', (c) => {
    const d = db(c).getOwned('documents', uid(c), c.req.param('id'));
    if (!d) throw notFound('Document');
    const buf = readDocumentFile(d);
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'application/octet-stream', // never rendered inline
      'Content-Disposition': contentDisposition(d.filename),
      'Cache-Control': 'private, no-store',
    });
  });

  /** Inline view for images only; other kinds are always downloaded, never rendered. */
  r.get('/documents/:id/preview', (c) => {
    const d = db(c).getOwned('documents', uid(c), c.req.param('id'));
    if (!d) throw notFound('Document');
    if (d.kind !== 'image') throw badRequest('Only images can be previewed.');
    return c.body(new Uint8Array(readDocumentFile(d)), 200, {
      'Content-Type': d.mime,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=3600',
    });
  });

  r.delete('/documents/:id', (c) => c.json(deleteDocument(db(c), uid(c), c.req.param('id'))));

  return r;
}
