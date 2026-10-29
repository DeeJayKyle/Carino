import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export type Row = Record<string, any>;

/** Thin wrapper around node:sqlite with the handful of helpers the routes need. */
export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string, migrationsDir = MIGRATIONS_DIR) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate(migrationsDir);
  }

  private migrate(MIGRATIONS_DIR: string) {
    this.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    const applied = new Set(this.all('SELECT name FROM schema_migrations').map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      this.tx(() => {
        this.raw.exec(sql);
        this.run('INSERT INTO schema_migrations (name) VALUES (?)', file);
      });
    }
  }

  get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.raw.prepare(sql).get(...params) as Row | undefined;
  }

  all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.raw.prepare(sql).all(...params) as Row[];
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params);
  }

  /** Runs fn inside a transaction; nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.raw.isTransaction) return fn();
    this.raw.exec('BEGIN');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  /** Inserts a row and returns it. `id` is generated when absent. */
  insert(table: string, values: Record<string, SQLInputValue | undefined>): Row {
    const row: Record<string, SQLInputValue> = { id: randomUUID() };
    for (const [k, v] of Object.entries(values)) if (v !== undefined) row[k] = v;
    const cols = Object.keys(row);
    assertIdentifiers(table, cols);
    this.run(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map((c) => row[c]),
    );
    return this.get(`SELECT * FROM ${table} WHERE id = ?`, row.id as string)!;
  }

  /** Updates a user-owned row. Returns the updated row, or undefined when not found for this user. */
  updateOwned(table: string, userId: string, id: string, values: Record<string, SQLInputValue | undefined>, touch = true): Row | undefined {
    const entries = Object.entries(values).filter(([, v]) => v !== undefined) as [string, SQLInputValue][];
    if (touch && hasColumn(this, table, 'updated_at')) entries.push(['updated_at', nowIso()]);
    if (entries.length === 0) return this.getOwned(table, userId, id);
    assertIdentifiers(table, entries.map(([k]) => k));
    const res = this.run(
      `UPDATE ${table} SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ? AND user_id = ?`,
      ...entries.map(([, v]) => v), id, userId,
    );
    if (Number(res.changes) === 0) return undefined;
    return this.getOwned(table, userId, id);
  }

  getOwned(table: string, userId: string, id: string): Row | undefined {
    assertIdentifiers(table, []);
    return this.get(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`, id, userId);
  }

  deleteOwned(table: string, userId: string, id: string): boolean {
    assertIdentifiers(table, []);
    return Number(this.run(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`, id, userId).changes) > 0;
  }

  close() {
    this.raw.close();
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function assertIdentifiers(table: string, cols: string[]) {
  if (!IDENT.test(table) || cols.some((c) => !IDENT.test(c))) throw new Error('Invalid identifier');
}

const columnCache = new WeakMap<Db, Map<string, Set<string>>>();
function hasColumn(db: Db, table: string, col: string) {
  let byTable = columnCache.get(db);
  if (!byTable) columnCache.set(db, (byTable = new Map()));
  let cols = byTable.get(table);
  if (!cols) {
    cols = new Set(db.all(`PRAGMA table_info(${table})`).map((r) => r.name as string));
    byTable.set(table, cols);
  }
  return cols.has(col);
}

export function nowIso() {
  return new Date().toISOString();
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
