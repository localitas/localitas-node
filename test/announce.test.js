/**
 * LocalitasClient.announce against a real local HTTP server standing in for
 * core's readiness long poll, its door and its app registry.
 */

const http = require('http');
const { test } = require('node:test');
const assert = require('node:assert');
const { LocalitasClient } = require('../src/index');

function seconds(duration) {
  if (/ms$/.test(duration)) return Number(duration.slice(0, -2)) / 1000;
  if (/s$/.test(duration)) return Number(duration.slice(0, -1));
  return 0;
}

/**
 * A readiness question with a timeout is held until the node is ready (or
 * the timeout passes); one without is answered at once. Before Ready,
 * POST /apps/ext is answered 503 by the door.
 */
class FakeCore {
  constructor(postStatus = []) {
    this.ready = false;
    this.held = [];
    this.asks = [];
    this.posts = 0;
    this.postStatus = postStatus;
    this.events = [];
    this.waiters = [];
    this.server = http.createServer((req, res) => this._serve(req, res));
  }

  async start() {
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }

  close() {
    this.becomeReady();
    this.server.closeAllConnections();
    this.server.close();
  }

  becomeReady() {
    this.ready = true;
    for (const answer of this.held.splice(0)) answer();
  }

  _event(e) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(e);
    else this.events.push(e);
  }

  next() {
    if (this.events.length) return Promise.resolve(this.events.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('core heard nothing from the app')), 5000);
      this.waiters.push((e) => { clearTimeout(timer); resolve(e); });
    });
  }

  _send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === null ? '' : JSON.stringify(body));
  }

  _serve(req, res) {
    const url = new URL(req.url, this.url);
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/system/ready') {
      this.asks.push(url.searchParams);
      this._event('ready');
      const want = url.searchParams.get('phase');
      const answer = () => {
        if (res.writableEnded) return;
        if (this.ready) this._send(res, 200, { phase: 'ready', want, ready: true });
        else this._send(res, 503, { phase: 'serving', want, ready: false, error: 'not ready within the timeout' }, { 'Retry-After': '1' });
      };
      const timeout = seconds(url.searchParams.get('timeout') || '0');
      if (timeout > 0 && !this.ready) {
        this.held.push(answer);
        setTimeout(answer, Math.min(timeout, 10) * 1000).unref();
      } else {
        answer();
      }
      return;
    }
    if (route === 'POST /apps/ext') {
      this.posts++;
      let status = this.posts <= this.postStatus.length ? this.postStatus[this.posts - 1] : 201;
      if (!this.ready) status = 503;
      if (status === 503) this.ready = false;
      this._event('post');
      req.resume();
      if (status === 201) return this._send(res, 201, { name: 'app' });
      if (status === 503) return this._send(res, 503, { error: 'node not ready: serving' }, { 'Retry-After': '1', 'X-Localitas-Not-Ready': 'serving' });
      if (status === 502) return this._send(res, 502, { error: 'health.json: connection refused: the app does not answer health.json' });
      return this._send(res, status, { error: 'health.json names no app' });
    }
    if (route === 'DELETE /apps/ext/app') return this._send(res, 204, null);
    this._send(res, 404, { error: 'not found' });
  }
}

async function started(t, core) {
  await core.start();
  const announcement = new LocalitasClient(core.url, 'token').announce(8123);
  t.after(async () => {
    await announcement.withdraw();
    core.close();
  });
  return announcement;
}

async function ended(announcement) {
  let timer;
  await Promise.race([
    announcement._done,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the announcement did not end')), 5000); }),
  ]);
  clearTimeout(timer);
}

test('announce waits on core\'s readiness long poll before registering', async (t) => {
  const core = new FakeCore();
  const announcement = await started(t, core);

  assert.strictEqual(await core.next(), 'ready', 'POST /apps/ext reached core before its readiness answered');
  const q = core.asks[0];
  assert.strictEqual(q.get('phase'), 'ready');
  assert.ok(seconds(q.get('timeout') || '0') > 0, `readiness asked with timeout ${q.get('timeout')}: not a long poll`);

  core.becomeReady();
  assert.strictEqual(await core.next(), 'post', 'after core became ready the app did not register');
  assert.strictEqual(core.asks.length, 1, 'more than one readiness request: polled, not one long poll');
  await ended(announcement);
  assert.strictEqual(announcement.name, 'app');
  assert.strictEqual(core.posts, 1);
});

test('a registration core answers 503 waits again, then registers once', async (t) => {
  const core = new FakeCore([503]);
  core.ready = true;
  const announcement = await started(t, core);

  assert.deepStrictEqual([await core.next(), await core.next(), await core.next()], ['ready', 'post', 'ready']);
  core.becomeReady();
  assert.strictEqual(await core.next(), 'post', 'after core became ready again the app did not register');
  await ended(announcement);
  assert.strictEqual(announcement.name, 'app');
  assert.deepStrictEqual([core.posts, core.asks.length], [2, 2]);
});

test('an app core cannot reach yet (502) is asked again, then registers once', async (t) => {
  const core = new FakeCore([502]);
  core.ready = true;
  const announcement = await started(t, core);

  assert.deepStrictEqual([await core.next(), await core.next(), await core.next(), await core.next()], ['ready', 'post', 'ready', 'post'],
    'core found the app not answering yet (502) and the app did not register once it answered');
  await ended(announcement);
  assert.strictEqual(announcement.name, 'app');
  assert.strictEqual(core.posts, 2);
});

test('a registration core refuses otherwise is not retried', async (t) => {
  const core = new FakeCore([422]);
  core.ready = true;
  const announcement = await started(t, core);

  assert.deepStrictEqual([await core.next(), await core.next()], ['ready', 'post']);
  await ended(announcement);
  assert.strictEqual(announcement.name, '');
  assert.strictEqual(core.posts, 1);
});

test('withdraw while waiting on core\'s readiness ends the wait at once', async (t) => {
  const core = new FakeCore();
  const announcement = await started(t, core);

  assert.strictEqual(await core.next(), 'ready');
  const began = Date.now();
  await announcement.withdraw();
  assert.ok(Date.now() - began < 1000, 'withdraw waited on core\'s readiness');
  assert.strictEqual(core.posts, 0, 'withdrawn before core was ready, the app registered');
});
