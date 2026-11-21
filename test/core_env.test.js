// A process core did not start (an app launchd runs, a tool) finds core
// through the core.env core writes in its home, as the Go and Python SDKs
// do; the environment core gives an app it starts wins over the file.
const { LocalitasClient, ConfigError, defaultToken } = require('../src/index');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

process.env.LOCALITAS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'localitas-home-'));

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

function writeHome(home, body) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'core.env'), body, { mode: 0o600 });
}

describe('a native run finds core in its home', () => {
  let server;
  let url;
  const calls = [];
  before(async () => {
    server = http.createServer((req, res) => {
      calls.push(`${req.url} ${req.headers.authorization}`);
      res.setHeader('Content-Type', 'application/json');
      res.end('[]');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  it('reaches the core of its home with the token it wrote', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    writeHome(home, `# written by localitas-core\nCORE_URL=${url}\nLOCALITAS_API_TOKEN=lt_node\n`);
    await withEnv({ CORE_URL: undefined, LOCALITAS_API_TOKEN: undefined, LOCALITAS_HOME: home }, async () => {
      const client = LocalitasClient.default();
      assert.strictEqual(defaultToken(), 'lt_node');
      await client.listDatabases();
    });
    assert.strictEqual(calls.pop(), '/apps/data/api/databases Bearer lt_node');
  });

  it('takes ~/.localitas as the home without LOCALITAS_HOME', async () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'user-'));
    writeHome(path.join(user, '.localitas'), `CORE_URL=${url}\nLOCALITAS_API_TOKEN=lt_node\n`);
    await withEnv({ CORE_URL: undefined, LOCALITAS_API_TOKEN: undefined, LOCALITAS_HOME: undefined, HOME: user }, () => {
      assert.strictEqual(LocalitasClient.default().baseUrl, url);
    });
  });

  it('lets the environment win over the home', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    writeHome(home, 'CORE_URL=http://core.invalid:1\nLOCALITAS_API_TOKEN=lt_node\n');
    await withEnv({ CORE_URL: url, LOCALITAS_API_TOKEN: 'lt_container', LOCALITAS_HOME: home }, async () => {
      await LocalitasClient.default().listDatabases();
    });
    assert.strictEqual(calls.pop(), '/apps/data/api/databases Bearer lt_container');
  });

  it('fails naming the variable and the file when nothing is configured', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    await withEnv({ CORE_URL: undefined, LOCALITAS_API_TOKEN: undefined, LOCALITAS_HOME: home }, () => {
      assert.throws(() => LocalitasClient.default(), (e) => e instanceof ConfigError && /CORE_URL is not set/.test(e.message) && e.message.includes(path.join(home, 'core.env')));
    });
  });

  it('refuses a URL in the home that is not core\'s, naming the file', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    writeHome(home, 'CORE_URL=core.invalid:1\nLOCALITAS_API_TOKEN=lt_node\n');
    await withEnv({ CORE_URL: undefined, LOCALITAS_API_TOKEN: undefined, LOCALITAS_HOME: home }, () => {
      assert.throws(() => LocalitasClient.default(), (e) => e instanceof ConfigError && e.message.includes('core.env'));
    });
  });
});
