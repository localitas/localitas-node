/**
 * AutomationClient.waitForRun against a real local HTTP server standing in
 * for core's run wait long poll and its readiness endpoint.
 */

const http = require('http');
const { test } = require('node:test');
const assert = require('node:assert');
const { LocalitasClient, APIError } = require('../src/index');

const WAIT = 'GET /apps/automation/api/runs/run_1/wait';

/**
 * Each question to a route gets the route's next answer, in order; asks
 * keeps every question's query, by route.
 */
class FakeCore {
  constructor(answers) {
    this.answers = answers;
    this.asks = {};
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://core');
      const route = `${req.method} ${url.pathname}`;
      (this.asks[route] ||= []).push(url.searchParams);
      const answer = (this.answers[route] || [])[this.asks[route].length - 1] || [404, { error: 'not found' }];
      res.writeHead(answer[0], { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer[1]));
    });
  }

  async start() {
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  close() {
    this.server.closeAllConnections();
    this.server.close();
  }
}

const waitAnswer = (finished, status) => [200, { finished, run: { id: 'run_1', status } }];

test('waitForRun asks again until core answers the run finished', async () => {
  const core = new FakeCore({ [WAIT]: [waitAnswer(false, 'queued'), waitAnswer(false, 'running'), waitAnswer(true, 'completed')] });
  const url = await core.start();
  try {
    const run = await new LocalitasClient(url, 't').automation().waitForRun('run_1', { timeout: 10000 });
    assert.deepStrictEqual(run, { id: 'run_1', status: 'completed' });
    assert.strictEqual(core.asks[WAIT].length, 3);
    for (const q of core.asks[WAIT]) {
      const hold = Number(q.get('timeout').replace(/ms$/, ''));
      assert.ok(hold > 0 && hold <= 25000, `asked with timeout ${q.get('timeout')}`);
    }
  } finally {
    core.close();
  }
});

test('waitForRun waits for a not-ready core, then asks again', async () => {
  const core = new FakeCore({
    [WAIT]: [[503, { error: 'node not ready: serving' }], waitAnswer(true, 'failed')],
    'GET /api/system/ready': [[200, { phase: 'ready', want: 'ready', ready: true }]],
  });
  const url = await core.start();
  try {
    const run = await new LocalitasClient(url, 't').automation().waitForRun('run_1', { timeout: 10000 });
    assert.strictEqual(run.status, 'failed');
    assert.strictEqual(core.asks['GET /api/system/ready'].length, 1);
  } finally {
    core.close();
  }
});

test('waitForRun rejects with core\'s answer for a refused run', async () => {
  const core = new FakeCore({ [WAIT]: [[403, { error: 'Access denied' }]] });
  const url = await core.start();
  try {
    await assert.rejects(
      new LocalitasClient(url, 't').automation().waitForRun('run_1', { timeout: 10000 }),
      (e) => e instanceof APIError && e.statusCode === 403,
    );
  } finally {
    core.close();
  }
});
