const { LocalitasClient, ConfigError, APIError, Database, cacheSocketUrl, scope } = require('../src/index');
const http = require('http');
const { WebSocketServer } = require('ws');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

// No test reaches the core of the machine running it through its core.env:
// the home is empty.
process.env.LOCALITAS_HOME = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'localitas-home-'));

async function withEnv(values, fn) {
  const saved = {};
  for (const k of Object.keys(values)) {
    saved[k] = process.env[k];
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A real HTTP server that records every call and answers through `answer`.
function recordingServer(answer) {
  const state = { calls: [], url: '', server: null };
  state.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const call = { method: req.method, path: req.url, auth: req.headers.authorization, contentType: req.headers['content-type'], body: raw ? JSON.parse(raw) : null };
      state.calls.push(call);
      const [status, payload] = answer(call);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload === null ? '' : JSON.stringify(payload));
    });
  });
  state.start = () => new Promise((r) => state.server.listen(0, '127.0.0.1', () => {
    state.url = `http://127.0.0.1:${state.server.address().port}`;
    r();
  }));
  state.stop = () => new Promise((r) => state.server.close(r));
  return state;
}

describe('LocalitasClient.default', () => {
  const core = recordingServer(() => [200, []]);
  before(() => core.start());
  after(() => core.stop());
  beforeEach(() => { core.calls = []; });

  it('refuses a missing or empty CORE_URL, naming it', async () => {
    for (const value of [undefined, '']) {
      await withEnv({ CORE_URL: value, LOCALITAS_API_TOKEN: 'lt_t' }, () => {
        assert.throws(() => LocalitasClient.default(), (e) => e instanceof ConfigError && /CORE_URL is not set/.test(e.message));
      });
    }
  });

  it('refuses a CORE_URL that is not an absolute http(s) URL', async () => {
    for (const value of ['core.test:9', 'ftp://core.test', '/apps']) {
      await withEnv({ CORE_URL: value, LOCALITAS_API_TOKEN: 'lt_t' }, () => {
        assert.throws(() => LocalitasClient.default(), (e) => e instanceof ConfigError && /CORE_URL/.test(e.message), value);
      });
    }
  });

  it('refuses a missing LOCALITAS_API_TOKEN, naming it', async () => {
    await withEnv({ CORE_URL: core.url, LOCALITAS_API_TOKEN: undefined }, () => {
      assert.throws(() => LocalitasClient.default(), (e) => e instanceof ConfigError && /LOCALITAS_API_TOKEN/.test(e.message));
    });
  });

  it('calls CORE_URL with LOCALITAS_API_TOKEN', async () => {
    await withEnv({ CORE_URL: core.url + '/', LOCALITAS_API_TOKEN: 'lt_default' }, async () => {
      await LocalitasClient.default().listDatabases();
    });
    assert.deepStrictEqual(core.calls.map((c) => [c.method, c.path, c.auth]), [['GET', '/apps/data/api/databases', 'Bearer lt_default']]);
  });

  it('fails each call of a client without a base URL with the same clear error', async () => {
    for (const client of [new LocalitasClient(''), new LocalitasClient()]) {
      await assert.rejects(client.listDatabases(), (e) => e instanceof ConfigError && /CORE_URL is not set/.test(e.message));
      await assert.rejects(client.app('weather').get('/now'), ConfigError);
    }
  });

  it('loads the identity key only from CORE_URL', async () => {
    await withEnv({ CORE_URL: undefined, LOCALITAS_API_TOKEN: 'lt_t', LOCALITAS_IDENTITY_PUBLIC_KEY: undefined }, async () => {
      scope.resetIdentityPublicKeys();
      await assert.rejects(scope.loadIdentityPublicKey(), (e) => e instanceof ConfigError && /CORE_URL/.test(e.message));
      assert.throws(() => scope.parseBearerToken('eyJraWQiOiJlZDI1NTE5LXgiLCJleHAiOjF9.c2ln'), /no identity public key/);
    });
  });
});

