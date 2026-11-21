const {
  LocalitasClient, CreateAutomationRequest, DAGConfig, DAGNode, TriggerConfig, PeriodicTrigger, EventTrigger,
  HTTPSettings, Sensor, httpNode, sensorNode, appCall, eventSensor, timeSensor, fileSensor, pubsubSensor,
} = require('../src/index');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert');

// fixtures/sdk_automation_request.json must stay identical to core's
// core/go/internal/apps/automation/testdata/sdk_automation_request.json,
// which core's strict decoder round-trips.
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sdk_automation_request.json'), 'utf8'));

const wire = (v) => JSON.parse(JSON.stringify(v));

function nightlySync() {
  const description = 'Sync, wait for its follow-ups, report';
  return new CreateAutomationRequest({
    name: 'nightly-sync',
    description,
    triggerType: 'periodic',
    isEnabled: true,
    triggerConfig: new TriggerConfig({
      periodic: new PeriodicTrigger('0 3 * * *', { timezone: 'Europe/Paris', catchup: 'all', catchupWindow: '48h' }),
      retries: 1,
      retryDelay: '5m',
      maxActiveRuns: 2,
      sla: '2h',
    }),
    dagConfig: new DAGConfig({
      dagId: 'nightly-sync',
      name: 'nightly-sync',
      description,
      nodes: [
        httpNode('fetch', 'any_node', new HTTPSettings({ app: appCall('weather', '/api/sync'), method: 'POST', deferrable: false }),
          { retries: 2, retryDelay: '30s', pool: 'net', poolSlots: 2, triggerRule: 'all_success' }),
        sensorNode('wait_event', 'any_node', eventSensor('invoice.paid', { timeout: '1h' }),
          { dependencies: ['fetch'], dependsOnPast: true, triggerRule: 'all_done' }),
        sensorNode('wait_time', 'any_node', timeSensor('15m'), { dependencies: ['fetch'] }),
        sensorNode('wait_file', 'all_nodes', fileSensor(['/Documents/inbox']), { dependencies: ['fetch'] }),
        sensorNode('wait_paid', 'any_node',
          pubsubSensor('orders', { match: { status: 'paid', 'order.total': 100 }, cache: 'localitas_automations', timeout: '2h' }),
          { dependencies: ['fetch'], priorityWeight: 10 }),
        httpNode('report', 'any_node', new HTTPSettings({ url: 'https://example.com/hook', body: { ok: true } }),
          { dependencies: ['wait_event', 'wait_time', 'wait_file', 'wait_paid'], triggerRule: 'one_success' }),
      ],
    }),
  });
}

