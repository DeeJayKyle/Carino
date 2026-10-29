// Browser stand-in for node:sqlite's DatabaseSync, backed by the official SQLite WebAssembly
// build (with FTS5). The database lives in memory; mobile/engine.ts saves snapshots of it.
let sqlite3: any = null;
let nextBytes: Uint8Array | null = null;
let onWrite: () => void = () => {};

/** Called by the engine before the server code opens its database. */
export function configureSqlite(mod: any, opts: { initial?: Uint8Array | null; onWrite?: () => void }) {
  sqlite3 = mod;
  nextBytes = opts.initial ?? null;
  if (opts.onWrite) onWrite = opts.onWrite;
}

export type SQLInputValue = null | number | bigint | string | Uint8Array;

class StatementSync {
  private db: DatabaseSync;
  private sql: string;
  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  private use<T>(params: SQLInputValue[], fn: (stmt: any) => T): T {
    const stmt = this.db._stmt(this.sql);
    try {
      if (params.length) stmt.bind(params.map((p) => (typeof p === 'boolean' ? Number(p) : p)));
      return fn(stmt);
    } finally {
      stmt.reset(true);
    }
  }
  get(...params: SQLInputValue[]) {
    return this.use(params, (s) => (s.step() ? s.get({}) : undefined));
  }
  all(...params: SQLInputValue[]) {
    return this.use(params, (s) => {
      const rows: any[] = [];
      while (s.step()) rows.push(s.get({}));
      return rows;
    });
  }
  run(...params: SQLInputValue[]) {
    const raw = this.db._raw;
    this.use(params, (s) => {
      while (s.step()) { /* drain RETURNING rows */ }
    });
    onWrite();
    return { changes: raw.changes(), lastInsertRowid: Number(sqlite3.capi.sqlite3_last_insert_rowid(raw.pointer)) };
  }
}

export class DatabaseSync {
  _raw: any;
  private cache = new Map<string, any>();

  constructor(_path: string) {
    if (!sqlite3) throw new Error('SQLite is not ready');
    this._raw = new sqlite3.oo1.DB(':memory:', 'c');
    if (nextBytes?.length) {
      const bytes = nextBytes;
      const p = sqlite3.wasm.allocFromTypedArray(bytes);
      const { capi } = sqlite3;
      const rc = capi.sqlite3_deserialize(this._raw.pointer, 'main', p, bytes.length, bytes.length,
        capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
      this._raw.checkRc(rc);
    }
    nextBytes = null;
  }

  _stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this._raw.prepare(sql);
      if (this.cache.size > 300) {
        for (const old of this.cache.values()) old.finalize();
        this.cache.clear();
      }
      this.cache.set(sql, s);
    }
    return s;
  }

  get isTransaction() {
    return !sqlite3.capi.sqlite3_get_autocommit(this._raw.pointer);
  }

  exec(sql: string) {
    this._raw.exec(sql);
    onWrite();
  }

  prepare(sql: string) {
    return new StatementSync(this, sql);
  }

  /** The whole database as bytes, for saving. */
  serialize(): Uint8Array {
    return sqlite3.capi.sqlite3_js_db_export(this._raw.pointer);
  }

  close() {
    for (const s of this.cache.values()) s.finalize();
    this.cache.clear();
    this._raw.close();
  }
}
