import type { Db } from '../db/index.ts';

export type Entity = 'note' | 'task' | 'memory' | 'project' | 'doc_chunk' | 'conversation' | 'message';

/** Keeps the FTS5 search index in step with the source tables. */
export function indexEntity(db: Db, userId: string, entity: Entity, id: string, title: string, body: string, locator = '') {
  db.run('DELETE FROM search_index WHERE entity = ? AND entity_id = ? AND user_id = ?', entity, id, userId);
  addToIndex(db, userId, entity, id, title, body, locator);
}

/**
 * Indexes a row that has never been indexed. The UNINDEXED filter columns make every
 * DELETE a full scan, so bulk inserts (a large document's chunks) must skip it.
 */
export function addToIndex(db: Db, userId: string, entity: Entity, id: string, title: string, body: string, locator = '') {
  db.run(
    'INSERT INTO search_index (title, body, entity, entity_id, user_id, locator) VALUES (?, ?, ?, ?, ?, ?)',
    title ?? '', body ?? '', entity, id, userId, locator,
  );
}

export function unindexEntity(db: Db, userId: string, entity: Entity, id: string) {
  db.run('DELETE FROM search_index WHERE entity = ? AND entity_id = ? AND user_id = ?', entity, id, userId);
}

export interface SearchHit {
  entity: Entity;
  id: string;
  title: string;
  snippet: string;
  locator: string;
  score: number;
}

/** Turns free text into a safe FTS5 query: quoted terms OR-ed together, prefix-matched. */
export function ftsQuery(text: string): string | null {
  const terms = (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((t) => !STOP.has(t)).slice(0, 12);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

export function searchIndex(db: Db, userId: string, text: string, opts: { entities?: Entity[]; limit?: number } = {}): SearchHit[] {
  const q = ftsQuery(text);
  if (!q) return [];
  const limit = Math.min(opts.limit ?? 20, 100);
  const entities = opts.entities?.length ? opts.entities : null;
  const rows = db.all(
    `SELECT entity, entity_id, title, locator,
            snippet(search_index, 1, '[', ']', ' … ', 18) AS snippet,
            bm25(search_index, 4.0, 1.0) AS score
       FROM search_index
      WHERE search_index MATCH ? AND user_id = ?
        ${entities ? `AND entity IN (${entities.map(() => '?').join(',')})` : ''}
      ORDER BY score LIMIT ?`,
    q, userId, ...(entities ?? []), limit,
  );
  return rows.map((r) => ({ entity: r.entity, id: r.entity_id, title: r.title, snippet: r.snippet, locator: r.locator, score: r.score }));
}

const STOP = new Set(
  'the a an and or of to in on for with at by from is are was were be been it this that these those my me i you your we our what which who how when where why do does did can could should would will just about into over than then there their them they as not no yes please carino'.split(' '),
);
