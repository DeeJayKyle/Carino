import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import mammoth from 'mammoth';
import type { Db, Row } from '../db/index.ts';
import { addToIndex } from './indexer.ts';
import { parseCsv, parseXlsx, sheetToText, type Sheet } from './spreadsheet.ts';
import { badRequest, notFound } from '../context.ts';

export type DocKind = 'pdf' | 'text' | 'markdown' | 'docx' | 'csv' | 'xlsx' | 'image';

/** Vision models accept images up to 5 MB; the app shrinks larger photos before uploading. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The formats Carino can actually process. Anything else is rejected. */
export const SUPPORTED: Record<string, { kind: DocKind; mime: string }> = {
  '.pdf': { kind: 'pdf', mime: 'application/pdf' },
  '.txt': { kind: 'text', mime: 'text/plain' },
  '.md': { kind: 'markdown', mime: 'text/markdown' },
  '.markdown': { kind: 'markdown', mime: 'text/markdown' },
  '.docx': { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.csv': { kind: 'csv', mime: 'text/csv' },
  '.xlsx': { kind: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.gif': { kind: 'image', mime: 'image/gif' },
};

/** Image type from its leading bytes, so a renamed file can't pass as another kind. */
function imageMime(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Checks the extension and the file's actual leading bytes agree. */
export function detectKind(filename: string, buf: Buffer): { kind: DocKind; mime: string } {
  const ext = extname(filename).toLowerCase();
  const spec = SUPPORTED[ext];
  if (!spec) throw badRequest(`Unsupported file type "${ext || 'none'}". Supported: PDF, TXT, MD, DOCX, CSV, XLSX, and images (JPG, PNG, WebP, GIF).`);
  const head = buf.subarray(0, 8);
  const isPdf = head.subarray(0, 5).toString('latin1') === '%PDF-';
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (spec.kind === 'pdf' && !isPdf) throw badRequest('This file is not a valid PDF.');
  if ((spec.kind === 'docx' || spec.kind === 'xlsx') && !isZip) throw badRequest(`This file is not a valid ${ext.slice(1).toUpperCase()} document.`);
  if (spec.kind === 'image') {
    const mime = imageMime(buf);
    if (!mime) throw badRequest('This file is not a valid JPG, PNG, WebP or GIF image.');
    if (buf.length > MAX_IMAGE_BYTES) throw badRequest('Images can be up to 5 MB. Attach it from the Carino app, which shrinks large photos automatically, or resize it first.');
    return { kind: 'image', mime };
  }
  if (['text', 'markdown', 'csv'].includes(spec.kind)) {
    if (isPdf || isZip || buf.subarray(0, 4096).includes(0)) throw badRequest('This file does not look like plain text.');
  }
  return spec;
}

export function safeFilename(name: string) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 180) || 'file';
}

export interface Extracted {
  chunks: { locator: string; text: string }[];
  sheets?: Sheet[];
  totalChars: number;
}

const CHUNK = 1500;

function chunkText(text: string, locator: string): { locator: string; text: string }[] {
  const out: { locator: string; text: string }[] = [];
  const paras = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > CHUNK && cur) {
      out.push({ locator, text: cur.trim() });
      cur = '';
    }
    if (p.length > CHUNK) {
      for (let i = 0; i < p.length; i += CHUNK) out.push({ locator, text: p.slice(i, i + CHUNK).trim() });
    } else cur += (cur ? '\n\n' : '') + p;
  }
  if (cur.trim()) out.push({ locator, text: cur.trim() });
  return out.filter((c) => c.text);
}

export async function extract(kind: DocKind, buf: Buffer): Promise<Extracted> {
  let chunks: { locator: string; text: string }[] = [];
  let sheets: Sheet[] | undefined;
  switch (kind) {
    case 'pdf': {
      const { getDocumentProxy, extractText } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: false });
      (text as string[]).forEach((pageText, i) => chunks.push(...chunkText(pageText, `page ${i + 1}`)));
      if (!chunks.length) throw badRequest('No selectable text was found in this PDF (it may be a scanned image). OCR is not supported.');
      break;
    }
    case 'text':
    case 'markdown':
      chunks = chunkText(buf.toString('utf8'), '');
      break;
    case 'docx': {
      const { value } = await mammoth.extractRawText({ buffer: buf });
      chunks = chunkText(value, '');
      break;
    }
    case 'csv':
      sheets = [parseCsv(buf.toString('utf8'))];
      break;
    case 'xlsx':
      sheets = await parseXlsx(buf);
      break;
    case 'image':
      break; // stored for viewing and for vision models; there is no text to index
  }
  if (sheets) {
    for (const s of sheets) {
      for (let i = 0; i < Math.min(s.rows.length, 2000); i += 50) {
        const part = { ...s, rows: s.rows.slice(i, i + 50) };
        chunks.push({ locator: `${s.name} rows ${i + 2}-${i + 1 + part.rows.length}`, text: sheetToText(part, 50) });
      }
    }
  }
  chunks.forEach((c, i) => (c.locator = c.locator || `section ${i + 1}`));
  return { chunks, sheets, totalChars: chunks.reduce((a, c) => a + c.text.length, 0) };
}

