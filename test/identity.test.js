const { LocalitasClient, scope } = require('../src/index');
const http = require('http');
const nodeCrypto = require('crypto');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// What core signs at T0 under the Ed25519 seed of 32 bytes of 7; core's
// internal/auth golden test pins the same strings.
const GOLDEN_PUBLIC_KEY = '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw';
const GOLDEN_TOKEN = 'eyJlbWFpbCI6ImFsaWNlQHRlc3QubG9jYWwiLCJuYW1lIjoiQWxpY2UiLCJ1c2VyX2lkIjoidTEiLCJwZXJtaXNzaW9uIjoid3JpdGUiLCJpYXQiOjE3OTIyMzg0MDAsImV4cCI6MTc5MjIzODcwMCwibWF4IjoxNzkyMzI0ODAwLCJraWQiOiJlZDI1NTE5LV9vRXNFdk9yVE9hcyJ9.C8hu4KQIKHVrA_NyuOnESy33xUYWVqZWDyrONgSpvaTPxCU_aa7xf1N9POyND7eOnwGTh0Pffo71Y-mB3yO9Dg';
const LEGACY_GOLDEN_TOKEN = 'eyJlbWFpbCI6ImFsaWNlQHRlc3QubG9jYWwiLCJuYW1lIjoiQWxpY2UiLCJ1c2VyX2lkIjoidTEiLCJwZXJtaXNzaW9uIjoid3JpdGUifQ.qpBZu3EVKLK3lKw_8Y2WD_VP9nCqx849D30L0r9fo5Y';
const TEST_API_TOKEN = 'lt_test_cluster_token';
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0) / 1000;

// The PKCS#8 DER prefix of an Ed25519 private key; the seed follows it.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function signEd25519(seedByte, claims) {
  const key = nodeCrypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.alloc(32, seedByte)]), format: 'der', type: 'pkcs8' });
  const pub = nodeCrypto.createPublicKey(key).export({ format: 'jwk' }).x;
  const payload = Buffer.from(JSON.stringify({ ...claims, kid: scope.ed25519KeyId(Buffer.from(pub, 'base64url')) })).toString('base64url');
  return payload + '.' + nodeCrypto.sign(null, Buffer.from(payload), key).toString('base64url');
}

function signHmac(apiToken, claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const key = Buffer.from(nodeCrypto.createHash('sha256').update('localitas-internal-token-v1:' + apiToken).digest().toString('base64'));
  return payload + '.' + nodeCrypto.createHmac('sha256', key).update(payload).digest('base64url');
}

const fresh = (now, ttl = 300) => ({ user_id: 'u1', email: 'alice@test.local', permission: 'write', iat: now, exp: now + ttl, max: now + 86400 });