describe('client.app', () => {
  const app = recordingServer((call) => {
    if (call.path.startsWith('/apps/ext/weather/missing')) return [404, { error: 'no such thing' }];
    if (call.method === 'DELETE') return [204, null];
    return [200, { got: call.method, body: call.body }];
  });
  before(() => app.start());
  after(() => app.stop());
  beforeEach(() => { app.calls = []; });

  it("reaches /apps/ext/<name><path> with the client's token", async () => {
    const weather = new LocalitasClient(app.url, 'lt_app').app('weather');
    assert.deepStrictEqual(await weather.get('/api/now?city=Paris'), { got: 'GET', body: null });
    assert.deepStrictEqual(await weather.post('/api/sync', { full: true }), { got: 'POST', body: { full: true } });
    assert.deepStrictEqual(await weather.put('/api/places/1'), { got: 'PUT', body: null });
    assert.strictEqual(await weather.delete('/api/places/1'), null);
    assert.deepStrictEqual(app.calls.map((c) => [c.method, c.path, c.auth]), [
      ['GET', '/apps/ext/weather/api/now?city=Paris', 'Bearer lt_app'],
      ['POST', '/apps/ext/weather/api/sync', 'Bearer lt_app'],
      ['PUT', '/apps/ext/weather/api/places/1', 'Bearer lt_app'],
      ['DELETE', '/apps/ext/weather/api/places/1', 'Bearer lt_app'],
    ]);
    assert.strictEqual(app.calls[1].contentType, 'application/json');
  });

  it('raises APIError for an error status', async () => {
    await assert.rejects(new LocalitasClient(app.url, 't').app('weather').get('/missing'), (e) => e instanceof APIError && e.statusCode === 404);
  });

  it('refuses names that are not app names and paths that are not paths', async () => {
    const client = new LocalitasClient(app.url, 't');
    for (const name of ['', 'Weather', '-weather', 'we/ather', '../vault', 'we ather', undefined]) {
      assert.throws(() => client.app(name), TypeError, String(name));
    }
    const weather = client.app('weather');
    for (const path of ['', 'api/now', '//evil.test/x', 'http://evil.test/x', '/a\\b', '/x://evil.test', undefined]) {
      await assert.rejects(weather.get(path), TypeError, String(path));
    }
    assert.deepStrictEqual(app.calls, []);
  });
});

describe('cache sockets', () => {
  let wss;
  let port;
  const seen = { connections: [], actions: [], waiters: [] };

  before(async () => {
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (socket, req) => {
      seen.connections.push({ path: req.url, auth: req.headers.authorization });
      const send = (event) => socket.send(JSON.stringify(event));
      send({ type: 'connected' });
      socket.on('message', (data) => {
        const action = JSON.parse(data.toString());
        seen.actions.push(action);
        if (action.action === 'subscribe') send({ type: 'message', channel: action.channel, seq: 1, value: 'hello' });
        seen.waiters.forEach((w) => w());
      });
    });
    await new Promise((r) => wss.on('listening', r));
    port = wss.address().port;
  });

  after(async () => {
    wss.clients.forEach((s) => s.terminate());
    await new Promise((r) => wss.close(r));
  });

  const actionsReach = (n) => new Promise((resolve, reject) => {
    const check = () => { if (seen.actions.length >= n) resolve(); };
    seen.waiters.push(check);
    check();
    setTimeout(() => reject(new Error(`got ${JSON.stringify(seen.actions)}`)), 5000).unref();
  });

  it('builds ws for http and wss for https from the base URL', () => {
    assert.strictEqual(cacheSocketUrl('http://core.test:7/', 'my cache'), 'ws://core.test:7/apps/cache/ws/my%20cache');
    assert.strictEqual(cacheSocketUrl('https://core.test', 'c/1'), 'wss://core.test/apps/cache/ws/c%2F1');
    assert.throws(() => cacheSocketUrl('', 'c'), ConfigError);
  });

  it('opens a wss socket for an https client', () => {
    const ps = new LocalitasClient(`https://127.0.0.1:${port}`, 't').cache('c').watchLatest('news', () => {});
    try {
      assert.strictEqual(ps.url, `wss://127.0.0.1:${port}/apps/cache/ws/c`);
    } finally {
      ps.close();
    }
  });

  it("subscribes over one socket per cache with the client's token", async () => {
    const cache = new LocalitasClient(`http://127.0.0.1:${port}`, 'lt_ws').cache('my cache');
    const got = [];
    const delivered = new Promise((r) => {
      cache.subscribe('events', 'worker-1', (msg) => { got.push(msg); r(); });
    });
    const ps = cache.watch('runs', 3, () => {});
    try {
      assert.strictEqual(cache.watchLatest('news', () => {}), ps);
      await delivered;
      await actionsReach(3);
      assert.deepStrictEqual(seen.connections, [{ path: '/apps/cache/ws/my%20cache', auth: 'Bearer lt_ws' }]);
      assert.deepStrictEqual(got, [{ seq: 1, value: 'hello', channel: 'events' }]);
      assert.deepStrictEqual(seen.actions.map((a) => [a.action, a.channel]).sort(), [['subscribe', 'events'], ['watch', 'news'], ['watch', 'runs']]);
    } finally {
      ps.close();
    }
  });
});

