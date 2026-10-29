import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppEnv } from '../context.ts';
import { notFound, HttpError } from '../context.ts';
import { parseJson } from '../db/index.ts';
import { runTurn, buildSystemPrompt, complete } from '../ai/agent.ts';
import { ProviderError } from '../ai/types.ts';
import { getSettings } from '../services/settings.ts';
import { saveMemory } from '../services/memory.ts';
import { unindexEntity } from '../services/indexer.ts';
import { rateLimit } from '../middleware.ts';

/** Tracks in-flight turns so the user can cancel one. */
const inflight = new Map<string, AbortController>();

export function chatRoutes() {
  const r = new Hono<AppEnv>();
  const uid = (c: any) => c.var.user.id as string;
  const db = (c: any) => c.var.services.db as AppEnv['Variables']['services']['db'];
  const chatLimit = rateLimit({ name: 'chat', windowMs: 60_000, max: 20, key: (c) => c.var.user.id });

  r.get('/conversations', (c) => {
    const { q, archived, project_id } = c.req.query();
    const where = ['c.user_id = ?', 'c.archived = ?'];
    const params: any[] = [uid(c), archived === '1' ? 1 : 0];
    if (project_id) { where.push('c.project_id = ?'); params.push(project_id); }
    if (q) {
      where.push('(c.title LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?))');
      params.push(`%${q}%`, `%${q}%`);
    }
    return c.json({
      conversations: db(c).all(
        `SELECT c.id, c.title, c.archived, c.project_id, c.workspace_id, c.updated_at, c.created_at, c.summary != '' AS has_summary,
           (SELECT substr(m.content, 1, 140) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'assistant' AND m.content != '' ORDER BY m.created_at DESC LIMIT 1) AS preview
         FROM conversations c WHERE ${where.join(' AND ')} ORDER BY c.updated_at DESC LIMIT 300`, ...params,
      ),
    });
  });

  r.post('/conversations', async (c) => {
    const i = z.object({
      title: z.string().max(200).optional(), project_id: z.string().max(64).nullable().optional(), workspace_id: z.string().max(64).nullable().optional(),
    }).parse(await c.req.json().catch(() => ({})));
    if (i.project_id && !db(c).getOwned('projects', uid(c), i.project_id)) throw notFound('Project');
    if (i.workspace_id && !db(c).getOwned('workspaces', uid(c), i.workspace_id)) throw notFound('Workspace');
    const conv = db(c).insert('conversations', {
      user_id: uid(c), title: i.title || 'New conversation', project_id: i.project_id ?? null, workspace_id: i.workspace_id ?? null,
      system_prompt: buildSystemPrompt(c.var.user, getSettings(db(c), uid(c))),
    });
    const { system_prompt, ...out } = conv;
    void system_prompt;
    return c.json(out, 201);
  });

  r.get('/conversations/:id', (c) => {
    const conv = db(c).getOwned('conversations', uid(c), c.req.param('id'));
    if (!conv) throw notFound('Conversation');
    const messages = db(c).all(
      "SELECT id, role, content, meta, created_at FROM messages WHERE conversation_id = ? AND user_id = ? AND role IN ('user','assistant') ORDER BY created_at, rowid",
      conv.id, uid(c),
    ).map((m): any => ({ ...m, meta: parseJson<any>(m.meta, {}) })).filter((m) => !m.meta.hidden && (m.role === 'user' || m.content || m.meta.tools?.length));
    const pending = db(c).all("SELECT * FROM actions WHERE conversation_id = ? AND user_id = ? AND status = 'pending' ORDER BY created_at", conv.id, uid(c))
      .map((a) => ({ ...a, input: parseJson(a.input, {}) }));
    const { system_prompt, ...rest } = conv;
    void system_prompt;
    return c.json({ conversation: { ...rest, archived: !!conv.archived }, messages, pendingActions: pending, streaming: inflight.has(conv.id) });
  });

  r.patch('/messages/:id/rating', async (c) => {
    const i = z.object({ rating: z.union([z.literal(-1), z.literal(0), z.literal(1)]) }).parse(await c.req.json());
    const r = db(c).run("UPDATE messages SET meta = json_set(COALESCE(NULLIF(meta, ''), '{}'), '$.rating', ?) WHERE id = ? AND user_id = ? AND role = 'assistant'", i.rating, c.req.param('id'), uid(c));
    if (Number(r.changes) === 0) throw notFound('Message');
    return c.json({ rating: i.rating });
  });
  r.patch('/conversations/:id', async (c) => {
    const i = z.object({
      title: z.string().trim().min(1).max(200).optional(), archived: z.boolean().optional(),
      project_id: z.string().max(64).nullable().optional(),
    }).parse(await c.req.json());
    if (i.project_id && !db(c).getOwned('projects', uid(c), i.project_id)) throw notFound('Project');
    const conv = db(c).updateOwned('conversations', uid(c), c.req.param('id'), {
      title: i.title, archived: i.archived === undefined ? undefined : i.archived ? 1 : 0, project_id: i.project_id,
    });
    if (!conv) throw notFound('Conversation');
    return c.json({ id: conv.id, title: conv.title, archived: !!conv.archived, project_id: conv.project_id });
  });

  r.delete('/conversations/:id', (c) => {
    const id = c.req.param('id');
    const msgs = db(c).all('SELECT id FROM messages WHERE conversation_id = ? AND user_id = ?', id, uid(c));
    if (!db(c).deleteOwned('conversations', uid(c), id)) throw notFound('Conversation');
    for (const m of msgs) unindexEntity(db(c), uid(c), 'message', m.id);
    return c.json({ deleted: true });
  });

  /** Sends a message and streams the reply as Server-Sent Events. */
  r.post('/conversations/:id/messages', chatLimit, async (c) => {
    const id = c.req.param('id');
    const i = z.object({
      text: z.string().trim().min(1).max(30_000),
      attachments: z.array(z.string().max(64)).max(5).optional(),
    }).parse(await c.req.json());
    if (!db(c).getOwned('conversations', uid(c), id)) throw notFound('Conversation');
    if (inflight.has(id)) throw new HttpError(409, 'Carino is still replying in this conversation.', 'busy');
    const ac = new AbortController();
    inflight.set(id, ac);
    const services = c.var.services;
    const user = c.var.user;
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => ac.abort());
      // Writes are queued and awaited before the stream closes, so no event is dropped.
      let queue: Promise<unknown> = Promise.resolve();
      const emit = (e: { type: string }) => {
        queue = queue.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })).catch(() => undefined);
      };
      try {
        await runTurn(services, user, id, i.text, { attachments: i.attachments, signal: ac.signal, emit });
      } catch (err: any) {
        const pe = err instanceof ProviderError ? err : null;
        if (!pe) console.error('[chat]', err?.message ?? err);
        emit({
          type: 'error',
          message: pe ? pe.message : err instanceof HttpError ? err.message : 'Something went wrong while generating the reply.',
          kind: pe?.kind ?? 'internal', retryable: pe?.retryable ?? true,
        } as any);
      } finally {
        await queue;
        inflight.delete(id);
      }
    });
  });

  r.post('/conversations/:id/cancel', (c) => {
    const id = c.req.param('id');
    if (!db(c).getOwned('conversations', uid(c), id)) throw notFound('Conversation');
    inflight.get(id)?.abort();
    return c.json({ cancelled: inflight.has(id) });
  });

  /** Writes a summary of the conversation and, if asked, saves it as a memory. */
  r.post('/conversations/:id/summarize', rateLimit({ name: 'summ', windowMs: 60_000, max: 6, key: (c) => c.var.user.id }), async (c) => {
    const id = c.req.param('id');
    const { save } = z.object({ save: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
    const conv = db(c).getOwned('conversations', uid(c), id);
    if (!conv) throw notFound('Conversation');
    const msgs = db(c).all("SELECT role, content FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') AND content != '' ORDER BY created_at", id);
    if (msgs.length < 2) throw new HttpError(400, 'There is not enough in this conversation to summarise yet.', 'bad_request');
    const transcript = msgs.map((m) => `${m.role === 'user' ? 'User' : 'Carino'}: ${m.content}`).join('\n\n').slice(-60_000);
    const summary = await complete(
      c.var.services, uid(c),
      'You write concise, factual summaries of conversations for a personal assistant\'s long-term memory. Include decisions, commitments, open questions and next steps. Do not add anything that was not said.',
      `Summarise this conversation in 3–8 bullet points.\n\n<transcript>\n${transcript}\n</transcript>`,
      'summary', 1500,
    );
    db(c).run('UPDATE conversations SET summary = ? WHERE id = ?', summary, id);
    let memoryId: string | null = null;
    if (save) {
      const m = saveMemory(db(c), uid(c), { content: `Conversation "${conv.title}" (${conv.created_at.slice(0, 10)}): ${summary}`.slice(0, 2000), category: 'summary', project_id: conv.project_id }, { status: 'active', source: 'conversation_summary', sourceRef: id });
      memoryId = m.memory.id;
    }
    return c.json({ summary, memoryId });
  });

  /** Exports a conversation transcript in any supported format. */
  return r;
}
