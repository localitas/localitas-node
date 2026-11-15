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
  // What core signs at T0 under the Ed25519 seed of 32 bytes of 7; core's
  // internal/auth golden test pins the same strings.
  const GOLDEN_PUBLIC_KEY = '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw';
  const GOLDEN = 'eyJlbWFpbCI6ImFsaWNlQHRlc3QubG9jYWwiLCJuYW1lIjoiQWxpY2UiLCJ1c2VyX2lkIjoidTEiLCJwZXJtaXNzaW9uIjoid3JpdGUiLCJpYXQiOjE3OTIyMzg0MDAsImV4cCI6MTc5MjIzODcwMCwibWF4IjoxNzkyMzI0ODAwLCJraWQiOiJlZDI1NTE5LV9vRXNFdk9yVE9hcyJ9.C8hu4KQIKHVrA_NyuOnESy33xUYWVqZWDyrONgSpvaTPxCU_aa7xf1N9POyND7eOnwGTh0Pffo71Y-mB3yO9Dg';
  const T0 = Date.UTC(2026, 9, 17, 12, 0, 0) / 1000;
  const nodeCrypto = require('crypto');
  const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
  const sign = (seedByte, claims) => {
    const key = nodeCrypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.alloc(32, seedByte)]), format: 'der', type: 'pkcs8' });
    const pub = nodeCrypto.createPublicKey(key).export({ format: 'jwk' }).x;
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300, ...claims, kid: scope.ed25519KeyId(Buffer.from(pub, 'base64url')) })).toString('base64url');
    return payload + '.' + nodeCrypto.sign(null, Buffer.from(payload), key).toString('base64url');
  };
  before(() => scope.setIdentityPublicKeys(GOLDEN_PUBLIC_KEY));

  it("verifies core's signed token", () => {
    const c = scope.parseBearerToken(GOLDEN, { now: T0 });
    assert.deepStrictEqual([c.user_id, c.email, c.name, c.permission], ['u1', 'alice@test.local', 'Alice', 'write']);
  });
  it('refuses forged tokens', () => {
    const claims = { user_id: 'alice', permission: 'admin' };
    const signed = sign(7, { user_id: 'bob' });
    const sig = signed.split('.')[1];
    const edited = JSON.parse(Buffer.from(signed.split('.')[0], 'base64url').toString('utf8'));
    const forgeries = {
      unsigned: Buffer.from(JSON.stringify(claims)).toString('base64'),
      'other key': sign(0, claims),
      'edited claims': Buffer.from(JSON.stringify({ ...edited, ...claims })).toString('base64url') + '.' + sig,
      'lt_ token': 'lt_abc',
    };
    for (const [name, token] of Object.entries(forgeries)) {
      assert.throws(() => scope.parseBearerToken(token), Error, name);
      assert.throws(() => scope.requireScope('Bearer ' + token, scope.SCOPE_READ), (e) => e.status === 401, name);
    }
  });
  it('grants and denies via requireScope', () => {
    const header = 'Bearer ' + sign(7, { user_id: 'u1', email: 'a@b.c', permission: 'write' });
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

  it('runAsync returns false without a run id', () => {
    const c = new LocalitasClient(baseUrl).withToken('t');
    assert.strictEqual(c.automation().runAsync('', async () => ({})), false);
  });
});
