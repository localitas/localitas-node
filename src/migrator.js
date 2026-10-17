/**
 * Embedded-style SQL migration runner — mirrors the Go client's migrator.go.
 *
 * Loads `.sql` files from a directory, tracks applied versions in a
 * `schema_migrations` table, and applies pending migrations idempotently.
 * Run at app startup and from your `POST /migrations/run` endpoint.
 *
 * Filenames must match `YYYYMMDD-HHMMSS-MMM-description.sql`
 * (or legacy `NNN_description.sql`).
 */

const fs = require('fs');
const path = require('path');

const TIMESTAMP_RE = /^(\d{8})-(\d{6})-(\d{3})-(.+)\.sql$/;
const LEGACY_RE = /^(\d+)_(.+)\.sql$/;

class Migrator {
  /**
   * @param {string} migrationsDir - directory of .sql files
   * @param {(sql: string, ...args) => Promise<any>} execSql - e.g. (s,...a) => client.sqlExec(dbId, s, ...a)
   * @param {(sql: string, ...args) => Promise<any>} querySql - e.g. (s,...a) => client.sqlQuery(dbId, s, ...a)
   * @param {(stmts: {sql: string, args: any[]}[]) => Promise<any>} execTx - applies the statements as one
   *   transaction, e.g. (stmts) => client.sqlTransaction(dbId, stmts)
   */
  constructor(migrationsDir, execSql, querySql, execTx) {
    this._exec = execSql;
    this._query = querySql;
    this._execTx = execTx;
    this._migrations = loadMigrations(migrationsDir);
  }

  /** Apply every pending migration. Each is one transaction that records its
   *  version before its statements, so it applies whole or not at all, and of
   *  several instances migrating at once exactly one applies it: the others'
   *  transactions fail on the version's primary key. */
  async run() {
    await this._exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      'version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)'
    );

    const result = await this._query('SELECT version FROM schema_migrations');
    const applied = new Set((result?.rows || []).map((r) => r[0]));

    for (const m of this._migrations) {
      if (applied.has(m.version)) continue;
      try {
        await this._apply(m);
      } catch (err) {
        if (isVersionTaken(err)) continue;
        if (!isIdempotentError(err)) throw err;
        // The schema change is in place without its version row (a database
        // migrated before migrations were atomic).
        await this._repair(m);
      }
    }
  }

  async _apply(m) {
    await this._execTx([
      {
        sql: 'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        args: [m.version, m.name, Math.floor(Date.now() / 1000)],
      },
      ...splitSql(m.sql).map((sql) => ({ sql, args: [] })),
    ]);
  }

  async _repair(m) {
    for (const stmt of splitSql(m.sql)) {
      try {
        await this._exec(stmt);
      } catch (err) {
        if (!isIdempotentError(err)) throw err;
      }
    }
    await this._exec(
      'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      m.version, m.name, Math.floor(Date.now() / 1000)
    );
  }
}

function isVersionTaken(err) {
  return String(err && err.message ? err.message : err).includes('UNIQUE constraint failed: schema_migrations.version');
}

function loadMigrations(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const migrations = files.map((fname) => {
    const { version, name } = parseFilename(fname);
    return { version, name, sql: fs.readFileSync(path.join(dir, fname), 'utf8') };
  });
  migrations.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  return migrations;
}

function parseFilename(fname) {
  let m = TIMESTAMP_RE.exec(fname);
  if (m) return { version: `${m[1]}-${m[2]}-${m[3]}`, name: m[4] };
  m = LEGACY_RE.exec(fname);
  if (m) return { version: m[1], name: m[2] };
  throw new Error(`migration filename ${fname} must match YYYYMMDD-HHMMSS-MMM-name.sql or NNN_name.sql`);
}

/** Split SQL into statements on top-level semicolons, respecting string
 *  literals, line comments, and BEGIN/END blocks (triggers). */
function splitSql(raw) {
  const stmts = [];
  let buf = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw[i];
    if (inString) {
      buf += ch;
      if (ch === stringChar) {
        if (i + 1 < n && raw[i + 1] === stringChar) {
          buf += raw[i + 1];
          i += 1;
        } else {
          inString = false;
        }
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '-' && i + 1 < n && raw[i + 1] === '-') {
      while (i < n && raw[i] !== '\n') i += 1;
      buf += '\n';
      continue;
    }
    const upper = raw.slice(i).toUpperCase();
    if (upper.startsWith('BEGIN') && (i + 5 >= n || !isIdent(raw[i + 5]))) depth += 1;
    if (upper.startsWith('END') && (i + 3 >= n || !isIdent(raw[i + 3])) && depth > 0) depth -= 1;
    if (ch === ';' && depth === 0) {
      const s = buf.trim();
      if (s) stmts.push(s);
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  const tail = buf.trim();
  if (tail) stmts.push(tail);
  return stmts;
}

function isIdent(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

function isIdempotentError(err) {
  const s = String(err && err.message ? err.message : err);
  return (
    s.includes('duplicate column name') ||
    (s.includes('table') && s.includes('already exists')) ||
    (s.includes('index') && s.includes('already exists'))
  );
}

module.exports = { Migrator, splitSql, parseFilename };
