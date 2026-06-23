/**
 * Integration tests for cache client. Requires integration cluster running.
 *
 * Run: make integration-cluster-start && node test/cache_integration.test.js
 */

const { LocalitasClient } = require('../src/index.js');
const assert = require('assert');

const INTEG_URL = 'http://localhost:9090';
const INTEG_TOKEN = Buffer.from(JSON.stringify({
  user_id: '11111111-1111-1111-1111-111111111111',
  email: 'alice@test.local',
  name: 'Alice Admin',
})).toString('base64');

function makeClient() {
  return new LocalitasClient(INTEG_URL).withToken(INTEG_TOKEN);
}

function uniqueName(prefix = 'integ') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

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

async function withCache(prefix, fn) {
  const client = makeClient();
  const name = uniqueName(prefix);
  await client.createCache(name);
  try {
    await fn(client.cache(name));
  } finally {
    await client.deleteCache(name);
  }
}

async function main() {
  console.log('localitas-node cache integration tests\n');

  // KV
  await test('set and get', () => withCache('kv', async (cache) => {
    await cache.set('greeting', 'hello world', 300);
    const val = await cache.get('greeting');
    assert.strictEqual(val, 'hello world');
  }));

  await test('get miss returns null', () => withCache('kv', async (cache) => {
    const val = await cache.get('nonexistent');
    assert.strictEqual(val, null);
  }));

  await test('delete', () => withCache('kv', async (cache) => {
    await cache.set('k', 'v');
    await cache.del('k');
    assert.strictEqual(await cache.get('k'), null);
  }));

  await test('incr', () => withCache('kv', async (cache) => {
    assert.strictEqual(await cache.incr('counter'), 1);
    assert.strictEqual(await cache.incr('counter'), 2);
    assert.strictEqual(await cache.incr('counter', 10), 12);
  }));

  await test('setNX', () => withCache('kv', async (cache) => {
    assert.strictEqual(await cache.setNX('lock', 'owner1', 60), true);
    assert.strictEqual(await cache.setNX('lock', 'owner2', 60), false);
  }));

  await test('keys pattern', () => withCache('kv', async (cache) => {
    await cache.set('user:1', 'a');
    await cache.set('user:2', 'b');
    await cache.set('config:x', 'c');
    const keys = await cache.keys('user:*');
    assert.strictEqual(keys.length, 2);
  }));

  // List
  await test('list push and range', () => withCache('list', async (cache) => {
    const lst = cache.list('q');
    await lst.rpush('a', 'b', 'c');
    await lst.lpush('z');
    const items = await lst.range(0, -1);
    assert.deepStrictEqual(items, ['z', 'a', 'b', 'c']);
  }));

  await test('list pop', () => withCache('list', async (cache) => {
    const lst = cache.list('q');
    await lst.rpush('a', 'b', 'c');
    assert.strictEqual(await lst.lpop(), 'a');
    assert.strictEqual(await lst.rpop(), 'c');
  }));

  // Set
  await test('set add and members', () => withCache('set', async (cache) => {
    const s = cache.setStore('tags');
    const added = await s.add('go', 'rust', 'python', 'go');
    assert.strictEqual(added, 3);
    const members = await s.members();
    assert.deepStrictEqual(members.sort(), ['go', 'python', 'rust']);
  }));

  // Hash
  await test('hash set and get', () => withCache('hash', async (cache) => {
    const h = cache.hash('user');
    await h.set({ name: 'Alice', email: 'alice@test.com' });
    assert.strictEqual(await h.get('name'), 'Alice');
    const all = await h.getAll();
    assert.strictEqual(Object.keys(all).length, 2);
  }));

  await test('hash toJSON', () => withCache('hash', async (cache) => {
    const h = cache.hash('user');
    await h.set({ name: 'Bob' });
    const j = await h.toJSON();
    const parsed = JSON.parse(j);
    assert.strictEqual(parsed.name, 'Bob');
  }));

  // Sorted Set
  await test('sorted set add and range', () => withCache('zset', async (cache) => {
    const lb = cache.sortedSet('lb');
    await lb.add(['alice', 100], ['bob', 200], ['charlie', 50]);
    const entries = await lb.range(0, -1);
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].member, 'charlie');
  }));

  await test('sorted set score and rank', () => withCache('zset', async (cache) => {
    const lb = cache.sortedSet('lb');
    await lb.add(['alice', 100], ['bob', 200]);
    assert.strictEqual(await lb.score('alice'), 100);
    assert.strictEqual(await lb.rank('bob'), 1);
  }));

  // Queue
  await test('queue FIFO', () => withCache('queue', async (cache) => {
    const q = cache.queue('jobs');
    await q.enqueue('first');
    await q.enqueue('second');
    assert.strictEqual(await q.dequeue(), 'first');
    assert.strictEqual(await q.peek(), 'second');
  }));

  // Stack
  await test('stack LIFO', () => withCache('stack', async (cache) => {
    const s = cache.stack('undo');
    await s.push('action1');
    await s.push('action2');
    assert.strictEqual(await s.pop(), 'action2');
    assert.strictEqual(await s.peek(), 'action1');
  }));

  // PubSub
  await test('pubsub publish and read', () => withCache('pubsub', async (cache) => {
    const ch = cache.pubSub('events', { maxSize: 100 });
    const seq = await ch.publish('{"type":"test"}');
    assert.ok(seq > 0);
    const msgs = await ch.read('consumer-1', 10);
    assert.strictEqual(msgs.length, 1);
  }));

  await test('pubsub cursor advances', () => withCache('pubsub', async (cache) => {
    const ch = cache.pubSub('events');
    await ch.publish('msg1');
    await ch.publish('msg2');
    const msgs1 = await ch.read('c1', 10);
    assert.strictEqual(msgs1.length, 2);
    await ch.publish('msg3');
    const msgs2 = await ch.read('c1', 10);
    assert.strictEqual(msgs2.length, 1);
  }));

  await test('pubsub consumer group', () => withCache('pubsub', async (cache) => {
    const ch = cache.pubSub('jobs');
    await ch.createGroup('workers');
    await ch.publish('job1');
    const msg = await ch.claim('workers', 'w1');
    assert.ok(msg);
    assert.strictEqual(msg.value, 'job1');
    await ch.ack('workers', msg.seq);
  }));

  // WebSocket tests
  let WebSocket;
  try {
    WebSocket = require('ws');
  } catch (e) {
    console.log('\n  SKIP: ws module not installed, skipping WebSocket tests');
  }

  if (WebSocket) {
    await test('websocket subscribe and publish', () => withCache('ws', async (cache) => {
      const name = cache._name;
      const wsUrl = `ws://localhost:9090/apps/cache/ws/${name}?token=${INTEG_TOKEN}`;

      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);

        let step = 0;
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());

          if (step === 0) {
            assert.strictEqual(msg.type, 'connected');
            ws.send(JSON.stringify({ action: 'subscribe', channel: 'ws-test', consumer: 'node-test' }));
            step++;
          } else if (step === 1) {
            assert.strictEqual(msg.type, 'subscribed');
            ws.send(JSON.stringify({ action: 'publish', channel: 'ws-test', value: '{"from":"node"}' }));
            step++;
          } else if (step === 2) {
            assert.strictEqual(msg.type, 'published');
            step++;
          } else if (step === 3) {
            assert.strictEqual(msg.type, 'message');
            assert.strictEqual(msg.value, '{"from":"node"}');
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        });
      });
    }));

    await test('websocket two clients broadcast', () => withCache('ws2', async (cache) => {
      const name = cache._name;
      const wsUrl = `ws://localhost:9090/apps/cache/ws/${name}?token=${INTEG_TOKEN}`;

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { reject(new Error('timeout')); }, 5000);
        const ws1 = new WebSocket(wsUrl);
        const ws2 = new WebSocket(wsUrl);
        let ws1Ready = false, ws2Ready = false, ws2Received = false;

        function bothReady() {
          if (!ws1Ready || !ws2Ready) return;
          ws1.send(JSON.stringify({ action: 'publish', channel: 'bcast', value: 'hello' }));
        }

        ws1.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'connected') {
            ws1.send(JSON.stringify({ action: 'subscribe', channel: 'bcast', consumer: 'c1' }));
          } else if (msg.type === 'subscribed') {
            ws1Ready = true;
            bothReady();
          }
        });

        ws2.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'connected') {
            ws2.send(JSON.stringify({ action: 'subscribe', channel: 'bcast', consumer: 'c2' }));
          } else if (msg.type === 'subscribed') {
            ws2Ready = true;
            bothReady();
          } else if (msg.type === 'message' && msg.value === 'hello') {
            ws2Received = true;
            clearTimeout(timeout);
            ws1.close();
            ws2.close();
            assert.ok(ws2Received, 'ws2 received broadcast');
            resolve();
          }
        });
      });
    }));
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
