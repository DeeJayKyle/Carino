import { z } from 'zod';
import type { ToolContext, ToolDef } from './registry.ts';
import { nowIso, parseJson } from '../db/index.ts';
import { storeDocument } from '../services/documents.ts';
import { makeDocx, makePptx } from '../services/apps/common.ts';
import * as media from '../services/media.ts';

/**
 * Things Carino makes in chat: slide decks, documents, images, videos, and web pages or small
 * apps. Files go to the user's documents, with a download link in the chat.
 */
const def = <S extends z.ZodType>(d: ToolDef<S>) => d as unknown as ToolDef;

async function saveFile(ctx: ToolContext, name: string, buf: Buffer, tags: string[]) {
  const s = ctx.services;
  const { doc } = await storeDocument(s.db, s.config.DATA_DIR, ctx.userId, { name, buf }, { tags }, Math.max(s.config.MAX_UPLOAD_MB, 60) * 1024 * 1024);
  return { document_id: doc.id, filename: doc.filename, kind: doc.kind, download_url: `/api/documents/${doc.id}/download` };
}

const slug = (s: string) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, ' ').slice(0, 60) || 'Carino';

/** A page runs on its own: no network calls out, no access to Carino. */
const PAGE_CSP = "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data: https:";

export function pageDocument(title: string, html: string) {
  const body = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title.replace(/[<&]/g, '')}</title></head><body>${html}</body></html>`;
  // The page's own policy, so it stays self-contained wherever it is opened.
  return body.replace(/<head([^>]*)>/i, `<head$1><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`);
}

export const CREATE_TOOLS: ToolDef[] = [
  def({
    name: 'make_slides',
    description: 'Make a PowerPoint slide deck (.pptx) from an outline and save it to the user\'s files, with a download link. Keep each slide to a title and a few short bullets; put detail in notes.',
    risk: 'read',
    input: z.object({
      title: z.string().min(1).max(120),
      slides: z.array(z.object({ title: z.string().min(1).max(120), bullets: z.array(z.string().max(300)).max(8).optional(), notes: z.string().max(2000).optional() })).min(1).max(40),
    }),
    summarize: (i) => `Make slides: ${i.title} (${i.slides.length + 1} slides)`,
    run: async (i, ctx) => saveFile(ctx, `${slug(i.title)}.pptx`, await makePptx(i.title, i.slides), ['made-by-carino', 'slides']),
  }),
  def({
    name: 'make_document',
    description: 'Write a Word document (.docx) — a letter, report, CV or plan — and save it to the user\'s files with a download link. Use plain paragraphs separated by blank lines; lines starting with "# " become headings.',
    risk: 'read',
    input: z.object({ title: z.string().min(1).max(120), text: z.string().min(1).max(100_000) }),
    summarize: (i) => `Write the document “${i.title}”`,
    run: async (i, ctx) => saveFile(ctx, `${slug(i.title)}.docx`, await makeDocx(i.title, i.text), ['made-by-carino']),
  }),
  def({
    name: 'generate_image',
    description: 'Create a picture from a description, using an image service the user connected (OpenAI or Google Gemini). It costs a little on their account, so it asks first. Describe the picture in detail (subject, style, colours, composition). Never make images of real people without their consent, or anything deceptive.',
    risk: 'reversible',
    askByDefault: true,
    input: z.object({
      prompt: z.string().min(3).max(3000),
      shape: z.enum(['square', 'portrait', 'landscape']).optional(),
    }),
    summarize: (i, ctx) => `Make a picture with ${media.imageServiceLabel(ctx.services)}: “${i.prompt.slice(0, 100)}${i.prompt.length > 100 ? '…' : ''}”`,
    run: async (i, ctx) => media.safe(async () => {
      const img = await media.generateImage(ctx.services, i.prompt, i.shape ?? 'square', ctx.userId);
      return { ...(await saveFile(ctx, `${slug(i.prompt.slice(0, 40))}.${img.ext}`, img.buf, ['made-by-carino', 'image'])), service: img.service };
    }),
  }),
  def({
    name: 'generate_video',
    description: 'Create a short video clip (about 8 seconds) from a description, with Google Veo or OpenAI Sora on the user\'s own account. This costs noticeably more than a picture, so it always asks first, and it takes a few minutes.',
    risk: 'consequential',
    input: z.object({ prompt: z.string().min(3).max(2000), shape: z.enum(['landscape', 'portrait']).optional() }),
    summarize: (i, ctx) => `Make a short video with ${media.videoServiceLabel(ctx.services)} (paid): “${i.prompt.slice(0, 100)}”`,
    run: async (i, ctx) => media.safe(async () => {
      const v = await media.generateVideo(ctx.services, i.prompt, i.shape ?? 'landscape', ctx.userId);
      return { ...(await saveFile(ctx, `${slug(i.prompt.slice(0, 40))}.mp4`, v.buf, ['made-by-carino', 'video'])), service: v.service };
    }),
  }),
  def({
    name: 'analyze_video',
    description: 'Watch a video the user attached and answer a question about it (what happens, what is said, steps shown), using Google Gemini on the user\'s account.',
    risk: 'read',
    input: z.object({ document_id: z.string().min(1).max(64), question: z.string().min(3).max(1000) }),
    summarize: (i) => `Watch the video: ${i.question.slice(0, 80)}`,
    run: async (i, ctx) => {
      const doc = ctx.services.db.getOwned('documents', ctx.userId, i.document_id);
      if (!doc) return { error: 'No such video.' };
      if (ctx.cloud === false) return { error: 'Watching videos needs Google Gemini, an online service, and this chat is private.' };
      return media.safe(async () => ({ answer: await media.analyzeVideo(ctx.services, doc, i.question) }));
    },
  }),
  def({
    name: 'make_page',
    description: 'Build a web page or a small interactive app (an invite, a menu, a checklist, a calculator, a quiz) as one self-contained HTML file with inline CSS and JavaScript — no outside scripts or network calls; images only as https or data links. Give page_id to change an existing one (earlier versions are kept). The user can open it in the app and share it.',
    risk: 'read',
    input: z.object({
      title: z.string().min(1).max(120),
      html: z.string().min(20).max(300_000),
      kind: z.enum(['page', 'app']).optional(),
      page_id: z.string().max(64).optional(),
    }),
    summarize: (i) => `${i.page_id ? 'Update' : 'Build'} the ${i.kind === 'app' ? 'app' : 'page'} “${i.title}”`,
    run: (i, ctx) => {
      const db = ctx.services.db;
      const html = pageDocument(i.title, i.html);
      const now = nowIso();
      if (i.page_id) {
        const p = db.getOwned('pages', ctx.userId, i.page_id);
        if (!p) return { error: 'No such page.' };
        const history = [...parseJson<any[]>(p.history, []), { version: p.version, html: p.html, at: p.updated_at }].slice(-10);
        db.run('UPDATE pages SET title = ?, html = ?, kind = ?, version = version + 1, history = ?, updated_at = ? WHERE id = ?', i.title, html, i.kind ?? p.kind, JSON.stringify(history), now, p.id);
        return { page_id: p.id, version: Number(p.version) + 1, open_at: `/pages/${p.id}` };
      }
      const p = db.insert('pages', { user_id: ctx.userId, conversation_id: ctx.conversationId, title: i.title, kind: i.kind ?? 'page', html, created_at: now, updated_at: now });
      return { page_id: p.id, version: 1, open_at: `/pages/${p.id}` };
    },
  }),
];