describe('typed automation requests', () => {
  it("build core's golden request", () => {
    assert.deepStrictEqual(wire(nightlySync()), FIXTURE);
  });

  it('send priority_weight and the pubsub sensor in their phase D shape', () => {
    const node = sensorNode('wait_paid', 'any_node',
      pubsubSensor('orders', { cache: 'shop', match: { 'order.status': 'paid', total: 3 }, timeout: '10m' }),
      { priorityWeight: 5 });
    assert.deepStrictEqual(wire(node), {
      node_id: 'wait_paid',
      node_type: 'sensor',
      execution_strategy: 'any_node',
      priority_weight: 5,
      metadata: { wait_for: 'pubsub', channel: 'orders', cache: 'shop', match: { 'order.status': 'paid', total: 3 }, timeout: '10m' },
    });
    assert.deepStrictEqual(wire(pubsubSensor('orders')), { wait_for: 'pubsub', channel: 'orders' });
  });

  it('send every HTTP setting and event trigger field set', () => {
    const settings = new HTTPSettings({
      url: '/api/notifications', method: 'POST', contentType: 'application/json', headers: { 'X-A': '1' }, body: [1, 'two'],
      timeoutMs: 5000, maxRetries: 0, backoffMs: 0, backoffMultiplier: 1.5, maxBackoffMs: 9000, expectedStatus: 201,
      asyncTimeoutMs: 60000, deferrable: true, vaultCredentialId: 'cred_1', vaultAuthFormat: 'bearer',
      vaultHeaderName: 'X-Key', vaultHeaderPrefix: 'Key ',
    });
    assert.deepStrictEqual(wire(settings), {
      url: '/api/notifications', method: 'POST', content_type: 'application/json', headers: { 'X-A': '1' }, body: [1, 'two'],
      timeout_ms: 5000, max_retries: 0, backoff_ms: 0, backoff_multiplier: 1.5, max_backoff_ms: 9000, expected_status: 201,
      async_timeout_ms: 60000, deferrable: true, vault_credential_id: 'cred_1', vault_auth_format: 'bearer',
      vault_header_name: 'X-Key', vault_header_prefix: 'Key ',
    });
    const trigger = new EventTrigger('file.created', { eventFilter: { ext: 'pdf' }, debounceMs: 500, timeoutMinutes: 3, paths: ['/Inbox'] });
    assert.deepStrictEqual(wire(new TriggerConfig({ event: trigger })), {
      event: { event_type: 'file.created', event_filter: { ext: 'pdf' }, debounce_ms: 500, timeout_minutes: 3, paths: ['/Inbox'] },
    });
    assert.deepStrictEqual(wire(new CreateAutomationRequest({ name: 'n', triggerType: 'manual', nodeId: 'node-a', dagConfig: new DAGConfig({ dagId: 'd', nodes: [] }) })),
      { name: 'n', trigger_type: 'manual', node_id: 'node-a', dag_config: { dag_id: 'd', name: 'd', nodes: [] } });
  });

  it('refuse values core would refuse, at build time', () => {
    const http1 = () => new HTTPSettings({ url: 'https://example.com' });
    const refused = {
      'unknown strategy': () => httpNode('a', 'leader', http1()),
      'unknown trigger rule': () => httpNode('a', 'any_node', http1(), { triggerRule: 'any_success' }),
      'retries over 10': () => httpNode('a', 'any_node', http1(), { retries: 11 }),
      'negative retries': () => httpNode('a', 'any_node', http1(), { retries: -1 }),
      'fractional retries': () => httpNode('a', 'any_node', http1(), { retries: 1.5 }),
      'retry delay without unit': () => httpNode('a', 'any_node', http1(), { retryDelay: '30' }),
      'zero pool slots': () => httpNode('a', 'any_node', http1(), { poolSlots: 0 }),
      'fractional priority weight': () => httpNode('a', 'any_node', http1(), { priorityWeight: 0.5 }),
      'no node id': () => httpNode('', 'any_node', http1()),
      'url and app': () => new HTTPSettings({ url: 'https://example.com', app: appCall('weather', '/x') }),
      'neither url nor app': () => new HTTPSettings({ method: 'GET' }),
      'bad app name': () => appCall('Weather', '/x'),
      'app path that is an address': () => appCall('weather', '//evil.test/x'),
      'unknown sensor wait': () => new Sensor('cron', {}),
      'bad sensor timeout': () => eventSensor('x', { timeout: 'soon' }),
      'bad time sensor delay': () => timeSensor('1 hour'),
      'file sensor without paths': () => fileSensor([]),
      'pubsub sensor without channel': () => pubsubSensor(''),
      'unknown catchup': () => new PeriodicTrigger('* * * * *', { catchup: 'some' }),
      'bad catchup window': () => new PeriodicTrigger('* * * * *', { catchupWindow: '2d' }),
      'bad trigger retry delay': () => new TriggerConfig({ retryDelay: '5 minutes' }),
      'bad sla': () => new TriggerConfig({ sla: 'h' }),
      'a plain object for a node': () => new DAGConfig({ dagId: 'd', nodes: [{ node_id: 'a' }] }),
    };
    for (const [name, build] of Object.entries(refused)) {
      assert.throws(build, TypeError, name);
    }
    assert.ok(httpNode('a', 'raft_leader', http1(), { retryDelay: '1h30m', retries: 0 }) instanceof DAGNode);
  });

  it('refuse a url naming this machine, naming an AppCall instead', () => {
    // Core refuses each: stored in a replicated automation, it sends
    // whichever node runs the step to itself.
    for (const url of ['http://localhost:9204/api/sync', 'http://LOCALHOST:8090/apps/faas/fn/report',
      'http://127.0.0.2:9204/api/sync', 'http://[::1]:8090/apps/notes/api/notes', 'http://0.0.0.0:9204/api/sync']) {
      assert.throws(() => new HTTPSettings({ url }), /AppCall.*AppRef/, url);
    }
    assert.throws(() => new HTTPSettings({ url: 'ftp://a.test/b' }), TypeError);
    for (const url of ['/apps/faas/fn/report', 'https://hooks.example.com/done', 'http://192.168.1.50:8080/hook',
      '{{lookup.response.url}}']) {
      assert.deepStrictEqual(new HTTPSettings({ url }).toJSON(), { url }, url);
    }
  });

  it('create posts the request and returns the automation', async () => {
    let got;
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        got = { method: req.method, path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'auto_1', name: got.body.name }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const client = new LocalitasClient(`http://127.0.0.1:${server.address().port}`, 'lt_a');
      assert.deepStrictEqual(await client.automation().create(nightlySync()), { id: 'auto_1', name: 'nightly-sync' });
      assert.deepStrictEqual([got.method, got.path, got.auth], ['POST', '/apps/automation/api/automations', 'Bearer lt_a']);
      assert.deepStrictEqual(got.body, FIXTURE);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
