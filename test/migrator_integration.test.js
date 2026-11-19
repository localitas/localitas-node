/**
 * Migrators on both nodes of the integration cluster racing one migration.
 * Requires the integration cluster running (make integration-cluster-start).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalitasClient, Migrator } = require('../src/index');

const NODE_URLS = ['http://localhost:9090', 'http://localhost:9190'];
// The integration cluster's seeded API token for alice@test.local
// (core seeds/005_integ_api_token.sql).
const INTEG_TOKEN = 'lt_integ_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

describe('racing migrators', () => {
  const clients = NODE_URLS.map((url) => new LocalitasClient(url).withToken(INTEG_TOKEN));
  let dbId;
  let dir;

  before(async () => {
    dbId = (await clients[0].createDatabase(`node_migrace_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`)).id;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrace-'));
    fs.writeFileSync(path.join(dir, '20260101-000000-000-items.sql'),
      "CREATE TABLE items (name TEXT); INSERT INTO items (name) VALUES ('default');");
  });

  after(async () => {
    await clients[0].deleteDatabase(dbId);
  });

  // Both nodes find the migration pending and commit it at once: core applies
  // the first entry in its log and skips the second on its condition, so the
  // data migration applies once and neither write fails.
  it('apply a migration once without a failed write', async () => {
    let arrived = 0;
    let release;
    const allArrived = new Promise((resolve) => { release = resolve; });
    const answers = [];
    const migrators = clients.map((client) => {
      const m = Migrator.forDatabase(dir, client, dbId);
      const commit = m._execTx;
      m._execTx = async (stmts, unlessExists) => {
        arrived += 1;
        if (arrived === clients.length) release();
        await allArrived;
        const result = await commit(stmts, unlessExists);
        answers.push(result);
        return result;
      };
      return m;
    });

    await Promise.all(migrators.map((m) => m.run()));

    assert.strictEqual(answers.length, 2);
    assert.strictEqual(answers.filter((a) => a && a.skipped).length, 1, JSON.stringify(answers));
    for (const client of clients) {
      const res = await client.sqlQuery(dbId,
        'SELECT (SELECT group_concat(name) FROM items), (SELECT group_concat(version) FROM schema_migrations)');
      assert.deepStrictEqual(res.rows, [['default', '20260101-000000-000']]);
    }
  });
});
