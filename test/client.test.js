const { LocalitasClient, APIError } = require('../src/index');
const http = require('http');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

let server;
let baseUrl;
let capturedAuth = null;

const routes = {
  'GET /apps/data/api/databases': (req, body) => {
    capturedAuth = req.headers.authorization;
    return [200, [{ id: 'db1', name: 'mydb' }]];
  },
  'POST /apps/data/api/databases': (req, body) => {
    return [200, { id: 'db2', name: body.name, system: body.system || false }];
  },
  'GET /apps/data/api/databases/db1': () => [200, { id: 'db1', name: 'mydb' }],
  'DELETE /apps/data/api/databases/db1': () => [200, null],
  'POST /apps/data/api/databases/db1/query': () => {
    return [200, { columns: ['id', 'name'], rows: [[1, 'Alice'], [2, 'Bob']] }];
  },
  'POST /apps/data/api/databases/db1/exec': (req, body) => {
    if (body && body.statements) {
      return [200, { rows_affected: body.statements.length }];
    }
    return [200, { rows_affected: 1 }];
  },
  'GET /apps/data/api/search': () => [200, { results: [{ id: 'r1', snippet: 'match' }] }],
  'GET /apps/vault/api/credentials': () => [200, { credentials: [{ id: 'c1', name: 'aws' }] }],
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
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
});

describe('LocalitasClient', () => {
  it('withToken returns new instance', () => {
    const client = new LocalitasClient(baseUrl);
    const authed = client.withToken('mytoken');
    assert.strictEqual(authed.token, 'mytoken');
    assert.strictEqual(client.token, '');
  });

  it('sends auth header', async () => {
    const client = new LocalitasClient(baseUrl).withToken('secret');
    await client.listDatabases();
    assert.strictEqual(capturedAuth, 'Bearer secret');
  });

  it('listDatabases', async () => {
    const client = new LocalitasClient(baseUrl);
    const dbs = await client.listDatabases();
    assert.strictEqual(dbs.length, 1);
    assert.strictEqual(dbs[0].name, 'mydb');
  });

  it('createDatabase', async () => {
    const client = new LocalitasClient(baseUrl);
    const db = await client.createDatabase('testdb', true);
    assert.strictEqual(db.name, 'testdb');
    assert.strictEqual(db.system, true);
  });

  it('getDatabase', async () => {
    const client = new LocalitasClient(baseUrl);
    const db = await client.getDatabase('db1');
    assert.strictEqual(db.id, 'db1');
  });

  it('deleteDatabase', async () => {
    const client = new LocalitasClient(baseUrl);
    await client.deleteDatabase('db1');
  });

  it('sqlQuery', async () => {
    const client = new LocalitasClient(baseUrl);
    const result = await client.sqlQuery('db1', 'SELECT * FROM users');
    assert.strictEqual(result.rows.length, 2);
    assert.strictEqual(result.rows[0][1], 'Alice');
  });

  it('sqlExec', async () => {
    const client = new LocalitasClient(baseUrl);
    const result = await client.sqlExec('db1', 'INSERT INTO users (name) VALUES (?)', 'Carol');
    assert.strictEqual(result.rows_affected, 1);
  });

  it('sqlTransaction', async () => {
    const client = new LocalitasClient(baseUrl);
    const result = await client.sqlTransaction('db1', [
      { sql: 'INSERT INTO a VALUES (?)', args: [1] },
      { sql: 'INSERT INTO b VALUES (?)', args: [2] },
    ]);
    assert.strictEqual(result.rows_affected, 2);
  });

  it('searchFts', async () => {
    const client = new LocalitasClient(baseUrl);
    const result = await client.searchFts('hello');
    assert.strictEqual(result.results.length, 1);
  });

  it('vaultListCredentials', async () => {
    const client = new LocalitasClient(baseUrl);
    const creds = await client.vaultListCredentials();
    assert.strictEqual(creds.length, 1);
    assert.strictEqual(creds[0].name, 'aws');
  });

  it('throws APIError on 404', async () => {
    const client = new LocalitasClient(baseUrl);
    await assert.rejects(
      () => client.getDatabase('nonexistent'),
      (err) => {
        assert.ok(err instanceof APIError);
        assert.strictEqual(err.statusCode, 404);
        return true;
      }
    );
  });

  it('strips trailing slashes', () => {
    const client = new LocalitasClient(baseUrl + '///');
    assert.ok(!client.baseUrl.endsWith('/'));
  });
});
