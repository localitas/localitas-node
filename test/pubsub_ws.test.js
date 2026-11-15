// PubSubWS against a real WebSocket server in the test, speaking core's cache
// WebSocket protocol: a "connected" greeting, then JSON actions in and JSON
// events out.
const { PubSubWS } = require('../src/index');
const { WebSocketServer } = require('ws');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

describe('PubSubWS', () => {
  let server;
  let url;
  let actions;
  let waiters;
  let authHeaders;
  const clients = [];

  // Answers subscribe and watch the way core's cache app does: a
  // "subscribed" event (carrying the start point for a watch), then the
  // channel's next message.
  before(async () => {
    server = new WebSocketServer({ port: 0 });
    server.on('connection', (socket, req) => {
      authHeaders.push(req.headers.authorization);
      const send = (event) => socket.send(JSON.stringify(event));
      send({ type: 'connected', data: { cache: 'test' } });
      socket.on('message', (data) => {
        const action = JSON.parse(data.toString());
        actions.push(action);
        waiters.forEach((w) => w());
        const channel = action.channel;
        if (action.action === 'subscribe') {
          send({ type: 'subscribed', channel });
          send({ type: 'message', channel, seq: 1, value: 'hello' });
        } else if (action.action === 'watch') {
          const afterSeq = action.from_latest ? 5 : action.seq || 0;
          send({ type: 'subscribed', channel, seq: afterSeq });
          send({ type: 'message', channel, seq: afterSeq + 1, value: 'next' });
        }
      });
    });
    await new Promise((r) => server.on('listening', r));
    url = `ws://127.0.0.1:${server.address().port}/apps/cache/ws/test`;
  });

  after(async () => {
    clients.forEach((c) => c.close());
    server.clients.forEach((socket) => socket.terminate());
    await new Promise((r) => server.close(r));
  });

  beforeEach(() => {
    actions = [];
    waiters = [];
    authHeaders = [];
  });

  const connect = (opts = {}) => {
    const ps = new PubSubWS({ url, token: 't', ...opts });
    clients.push(ps);
    return ps;
  };

  // The first action of a kind on a channel the server got, whatever order
  // actions on different channels arrived in.
  const actionFor = (kind, channel) => new Promise((resolve, reject) => {
    const check = () => {
      const found = actions.find((a) => a.action === kind && a.channel === channel);
      if (found) resolve(found);
    };
    waiters.push(check);
    check();
    setTimeout(() => reject(new Error(`no ${kind} on ${channel}; got ${JSON.stringify(actions)}`)), 5000).unref();
  });

  const nextMessage = () => {
    const queue = [];
    const pending = [];
    const push = (msg) => (pending.length ? pending.shift()(msg) : queue.push(msg));
    const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => pending.push(r)));
    return { push, next };
  };

  it('subscribe sends the default batch size', async () => {
    const got = nextMessage();
    connect().subscribe('events', 'worker-1', got.push);

    assert.deepStrictEqual(await actionFor('subscribe', 'events'),
      { action: 'subscribe', channel: 'events', consumer: 'worker-1', count: 50 });
    assert.deepStrictEqual(await got.next(), { seq: 1, value: 'hello', channel: 'events' });
    assert.strictEqual(authHeaders[0], 'Bearer t');
  });

  it('watch and watchLatest send the batch size', async () => {
    const afterGot = nextMessage();
    const latestGot = nextMessage();
    const ps = connect({ batchSize: 7 });
    ps.watch('runs', 41, afterGot.push);
    ps.watchLatest('news', latestGot.push);

    assert.deepStrictEqual(await actionFor('watch', 'runs'), { action: 'watch', channel: 'runs', seq: 41, count: 7 });
    assert.deepStrictEqual(await afterGot.next(), { seq: 42, value: 'next', channel: 'runs' });
    assert.deepStrictEqual(await actionFor('watch', 'news'), { action: 'watch', channel: 'news', from_latest: true, count: 7 });
    assert.deepStrictEqual(await latestGot.next(), { seq: 6, value: 'next', channel: 'news' });
  });
});
