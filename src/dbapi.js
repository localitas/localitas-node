const { LocalitasClient } = require('./index');

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
    const result = await this._db._client.sqlExec(this._db._dbId, this._sql, ...params);
    return {
      changes: result.rows_affected || 0,
      lastInsertRowid: result.last_insert_id || 0,
    };
  }

  async get(...params) {
    const result = await this._db._client.sqlQuery(this._db._dbId, this._sql, ...params);
    this._lastColumns = result.columns || null;
    const objects = rowsToObjects(result.columns, result.rows);
    return objects.length > 0 ? objects[0] : undefined;
  }

  async all(...params) {
    const result = await this._db._client.sqlQuery(this._db._dbId, this._sql, ...params);
    this._lastColumns = result.columns || null;
    return rowsToObjects(result.columns, result.rows);
  }

  columns() {
    if (!this._lastColumns) return [];
    return this._lastColumns.map(name => ({ name }));
  }
}

class Database {
  constructor(dbId, opts = {}) {
    const host = opts.host || 'localhost:8080';
    const token = opts.token || '';
    const protocol = host.startsWith('https') ? '' : 'http://';
    const baseUrl = host.includes('://') ? host : `${protocol}${host}`;
    this._dbId = dbId;
    this._client = new LocalitasClient(baseUrl, token);
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async exec(sql) {
    return this._client.sqlExec(this._dbId, sql);
  }

  async pragma(sql) {
    return this._client.sqlQuery(this._dbId, `PRAGMA ${sql}`);
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
      return db._client.sqlTransaction(db._dbId, statements);
    };
  }

  close() {
    this._client = null;
  }
}

module.exports = { Database, Statement };
