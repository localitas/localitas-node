/**
 * Integration tests for waiting on automation runs.
 * Requires the integration cluster (make integration-cluster-start).
 */

const { LocalitasClient } = require('../src/index.js');
const assert = require('assert');

const INTEG_URL = 'http://localhost:9090';
const INTEG_TOKEN = 'lt_integ_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL: ${name} — ${e.message}`);
    failed++;
  }
}

// A manual automation whose only call fails slowly: retried with 30 s
// backoff, it runs for minutes unless its outcome is published.
async function withSlowRun(fn) {
  const client = new LocalitasClient(INTEG_URL).withToken(INTEG_TOKEN);
  const name = `node_wait_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const auto = await client._do('POST', '/apps/automation/api/automations', {
    name,
    description: 'node sdk wait test',
    dag_config: { dag_id: name, name, description: '', nodes: [{
      node_id: 'slow', node_type: 'http-api', execution_strategy: 'any_node',
      metadata: { url: `/api/system/no_such_route_${name}`, method: 'GET', timeout_ms: 5000, max_retries: 3, backoff_ms: 30000, max_backoff_ms: 30000 },
    }] },
    trigger_type: 'manual',
    trigger_config: {},
    is_enabled: true,
  });
  try {
    const run = await client.automation().trigger(auto.id);
    const deadline = Date.now() + 30000;
    while ((await client.automation().getRun(run.id)).status !== 'running') {
      if (Date.now() > deadline) throw new Error('the run never started');
      await new Promise((r) => setTimeout(r, 100));
    }
    await fn(client, run);
  } finally {
    await client._do('DELETE', `/apps/automation/api/automations/${auto.id}`);
  }
}

async function main() {
  console.log('localitas-node automation integration tests\n');

  await test('a waiting run returns once its outcome is published', () => withSlowRun(async (client, run) => {
    const waiting = client.automation().waitForRun(run.id, { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 500));
    await client.automation().publishResult(run.id, 'completed', { answer: 42 });
    const published = Date.now();
    const done = await waiting;
    assert.ok(Date.now() - published < 5000, 'waitForRun returned long after the outcome');
    assert.strictEqual(done.status, 'completed');
    assert.strictEqual(done.result.answer, 42);
  }));

  await test('a finished run returns at once', () => withSlowRun(async (client, run) => {
    await client.automation().publishResult(run.id, 'failed', {}, 'stopped');
    const start = Date.now();
    const done = await client.automation().waitForRun(run.id, { timeout: 30000 });
    assert.ok(Date.now() - start < 5000);
    assert.deepStrictEqual([done.status, done.error], ['failed', 'stopped']);
  }));

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
