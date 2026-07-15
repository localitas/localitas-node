const { LocalitasClient, Migrator, crypto, scope } = require('../src/index');
const { splitSql, parseFilename } = require('../src/migrator');
const http = require('http');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

describe('migrator parsing', () => {
  it('parses timestamp filenames', () => {
    assert.deepStrictEqual(parseFilename('20260101-120000-000-init.sql'),
      { version: '20260101-120000-000', name: 'init' });
  });
  it('parses legacy filenames', () => {
    assert.deepStrictEqual(parseFilename('001_init.sql'), { version: '001', name: 'init' });
  });
  it('splits simple statements', () => {
    assert.strictEqual(splitSql('CREATE TABLE a (id INT); CREATE TABLE b (id INT);').length, 2);
  });
  it('respects trigger BEGIN/END blocks', () => {
    const sql = 'CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; END; CREATE TABLE c (id INT);';
    const stmts = splitSql(sql);
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[0].includes('TRIGGER'));
  });
});

describe('scope', () => {
  it('enforces hierarchy', () => {
    assert.ok(scope.hasScope(scope.SCOPE_ADMIN, scope.SCOPE_WRITE));
    assert.ok(!scope.hasScope(scope.SCOPE_READ, scope.SCOPE_WRITE));
  });
  it('parses a bearer token', () => {
    const claims = { user_id: 'u1', email: 'a@b.c', permission: 'write' };
    const token = Buffer.from(JSON.stringify(claims)).toString('base64');
    assert.strictEqual(scope.parseBearerToken(token).user_id, 'u1');
  });
  it('grants and denies via requireScope', () => {
    const claims = { user_id: 'u1', email: 'a@b.c', permission: 'write' };
    const header = 'Bearer ' + Buffer.from(JSON.stringify(claims)).toString('base64');
    assert.strictEqual(scope.requireScope(header, scope.SCOPE_WRITE).user_id, 'u1');
    assert.throws(() => scope.requireScope(header, scope.SCOPE_ADMIN), (e) => e.status === 403);
    assert.throws(() => scope.requireScope('', scope.SCOPE_READ), (e) => e.status === 401);
  });
});

describe('crypto', () => {
  it('round-trips and passes plaintext through', () => {
    const enc = crypto.encrypt('hello');
    assert.ok(enc.startsWith('enc:'));
    assert.strictEqual(crypto.decrypt(enc), 'hello');
    assert.strictEqual(crypto.decrypt('plain'), 'plain');
    assert.strictEqual(crypto.encrypt(''), '');
  });
});

describe('new client methods', () => {
  let server;
  let baseUrl;
  let captured;
  const routes = {
    'POST /apps/vault/api/credentials': (req, body) => {
      captured = body;
      return [200, { public_id: 'cred-1', name: body.name }];
    },
    'POST /apps/tsdb/api/ingest': (req, body) => [200, { accepted: body.metrics.length }],
    'POST /apps/ext': (req, body) => {
      captured = body;
      return [200, null];
    },
  };

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const key = `${req.method} ${req.url.split('?')[0]}`;
        const handler = routes[key];
        if (!handler) { res.writeHead(404); res.end('{}'); return; }
        const [status, payload] = handler(req, raw ? JSON.parse(raw) : null);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(payload === null ? '' : JSON.stringify(payload));
      });
    });
    await new Promise((r) => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  it('vaultCreateCredential posts the payload', async () => {
    const c = new LocalitasClient(baseUrl).withToken('t');
    const result = await c.vaultCreateCredential('s3', { url: 's3://b', data: { key: 'v' } });
    assert.strictEqual(result.public_id, 'cred-1');
    assert.strictEqual(captured.name, 's3');
    assert.strictEqual(captured.data.key, 'v');
  });

  it('ingestMetrics returns accepted count', async () => {
    const c = new LocalitasClient(baseUrl).withToken('t');
    const n = await c.ingestMetrics([{ name: 'x', value: 1 }, { name: 'y', value: 2 }]);
    assert.strictEqual(n, 2);
  });

  it('registerExternalApp posts name/display_name', async () => {
    const c = new LocalitasClient(baseUrl).withToken('t');
    await c.registerExternalApp('myapp', 'My App', 'http://localhost:9999', 'star');
    assert.strictEqual(captured.name, 'myapp');
    assert.strictEqual(captured.display_name, 'My App');
  });

  it('runAsync returns false without a run id', () => {
    const c = new LocalitasClient(baseUrl).withToken('t');
    assert.strictEqual(c.automation().runAsync('', async () => ({})), false);
  });
});
