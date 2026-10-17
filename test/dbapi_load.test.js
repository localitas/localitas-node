const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Database } = require('../src/index');

describe('Database', () => {
  it('constructs its client when loaded through the package entry point', () => {
    const db = new Database('db_1', { host: 'localhost:1', token: 'lt_test' });
    assert.strictEqual(typeof db._client.sqlExec, 'function');
  });
});
