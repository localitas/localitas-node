// Unit tests for the cache client against a fake that answers in core's wire
// shape: data endpoints wrap their payload as {"error":"","result":...},
// misses are 404s carrying that envelope, an unknown cache is a plain-text
// 404, and create/delete cache answer unwrapped JSON.
const { LocalitasClient, APIError } = require('../src/index');
const http = require('http');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const BASE = '/apps/cache/api/caches/test';
const ok = (result) => [200, JSON.stringify({ error: '', result })];
const miss = (msg) => [404, JSON.stringify({ error: msg, result: null })];
const fail = (status, msg) => [status, JSON.stringify({ error: msg, result: null })];
const UNKNOWN_CACHE = [404, 'cache "test" not found'];

describe('cache client', () => {
  let server;
  let client;
  let routes;
  let calls;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const [path, query = ''] = req.url.split('?');
        calls.push({ method: req.method, path, query, body });
        const [status, payload] = routes[`${req.method} ${path}`] || [404, '404 page not found'];
        res.writeHead(status, { 'Content-Type': payload.startsWith('{') ? 'application/json' : 'text/plain' });
        res.end(payload);
      });
    });
    await new Promise((r) => server.listen(0, r));
    client = new LocalitasClient(`http://127.0.0.1:${server.address().port}`).withToken('t');
  });

  after(() => server.close());

  beforeEach(() => {
    routes = {};
    calls = [];
  });

  const route = (method, path, reply) => { routes[`${method} ${path}`] = reply; };
  const last = () => calls[calls.length - 1];
  const rejectsWith = (promise, status) =>
    assert.rejects(promise, (e) => e instanceof APIError && e.statusCode === status);

  it('kv methods unwrap the result', async () => {
    const stats = { name: 'test', hits: 1, misses: 1, sets: 3, deletes: 0, evictions: 0, key_count: 3, hit_rate: 50 };
    route('GET', `${BASE}/keys/k1`, ok({ key: 'k1', value: 'v1', ttl_remaining: 300 }));
    route('PUT', `${BASE}/keys/k1`, [201, JSON.stringify({ error: '', result: { status: 'ok' } })]);
    route('DELETE', `${BASE}/keys/k1`, ok({ status: 'deleted' }));
    route('POST', `${BASE}/keys/incr/counter`, ok({ key: 'counter', value: 4 }));
    route('POST', `${BASE}/keys/incrttl/rate`, ok({ key: 'rate', value: 3 }));
    route('POST', `${BASE}/keys/setnx/lock`, ok({ acquired: true, key: 'lock' }));
    route('GET', `${BASE}/keys`, ok({ keys: ['user:1', 'user:2'] }));
    route('POST', `${BASE}/flush`, ok({ status: 'flushed' }));
    route('GET', `${BASE}/stats`, ok(stats));
    const cache = client.cache('test');

    assert.strictEqual(await cache.get('k1'), 'v1');
    await cache.set('k1', 'v1', 300);
    assert.deepStrictEqual(JSON.parse(last().body), { value: 'v1', ttl: 300 });
    await cache.del('k1');
    assert.strictEqual(await cache.incr('counter', 0), 4);
    assert.deepStrictEqual(JSON.parse(last().body), { delta: 0 });
    assert.strictEqual(await cache.incrWithTTL('rate', 2, 60), 3);
    assert.strictEqual(await cache.setNX('lock', 'owner-a', 60), true);
    assert.deepStrictEqual(await cache.keys('user:*'), ['user:1', 'user:2']);
    assert.strictEqual(last().query, 'pattern=user%3A*');
    await cache.flush();
    assert.deepStrictEqual(await cache.stats(), stats);
  });

  it('escapes keys', async () => {
    const cache = client.cache('test');
    for (const key of ['q?x=1#frag', 'a/b/c', 'sp ace%']) {
      const k = encodeURIComponent(key);
      route('GET', `${BASE}/keys/${k}`, ok({ key, value: 'v', ttl_remaining: -1 }));
      route('PUT', `${BASE}/keys/${k}`, ok({ status: 'ok' }));
      route('DELETE', `${BASE}/keys/${k}`, ok({ status: 'deleted' }));
      route('POST', `${BASE}/keys/incr/${k}`, ok({ key, value: 1 }));
      route('POST', `${BASE}/keys/incrttl/${k}`, ok({ key, value: 1 }));
      route('POST', `${BASE}/keys/setnx/${k}`, ok({ acquired: true, key }));

      assert.strictEqual(await cache.get(key), 'v');
      await cache.set(key, 'v');
      await cache.del(key);
      assert.strictEqual(await cache.incr(key), 1);
      assert.strictEqual(await cache.incrWithTTL(key), 1);
      assert.strictEqual(await cache.setNX(key, 'v'), true);
      for (const call of calls.slice(-6)) {
        assert.strictEqual(decodeURIComponent(call.path.split('/').pop()), key);
      }
    }
  });

  it('reads an absent key as null and raises everything else', async () => {
    route('GET', `${BASE}/keys/absent`, miss('key not found'));
    route('GET', `${BASE}/keys/k`, UNKNOWN_CACHE);
    route('PUT', `${BASE}/keys/k`, UNKNOWN_CACHE);
    route('POST', `${BASE}/keys/incr/word`, fail(400, 'value is not an integer'));
    route('GET', `${BASE}/keys/busy`, fail(500, 'raft: not ready'));
    const cache = client.cache('test');

    assert.strictEqual(await cache.get('absent'), null);
    await rejectsWith(cache.get('k'), 404);
    await rejectsWith(cache.set('k', 'v'), 404);
    await rejectsWith(cache.incr('word'), 400);
    await rejectsWith(cache.get('busy'), 500);
  });

  it('rejects a response without the envelope', async () => {
    route('GET', `${BASE}/keys/k`, [200, JSON.stringify({ key: 'k', value: 'v' })]);
    await assert.rejects(client.cache('test').get('k'), /no result envelope/);
  });

  it('listCaches unwraps the result; create/delete answer unwrapped', async () => {
    const caches = [{ hit_rate: 0, key_count: 0, name: 'localitas_public_http_paths' }, { hit_rate: 50, key_count: 3, name: 'sessions' }];
    route('GET', '/apps/cache/api/caches', ok({ caches }));
    route('POST', '/apps/cache/api/caches', [201, JSON.stringify({ created_at: 1, name: 'new' })]);
    route('DELETE', '/apps/cache/api/caches/a%2Fb', [200, JSON.stringify({ status: 'deleted' })]);

    assert.deepStrictEqual(await client.listCaches(), caches);
    await client.createCache('new');
    assert.deepStrictEqual(JSON.parse(last().body), { name: 'new' });
    await client.deleteCache('a/b');
  });

  it('cache management failures raise', async () => {
    route('POST', '/apps/cache/api/caches', [409, 'cache already exists']);
    route('DELETE', '/apps/cache/api/caches/localitas_public_http_paths', [403, 'cannot delete']);
    route('GET', '/apps/cache/api/caches', [500, 'boom']);
    await rejectsWith(client.createCache('dup'), 409);
    await rejectsWith(client.deleteCache('localitas_public_http_paths'), 403);
    await rejectsWith(client.listCaches(), 500);
  });

  it('sorted set unwraps the result and surfaces real errors', async () => {
    const z = `${BASE}/zsets/board`;
    route('POST', `${z}/add`, ok({ added: 0 }));
    route('GET', z, ok({ count: 1, entries: [{ member: 'bob', score: 150 }] }));
    route('GET', `${z}/score/a%2Fb`, ok({ score: 150 }));
    route('GET', `${z}/rank/alice`, ok({ rank: 2 }));
    route('POST', `${z}/rem`, ok({ removed: 1 }));
    route('POST', `${z}/incrby`, ok({ member: 'carol', score: 202.5 }));
    route('GET', `${z}/score/nobody`, miss('member not found'));
    route('GET', `${z}/rank/nobody`, miss('member not found'));
    route('GET', `${z}/score/bob`, fail(500, 'database is locked'));
    route('GET', `${z}/rank/bob`, UNKNOWN_CACHE);
    const lb = client.cache('test').sortedSet('board');

    assert.strictEqual(await lb.add(['bob', 150]), 0);
    assert.deepStrictEqual(await lb.range(0, -1), [{ member: 'bob', score: 150 }]);
    assert.strictEqual(await lb.score('a/b'), 150);
    assert.strictEqual(await lb.rank('alice'), 2);
    assert.strictEqual(await lb.rem('dave', 'nobody'), 1);
    assert.strictEqual(await lb.incrBy('carol', 2.5), 202.5);
    assert.strictEqual(await lb.score('nobody'), null);
    assert.strictEqual(await lb.rank('nobody'), -1);
    await rejectsWith(lb.score('bob'), 500);
    await rejectsWith(lb.rank('bob'), 404);
  });

  it('list, set, hash, queue and stack unwrap the result', async () => {
    route('POST', `${BASE}/lists/jobs/rpush`, ok({ length: 2 }));
    route('GET', `${BASE}/lists/jobs`, ok({ length: 2, values: ['a', 'b'] }));
    route('POST', `${BASE}/lists/jobs/lpop`, ok({ value: 'a' }));
    route('POST', `${BASE}/sets/tags/add`, ok({ added: 2 }));
    route('GET', `${BASE}/sets/tags`, ok({ count: 2, members: ['a', 'b'] }));
    route('GET', `${BASE}/hashes/user%3A1`, ok({ count: 1, fields: { name: 'Alicia' } }));
    route('GET', `${BASE}/hashes/user%3A1/fields/name`, ok({ value: 'Alicia' }));
    route('GET', `${BASE}/hashes/user%3A1/json`, ok({ json: '{"name":"Alicia"}' }));
    route('POST', `${BASE}/queues/q/enqueue`, ok({ length: 2 }));
    route('POST', `${BASE}/queues/q/dequeue`, ok({ value: '2' }));
    route('POST', `${BASE}/stacks/s/push`, ok({ length: 2 }));
    route('GET', `${BASE}/stacks/s`, ok({ length: 2, value: 'c' }));
    const cache = client.cache('test');

    assert.strictEqual(await cache.list('jobs').rpush('a', 'b'), 2);
    assert.deepStrictEqual(await cache.list('jobs').range(), ['a', 'b']);
    assert.strictEqual(await cache.list('jobs').lpop(), 'a');
    assert.strictEqual(await cache.setStore('tags').add('b', 'a', 'a'), 2);
    assert.deepStrictEqual(await cache.setStore('tags').members(), ['a', 'b']);
    assert.deepStrictEqual(await cache.hash('user:1').getAll(), { name: 'Alicia' });
    assert.strictEqual(await cache.hash('user:1').get('name'), 'Alicia');
    assert.strictEqual(await cache.hash('user:1').toJSON(), '{"name":"Alicia"}');
    assert.strictEqual(await cache.queue('q', 2).enqueue('3'), 2);
    assert.deepStrictEqual(JSON.parse(last().body), { value: '3', max_size: 2 });
    assert.strictEqual(await cache.queue('q').dequeue(), '2');
    assert.strictEqual(await cache.stack('s', 2).push('c'), 2);
    assert.strictEqual(await cache.stack('s').peek(), 'c');
  });

  it('empty structures read as null; an unknown cache or bad input raises', async () => {
    route('POST', `${BASE}/lists/jobs/lpop`, miss('list is empty'));
    route('POST', `${BASE}/queues/q/dequeue`, miss('queue is empty'));
    route('POST', `${BASE}/stacks/s/pop`, miss('stack is empty'));
    route('GET', `${BASE}/hashes/h/fields/nope`, miss('field not found'));
    route('POST', `${BASE}/lists/jobs/rpop`, UNKNOWN_CACHE);
    route('PUT', `${BASE}/hashes/h/json`, fail(400, 'invalid JSON'));
    const cache = client.cache('test');

    assert.strictEqual(await cache.list('jobs').lpop(), null);
    assert.strictEqual(await cache.queue('q').dequeue(), null);
    assert.strictEqual(await cache.stack('s').pop(), null);
    assert.strictEqual(await cache.hash('h').get('nope'), null);
    await rejectsWith(cache.list('jobs').rpop(), 404);
    await rejectsWith(cache.hash('h').fromJSON('{not json'), 400);
  });

  it('pubsub unwraps the result; an unknown group is a 404', async () => {
    const ps = `${BASE}/pubsub/events`;
    const msgs = [{ seq: 1, value: 'first', created_at: 100 }];
    route('POST', `${ps}/publish`, ok({ seq: 7 }));
    route('GET', `${ps}/read`, ok({ count: 1, messages: msgs }));
    route('POST', `${ps}/group/workers`, [201, JSON.stringify({ error: '', result: { status: 'created' } })]);
    route('POST', `${ps}/group/workers/claim`, ok({ message: { seq: 2, value: 'job-1', created_at: 102 } }));
    route('POST', `${ps}/group/idle/claim`, ok({ message: null }));
    route('POST', `${ps}/group/workers/ack`, ok({ status: 'acked' }));
    route('POST', `${ps}/group/nope/claim`, miss('not found: group "nope" on channel "events"'));
    const ch = client.cache('test').pubSub('events', { maxSize: 2 });

    assert.strictEqual(await ch.publish('first'), 7);
    assert.deepStrictEqual(JSON.parse(last().body), { value: 'first', max_size: 2 });
    assert.deepStrictEqual(await ch.read('reader 1', 10), msgs);
    assert.strictEqual(last().query, 'consumer=reader%201&count=10');
    await ch.createGroup('workers');
    assert.deepStrictEqual(await ch.claim('workers', 'w1'), { seq: 2, value: 'job-1', created_at: 102 });
    assert.strictEqual(await ch.claim('idle', 'w1'), null);
    await ch.ack('workers', 2);
    await rejectsWith(ch.claim('nope', 'w1'), 404);
  });
});