export function uploadDir(dataDir: string, userId: string) {
  const dir = resolve(dataDir, 'uploads', userId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function storeDocument(
  db: Db,
  dataDir: string,
  userId: string,
  file: { name: string; buf: Buffer },
  meta: { project_id?: string | null; workspace_id?: string | null; folder?: string; tags?: string[] },
  maxBytes: number,
) {
  if (file.buf.length === 0) throw badRequest('The file is empty.');
  if (file.buf.length > maxBytes) throw badRequest(`File is too large. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  const filename = safeFilename(file.name);
  const spec = detectKind(filename, file.buf);
  if (meta.project_id && !db.getOwned('projects', userId, meta.project_id)) throw notFound('Project');
  const extracted = await extract(spec.kind, file.buf).catch((err) => {
    if (err?.status) throw err;
    throw badRequest(`Carino could not read this ${spec.kind.toUpperCase()} file. It may be damaged or password-protected.`);
  });
  const sha = createHash('sha256').update(file.buf).digest('hex');
  return db.tx(() => {
    const doc = db.insert('documents', {
      user_id: userId,
      filename,
      mime: spec.mime,
      kind: spec.kind,
      size: file.buf.length,
      storage_path: '',
      sha256: sha,
      text_chars: extracted.totalChars,
      project_id: meta.project_id ?? null,
      workspace_id: meta.workspace_id ?? null,
      folder: meta.folder ?? '',
      tags: JSON.stringify(meta.tags ?? []),
    });
    const path = join(uploadDir(dataDir, userId), `${doc.id}.bin`);
    writeFileSync(path, file.buf);
    db.run('UPDATE documents SET storage_path = ? WHERE id = ?', path, doc.id);
    extracted.chunks.forEach((c, seq) => {
      const chunk = db.insert('doc_chunks', { user_id: userId, document_id: doc.id, seq, locator: c.locator, text: c.text });
      addToIndex(db, userId, 'doc_chunk', chunk.id, filename, c.text, c.locator);
    });
    return { doc: db.get('SELECT * FROM documents WHERE id = ?', doc.id)!, chunks: extracted.chunks.length };
  });
}

export function readDocumentFile(doc: Row): Buffer {
  if (!doc.storage_path || !existsSync(doc.storage_path)) throw notFound('Stored file');
  return readFileSync(doc.storage_path);
}

export function deleteDocument(db: Db, userId: string, id: string) {
  const doc = db.getOwned('documents', userId, id);
  if (!doc) throw notFound('Document');
  db.tx(() => {
    // One pass over the index for all chunks; a DELETE per chunk would scan it once each.
    db.run(
      "DELETE FROM search_index WHERE entity = 'doc_chunk' AND user_id = ? AND entity_id IN (SELECT id FROM doc_chunks WHERE document_id = ?)",
      userId, id,
    );
    db.deleteOwned('documents', userId, id);
  });
  if (doc.storage_path) rmSync(doc.storage_path, { force: true });
  return { deleted: true, filename: doc.filename };
}

export async function loadSheets(doc: Row): Promise<Sheet[]> {
  if (doc.kind === 'csv') return [parseCsv(readDocumentFile(doc).toString('utf8'))];
  if (doc.kind === 'xlsx') return parseXlsx(readDocumentFile(doc));
  throw badRequest('Only CSV and XLSX files can be analysed as spreadsheets.');
}

export function documentText(db: Db, userId: string, id: string, maxChars = 120_000) {
  const chunks = db.all('SELECT seq, locator, text FROM doc_chunks WHERE document_id = ? AND user_id = ? ORDER BY seq', id, userId);
  let out = '';
  for (const c of chunks) {
    const piece = `\n[${c.locator}]\n${c.text}\n`;
    if (out.length + piece.length > maxChars) {
      out += '\n[… document truncated for length]';
      break;
    }
    out += piece;
  }
  return out;
}