describe('client.db', () => {
  let failNext = false;
  const core = recordingServer((call) => {
    if (call.path === '/apps/data/api/system-dbs') {
      if (failNext) {
        failNext = false;
        return [503, { error: 'electing' }];
      }
      return [200, { id: 'db_7', name: call.body.name, system: true }];
    }
    if (call.path === '/apps/data/api/databases/db_7/query') return [200, { columns: ['id', 'title'], rows: [[1, 'first']] }];
    if (call.path === '/apps/data/api/databases/db_7/exec') return [200, { rows_affected: 1, last_insert_id: 5 }];
    return [404, { error: 'not found' }];
  });
  before(() => core.start());
  after(() => core.stop());
  beforeEach(() => { core.calls = []; });

  it('resolves the database by name once and reads and writes through it', async () => {
    const db = new LocalitasClient(core.url, 'lt_db').db('notes');
    assert.deepStrictEqual(core.calls, []);
    assert.deepStrictEqual(await db.prepare('SELECT id, title FROM notes').all(), [{ id: 1, title: 'first' }]);
    assert.deepStrictEqual(await db.prepare('INSERT INTO notes (title) VALUES (?)').run('second'), { changes: 1, lastInsertRowid: 5 });
    assert.deepStrictEqual(core.calls.map((c) => [c.method, c.path, c.auth]), [
      ['POST', '/apps/data/api/system-dbs', 'Bearer lt_db'],
      ['POST', '/apps/data/api/databases/db_7/query', 'Bearer lt_db'],
      ['POST', '/apps/data/api/databases/db_7/exec', 'Bearer lt_db'],
    ]);
    assert.deepStrictEqual(core.calls[0].body, { name: 'notes' });
    assert.deepStrictEqual(core.calls[2].body, { sql: 'INSERT INTO notes (title) VALUES (?)', args: ['second'] });
    assert.strictEqual(await db.databaseId(), 'db_7');
    assert.strictEqual(db.client.baseUrl, core.url);
  });

  it('raises a failed resolution from the use and retries it on the next', async () => {
    failNext = true;
    const db = new LocalitasClient(core.url, 't').db('notes');
    await assert.rejects(db.prepare('SELECT 1').get(), (e) => e instanceof APIError && e.statusCode === 503);
    assert.deepStrictEqual(await db.prepare('SELECT id, title FROM notes').get(), { id: 1, title: 'first' });
    assert.strictEqual(core.calls.filter((c) => c.path === '/apps/data/api/system-dbs').length, 2);
  });

  it('takes the old form host from CORE_URL, never a guessed one', async () => {
    await withEnv({ CORE_URL: undefined }, () => {
      assert.throws(() => new Database('db_7'), (e) => e instanceof ConfigError && /CORE_URL/.test(e.message));
    });
    await withEnv({ CORE_URL: core.url }, async () => {
      assert.deepStrictEqual(await new Database('db_7', { token: 't' }).prepare('SELECT 1').get(), { id: 1, title: 'first' });
    });
    assert.strictEqual(core.calls[0].path, '/apps/data/api/databases/db_7/query');
  });
});

