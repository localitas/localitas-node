/**
 * Integration test for LocalitasClient.announce. Requires the integration
 * cluster running (make integration-cluster-start).
 */

const http = require('http');
const assert = require('assert');
const { LocalitasClient } = require('../src/index.js');

const INTEG_URL = 'http://localhost:9090';
const INTEG_TOKEN = 'lt_integ_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listed(client, name) {
  const apps = (await client._do('GET', '/apps/ext')) || [];
  return apps.some((a) => a.name === name);
}

async function main() {
  const client = new LocalitasClient(INTEG_URL).withToken(INTEG_TOKEN);
  const name = `announce-node-${Date.now()}`;
  let ready = false;
  const server = http.createServer((req, res) => {
    if (!ready || req.url !== '/health.json') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const announcement = client.announce(port);
  try {
    await sleep(1500);
    assert.strictEqual(announcement.name, '', 'core took the app before it answered health.json');
    ready = true;
    const deadline = Date.now() + 15000;
    while (announcement.name !== name) {
      assert.ok(Date.now() < deadline, 'the app answering health.json was not registered');
      await sleep(100);
    }
    assert.ok(await listed(client, name), 'registered app not listed');

    await announcement.withdraw();
    assert.ok(!(await listed(client, name)), 'withdrawn app still listed');
    console.log('  PASS: a native app is registered once it answers, and withdrawn');
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await announcement.withdraw();
    server.close();
  }
}

main();