function withEnv(values, fn) {
  const saved = {};
  for (const k of Object.keys(values)) {
    saved[k] = process.env[k];
    process.env[k] = values[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('identity tokens', () => {
  beforeEach(() => {
    scope.setIdentityKeyFromApiToken(TEST_API_TOKEN);
    scope.setIdentityPublicKeys(GOLDEN_PUBLIC_KEY);
    scope.resetAcceptLegacyIdentityTokens();
  });

  it("verifies core's Ed25519 token", () => {
    const c = scope.parseBearerToken(GOLDEN_TOKEN, { now: T0 });
    assert.deepStrictEqual([c.user_id, c.permission, c.exp], ['u1', 'write', T0 + 300]);
  });

  it('rejects expired and future tokens', () => {
    scope.parseBearerToken(GOLDEN_TOKEN, { now: T0 + 300 + 119 });
    assert.throws(() => scope.parseBearerToken(GOLDEN_TOKEN, { now: T0 + 300 + 121 }), /expired/);
    assert.throws(() => scope.parseBearerToken(GOLDEN_TOKEN, { now: T0 - 121 }), /future/);
  });

  it("rejects another cluster's key", () => {
    assert.throws(() => scope.parseBearerToken(signEd25519(0, fresh(T0)), { now: T0 }));
  });

  it('accepts legacy tokens only while legacy tokens are accepted', () => {
    const withExp = signHmac(TEST_API_TOKEN, fresh(T0));
    scope.parseBearerToken(LEGACY_GOLDEN_TOKEN, { now: T0 });
    scope.parseBearerToken(withExp, { now: T0 });
    scope.setAcceptLegacyIdentityTokens(false);
    for (const token of [LEGACY_GOLDEN_TOKEN, withExp]) {
      assert.throws(() => scope.parseBearerToken(token, { now: T0 }), /legacy/);
    }
    scope.parseBearerToken(GOLDEN_TOKEN, { now: T0 });
  });

  it('takes the public key and policy from the environment', () => {
    withEnv({ LOCALITAS_IDENTITY_PUBLIC_KEY: GOLDEN_PUBLIC_KEY, LOCALITAS_ACCEPT_LEGACY_IDENTITY_TOKENS: 'false' }, () => {
      scope.resetIdentityPublicKeys();
      scope.resetAcceptLegacyIdentityTokens();
      scope.parseBearerToken(GOLDEN_TOKEN, { now: T0 });
      assert.throws(() => scope.parseBearerToken(LEGACY_GOLDEN_TOKEN, { now: T0 }), /legacy/);
    });
  });
});

describe('identity tokens with core', () => {
  let server;
  let url;
  const state = { seen: [], refreshes: [], askedKeyWith: [], refreshed: '' };

  before(async () => {
    server = http.createServer((req, res) => {
      const auth = req.headers['authorization'];
      const send = (body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
      if (req.url === '/api/auth/identity/public-key') {
        state.askedKeyWith.push(auth);
        return send({ alg: 'EdDSA', public_key: GOLDEN_PUBLIC_KEY, accept_legacy: false });
      }
      if (req.url === '/api/auth/identity/refresh') {
        state.refreshes.push(auth);
        return send({ token: state.refreshed });
      }
      if (req.url === '/api/auth/identity/for-user') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => { state.forUser = { auth, body: JSON.parse(body) }; send({ token: 'minted', expires_at: 1 }); });
        return undefined;
      }
      state.seen.push(auth);
      return send([]);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  beforeEach(() => {
    Object.assign(state, { seen: [], refreshes: [], askedKeyWith: [] });
    scope.setIdentityPublicKeys(GOLDEN_PUBLIC_KEY);
    scope.resetAcceptLegacyIdentityTokens();
  });
  afterEach(() => scope.setIdentityPublicKeys(GOLDEN_PUBLIC_KEY));

  it('loads the public key and policy from core', async () => {
    await withEnv({ CORE_URL: url, LOCALITAS_API_TOKEN: TEST_API_TOKEN, LOCALITAS_IDENTITY_PUBLIC_KEY: '', LOCALITAS_ACCEPT_LEGACY_IDENTITY_TOKENS: '' }, async () => {
      scope.resetIdentityPublicKeys();
      await scope.loadIdentityPublicKey();
      scope.parseBearerToken(GOLDEN_TOKEN, { now: T0 });
      assert.deepStrictEqual(state.askedKeyWith, [`Bearer ${TEST_API_TOKEN}`]);
      assert.throws(() => scope.parseBearerToken(LEGACY_GOLDEN_TOKEN, { now: T0 }), /legacy/);
    });
  });

  it('refreshes the identity token a client acts with near its expiry', async () => {
    const original = signEd25519(7, fresh(T0));
    state.refreshed = signEd25519(7, fresh(T0 + 270));
    const client = new LocalitasClient(url, original);
    client.now = () => T0;
    await client.listDatabases();
    client.now = () => T0 + 270;
    await client.listDatabases();
    assert.deepStrictEqual(state.refreshes, [`Bearer ${original}`]);
    assert.deepStrictEqual(state.seen, [`Bearer ${original}`, `Bearer ${state.refreshed}`]);
  });

  it("asks core for a user's token", async () => {
    const token = await new LocalitasClient(url, TEST_API_TOKEN).identityForUser('bob', 'write', 120);
    assert.strictEqual(token, 'minted');
    assert.strictEqual(state.forUser.auth, `Bearer ${TEST_API_TOKEN}`);
    assert.deepStrictEqual(state.forUser.body, { user_id: 'bob', permission: 'write', ttl_seconds: 120 });
  });
});