describe('runAsync echoes the Idempotency-Key', () => {
  const completions = [];
  let completed = () => {};
  const core = recordingServer((call) => {
    const m = call.path.match(/^\/apps\/automation\/api\/runs\/([^/]+)\/complete$/);
    if (m) {
      completions.push({ run: m[1], body: call.body });
      completed();
    }
    return [200, { ok: true }];
  });
  let appServer;
  let appUrl;
  let client;

  const nextCompletion = () => new Promise((resolve) => {
    const n = completions.length;
    completed = () => { if (completions.length > n) resolve(completions[completions.length - 1]); };
  });

  before(async () => {
    await core.start();
    client = new LocalitasClient(core.url, 'lt_app');
    appServer = http.createServer((req, res) => {
      const accepted = client.automation().runAsync(req, async () => ({ synced: 3 }));
      res.writeHead(accepted ? 202 : 200);
      res.end();
    });
    await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
    appUrl = `http://127.0.0.1:${appServer.address().port}`;
  });
  after(async () => {
    await new Promise((r) => appServer.close(r));
    await core.stop();
  });

  it('from an incoming request', async () => {
    const done = nextCompletion();
    const resp = await fetch(appUrl + '/sync', { method: 'POST', headers: { 'Localitas-Automation-Run-ID': 'run_1', 'Idempotency-Key': 'run_1/fetch/2' } });
    assert.strictEqual(resp.status, 202);
    const c = await done;
    assert.strictEqual(c.run, 'run_1');
    assert.strictEqual(c.body.idempotency_key, 'run_1/fetch/2');
    assert.strictEqual(c.body.status, 'completed');
    assert.strictEqual(c.body.result.synced, 3);
  });

  it('from a Headers object and from a plain object of any case', async () => {
    let done = nextCompletion();
    client.automation().runAsync(new Headers({ 'localitas-automation-run-id': 'run_2', 'idempotency-key': 'run_2/a/1' }), async () => null);
    assert.deepStrictEqual([(await done).run, (await done).body.idempotency_key], ['run_2', 'run_2/a/1']);
    done = nextCompletion();
    client.automation().runAsync({ 'LOCALITAS-AUTOMATION-RUN-ID': 'run_3', 'Idempotency-Key': 'run_3/b/4' }, async () => null);
    assert.deepStrictEqual([(await done).run, (await done).body.idempotency_key], ['run_3', 'run_3/b/4']);
  });

  it('not from the run ID alone', async () => {
    const done = nextCompletion();
    assert.strictEqual(client.automation().runAsync('run_4', async () => { throw new Error('boom'); }), true);
    const c = await done;
    assert.strictEqual(c.run, 'run_4');
    assert.strictEqual(c.body.status, 'failed');
    assert.ok(!('idempotency_key' in c.body));
  });

  it('a request without a run ID is not async', async () => {
    const resp = await fetch(appUrl + '/sync', { method: 'POST' });
    assert.strictEqual(resp.status, 200);
    assert.strictEqual(client.automation().runAsync({ 'idempotency-key': 'x/y/1' }, async () => null), false);
  });

  it('publishResult sends the key when given', async () => {
    await client.automation().publishResult('run_5', 'completed', {}, '', { idempotencyKey: 'run_5/c/1' });
    await client.automation().publishResult('run_6', 'completed', {}, '');
    const [k5, k6] = completions.slice(-2);
    assert.strictEqual(k5.body.idempotency_key, 'run_5/c/1');
    assert.ok(!('idempotency_key' in k6.body));
  });
});
