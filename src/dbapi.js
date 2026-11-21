function rowsToObjects(columns, rows) {
  if (!columns || !rows) return [];
  return rows.map(row => {
    const obj = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]] = row[i];
    }
    return obj;
  });
}

class Statement {
  constructor(db, sql) {
    this._db = db;
    this._sql = sql;
    this._lastColumns = null;
  }

  async run(...params) {
    const result = await this._db._client.sqlExec(await this._db._id(), this._sql, ...params);
    return {
      changes: result.rows_affected || 0,
      lastInsertRowid: result.last_insert_id || 0,
    };
  }

  async get(...params) {
    const result = await this._db._client.sqlQuery(await this._db._id(), this._sql, ...params);
    this._lastColumns = result.columns || null;
    const objects = rowsToObjects(result.columns, result.rows);
    return objects.length > 0 ? objects[0] : undefined;
  }

  async all(...params) {
    const result = await this._db._client.sqlQuery(await this._db._id(), this._sql, ...params);
    this._lastColumns = result.columns || null;
    return rowsToObjects(result.columns, result.rows);
  }

  columns() {
    if (!this._lastColumns) return [];
    return this._lastColumns.map(name => ({ name }));
  }
}

/**
 * A database on core, used like better-sqlite3 but async. Get one by name
 * with client.db(name); new Database(id, { host, token }) takes host from
 * the argument, else CORE_URL (or the home's core.env), and never guesses one.
 */
class Database {
  constructor(dbId, opts = {}) {
    this._dbId = dbId;
    this._name = opts.name || '';
    this._resolving = null;
    if (opts.client) {
      this._client = opts.client;
      return;
    }
    // Resolved here, not at load: index.js requires this module before it
    // has exported LocalitasClient, so a load-time import is undefined.
    const { LocalitasClient, coreUrlFromEnv } = require('./index');
    const host = opts.host || coreUrlFromEnv();
    const baseUrl = host.includes('://') ? host : `http://${host}`;
    this._client = new LocalitasClient(baseUrl, opts.token || '');
  }

  /** @private The database ID, resolved by name through core's idempotent
   *  system-database call on first use; a failure is retried on the next. */
  async _id() {
    if (this._dbId) return this._dbId;
    if (!this._resolving) {
      this._resolving = this._client.createDatabase(this._name, true).then(
        (db) => {
          this._dbId = db.id;
          return db.id;
        },
        (err) => {
          this._resolving = null;
          throw err;
        },
      );
    }
    return this._resolving;
  }

  /** The client this database is reached through. */
  get client() {
    return this._client;
  }

  /** The database's ID, resolved by name on first use (see db(name)). */
  async databaseId() {
    return this._id();
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async exec(sql) {
    return this._client.sqlExec(await this._id(), sql);
  }

  async pragma(sql) {
    return this._client.sqlQuery(await this._id(), `PRAGMA ${sql}`);
  }

  transaction(fn) {
    const db = this;
    return async function (...args) {
      const statements = [];
      const originalPrepare = db.prepare.bind(db);

      db.prepare = function (sql) {
        return {
          run(...params) {
            statements.push({ sql, args: params });
            return { changes: 0, lastInsertRowid: 0 };
          },
        };
      };

      try {
        fn(...args);
      } finally {
        db.prepare = originalPrepare;
      }

      if (statements.length === 0) return;
      return db._client.sqlTransaction(await db._id(), statements);
    };
  }

  close() {
    this._client = null;
  }
}

module.exports = { Database, Statement };
