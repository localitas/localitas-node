const { Database } = require('../src/dbapi');
const http = require('http');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

let server;
let baseUrl;

const routes = {
  'POST /apps/data/api/databases/testdb/query': (req, body) => {
    if (body.sql === 'SELECT * FROM users WHERE age > ?') {
      return [200, {
        columns: ['id', 'name', 'age'],
        rows: [[2, 'Bob', 30], [3, 'Charlie', 35]],
      }];
    }
    if (body.sql === 'SELECT * FROM users WHERE id = ?') {
      return [200, {
        columns: ['id', 'name', 'age'],
        rows: [[1, 'Alice', 25]],
      }];
    }
    if (body.sql === 'SELECT * FROM empty') {
      return [200, { columns: ['id'], rows: [] }];
    }
    if (body.sql.startsWith('PRAGMA')) {
      return [200, { columns: ['journal_mode'], rows: [['wal']] }];
    }
    return [200, { columns: [], rows: [] }];
  },
  'POST /apps/data/api/databases/testdb/exec': (req, body) => {
    if (body.statements) {
      return [200, { rows_affected: body.statements.length }];
    }
    return [200, { rows_affected: 1, last_insert_id: 42 }];
  },
};

before(() => {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key];

      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : null;
        if (handler) {
          const [status, data] = handler(req, parsed);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(data !== null ? JSON.stringify(data) : '');
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end('{"error":"not found"}');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
});

describe('Database', () => {
  it('constructs with dbId, host, and token', () => {
    const db = new Database('mydb', { host: 'localhost:9090', token: 'lt_abc' });
    assert.strictEqual(db._dbId, 'mydb');
    assert.ok(db._client);
    db.close();
  });

  it('prepare returns a Statement', () => {
    const db = new Database('mydb', { host: baseUrl });
    const stmt = db.prepare('SELECT 1');
    assert.strictEqual(stmt._sql, 'SELECT 1');
    db.close();
  });
});

describe('Statement.all', () => {
  it('returns array of row objects', async () => {
    const db = new Database('testdb', { host: baseUrl });
    const users = await db.prepare('SELECT * FROM users WHERE age > ?').all(25);
    assert.strictEqual(users.length, 2);
    assert.strictEqual(users[0].id, 2);
    assert.strictEqual(users[0].name, 'Bob');
    assert.strictEqual(users[0].age, 30);
    assert.strictEqual(users[1].name, 'Charlie');
    db.close();
  });
});

describe('Statement.get', () => {
  it('returns first row as object', async () => {
    const db = new Database('testdb', { host: baseUrl });
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(1);
    assert.strictEqual(user.id, 1);
    assert.strictEqual(user.name, 'Alice');
    assert.strictEqual(user.age, 25);
    db.close();
  });

  it('returns undefined for empty result', async () => {
    const db = new Database('testdb', { host: baseUrl });
    const row = await db.prepare('SELECT * FROM empty').get();
    assert.strictEqual(row, undefined);
    db.close();
  });
});

describe('Statement.run', () => {
  it('returns changes and lastInsertRowid', async () => {
    const db = new Database('testdb', { host: baseUrl });
    const result = await db.prepare('INSERT INTO users (name, age) VALUES (?, ?)').run('Alice', 30);
    assert.strictEqual(result.changes, 1);
    assert.strictEqual(result.lastInsertRowid, 42);
    db.close();
  });
});

describe('Statement.columns', () => {
  it('returns column info after query', async () => {
    const db = new Database('testdb', { host: baseUrl });
    const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
    await stmt.get(1);
    const cols = stmt.columns();
    assert.strictEqual(cols.length, 3);
    assert.strictEqual(cols[0].name, 'id');
    assert.strictEqual(cols[1].name, 'name');
    assert.strictEqual(cols[2].name, 'age');
    db.close();
  });

  it('returns empty array before any query', () => {
    const db = new Database('testdb', { host: baseUrl });
    const stmt = db.prepare('SELECT 1');
    assert.deepStrictEqual(stmt.columns(), []);
    db.close();
  });
});

describe('Database.transaction', () => {
  it('accumulates statements and sends via sqlTransaction', async () => {
    const db = new Database('testdb', { host: baseUrl });
    const insertMany = db.transaction((users) => {
      const stmt = db.prepare('INSERT INTO users (name) VALUES (?)');
      for (const u of users) stmt.run(u.name);
    });
    const result = await insertMany([{ name: 'Bob' }, { name: 'Charlie' }]);
    assert.strictEqual(result.rows_affected, 2);
    db.close();
  });
});

describe('Database.pragma', () => {
  it('queries a pragma', async () => {
    const db = new Database('testdb', { host: baseUrl });
    const result = await db.pragma('journal_mode');
    assert.strictEqual(result.columns[0], 'journal_mode');
    assert.strictEqual(result.rows[0][0], 'wal');
    db.close();
  });
});
