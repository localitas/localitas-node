/**
 * Typed automation requests: each builder checks its values as core does and
 * serializes (toJSON) to exactly the wire JSON core's strict decoder reads.
 *
 * @example
 *   const req = new CreateAutomationRequest({
 *     name: 'nightly-sync',
 *     triggerType: 'periodic',
 *     triggerConfig: new TriggerConfig({ periodic: new PeriodicTrigger('0 3 * * *') }),
 *     dagConfig: new DAGConfig({
 *       dagId: 'nightly-sync',
 *       nodes: [httpNode('fetch', 'any_node', new HTTPSettings({ app: appCall('weather', '/api/sync'), method: 'POST' }))],
 *     }),
 *   });
 *   await client.automation().create(req);
 */

const { checkAppName, checkAppPath } = require('./address');

const STRATEGIES = ['raft_leader', 'any_node', 'all_nodes', 'local_only'];
const TRIGGER_RULES = ['all_success', 'all_done', 'one_success', 'one_failed', 'none_failed'];
const SENSOR_WAITS = ['event', 'file', 'time', 'pubsub'];
const CATCHUPS = ['latest', 'all'];
const DURATION = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;

const isSet = (v) => v !== undefined && v !== null;

function compact(wire) {
  const out = {};
  for (const [k, v] of Object.entries(wire)) if (isSet(v)) out[k] = v;
  return out;
}

function checkKeys(what, opts, allowed) {
  for (const k of Object.keys(opts)) {
    if (!allowed.includes(k)) throw new TypeError(`${what}: unknown field ${k}; known: ${allowed.join(', ')}`);
  }
}

function oneOf(what, value, allowed) {
  if (!allowed.includes(value)) throw new TypeError(`${what} ${JSON.stringify(value)} must be one of ${allowed.join(', ')}`);
  return value;
}

function duration(what, value) {
  if (!isSet(value)) return undefined;
  if (typeof value !== 'string' || !DURATION.test(value)) {
    throw new TypeError(`${what} ${JSON.stringify(value)} is not a duration such as "30s", "5m" or "1h30m"`);
  }
  return value;
}

function integer(what, value, min = -Infinity, max = Infinity) {
  if (!isSet(value)) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${what} ${JSON.stringify(value)} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function text(what, value, { required = false } = {}) {
  if (!isSet(value) && !required) return undefined;
  if (typeof value !== 'string' || !value) throw new TypeError(`${what} must be a non-empty string`);
  return value;
}

function bool(what, value) {
  if (!isSet(value)) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${what} must be true or false`);
  return value;
}

function strings(what, value, { required = false } = {}) {
  if (!isSet(value) && !required) return undefined;
  if (!Array.isArray(value) || (required && value.length === 0) || value.some((s) => typeof s !== 'string' || !s)) {
    throw new TypeError(`${what} must be ${required ? 'a non-empty' : 'an'} array of non-empty strings`);
  }
  return value;
}

function object(what, value) {
  if (!isSet(value)) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${what} must be an object`);
  return value;
}

function instance(what, value, cls, { required = false } = {}) {
  if (!isSet(value) && !required) return undefined;
  if (!(value instanceof cls)) throw new TypeError(`${what} must be a ${cls.name}`);
  return value;
}

/** An app's endpoint by name, never by address: { app, path, protocol: 'http' }. */
class AppCall {
  constructor(app, path) {
    this.app = checkAppName(app);
    this.path = checkAppPath(path);
    this.protocol = 'http';
  }

  toJSON() {
    return { app: this.app, path: this.path, protocol: this.protocol };
  }
}

/** The AppCall for an app's endpoint. */
function appCall(app, path) {
  return new AppCall(app, path);
}

const HTTP_FIELDS = ['url', 'app', 'method', 'contentType', 'headers', 'body', 'timeoutMs', 'maxRetries', 'backoffMs',
  'backoffMultiplier', 'maxBackoffMs', 'expectedStatus', 'asyncTimeoutMs', 'deferrable', 'vaultCredentialId',
  'vaultAuthFormat', 'vaultHeaderName', 'vaultHeaderPrefix'];

/** An http-api task's call: to exactly one of url or app (an AppCall). */
class HTTPSettings {
  constructor(opts = {}) {
    checkKeys('HTTPSettings', opts, HTTP_FIELDS);
    if (isSet(opts.url) === isSet(opts.app)) throw new TypeError('HTTPSettings needs exactly one of url and app');
    if (isSet(opts.backoffMultiplier) && typeof opts.backoffMultiplier !== 'number') {
      throw new TypeError('HTTPSettings backoffMultiplier must be a number');
    }
    const headers = object('HTTPSettings headers', opts.headers);
    if (headers && Object.values(headers).some((v) => typeof v !== 'string')) {
      throw new TypeError('HTTPSettings headers must map names to strings');
    }
    this._wire = compact({
      url: text('HTTPSettings url', opts.url),
      app: instance('HTTPSettings app', opts.app, AppCall),
      method: text('HTTPSettings method', opts.method),
      content_type: text('HTTPSettings contentType', opts.contentType),
      headers,
      body: opts.body,
      timeout_ms: integer('HTTPSettings timeoutMs', opts.timeoutMs, 0),
      max_retries: integer('HTTPSettings maxRetries', opts.maxRetries, 0),
      backoff_ms: integer('HTTPSettings backoffMs', opts.backoffMs, 0),
      backoff_multiplier: opts.backoffMultiplier,
      max_backoff_ms: integer('HTTPSettings maxBackoffMs', opts.maxBackoffMs, 0),
      expected_status: integer('HTTPSettings expectedStatus', opts.expectedStatus, 100, 599),
      async_timeout_ms: integer('HTTPSettings asyncTimeoutMs', opts.asyncTimeoutMs, 0),
      deferrable: bool('HTTPSettings deferrable', opts.deferrable),
      vault_credential_id: text('HTTPSettings vaultCredentialId', opts.vaultCredentialId),
      vault_auth_format: text('HTTPSettings vaultAuthFormat', opts.vaultAuthFormat),
      vault_header_name: text('HTTPSettings vaultHeaderName', opts.vaultHeaderName),
      vault_header_prefix: text('HTTPSettings vaultHeaderPrefix', opts.vaultHeaderPrefix),
    });
  }

  toJSON() {
    return this._wire;
  }
}

/** What a sensor task waits for: wait_for 'event', 'file', 'time' or 'pubsub'. */
class Sensor {
  constructor(waitFor, fields = {}) {
    oneOf('sensor wait_for', waitFor, SENSOR_WAITS);
    checkKeys('Sensor', fields, ['eventType', 'paths', 'delay', 'channel', 'cache', 'match', 'timeout']);
    this._wire = compact({
      wait_for: waitFor,
      event_type: text('event sensor eventType', fields.eventType, { required: waitFor === 'event' }),
      paths: strings('file sensor paths', fields.paths, { required: waitFor === 'file' }),
      delay: duration('sensor delay', text('time sensor delay', fields.delay, { required: waitFor === 'time' })),
      channel: text('pubsub sensor channel', fields.channel, { required: waitFor === 'pubsub' }),
      cache: text('pubsub sensor cache', fields.cache),
      match: object('pubsub sensor match', fields.match),
      timeout: duration('sensor timeout', fields.timeout),
    });
  }

  toJSON() {
    return this._wire;
  }
}

/** Wait for an event of eventType published to the automation app. */
function eventSensor(eventType, { timeout } = {}) {
  return new Sensor('event', { eventType, timeout });
}

/** Wait delay (a duration) after the run's logical time. */
function timeSensor(delay, { timeout } = {}) {
  return new Sensor('time', { delay, timeout });
}

/** Wait for a change under one of paths, on the node the task is pinned to. */
function fileSensor(paths, { timeout } = {}) {
  return new Sensor('file', { paths, timeout });
}

/**
 * Wait for a message on a pub/sub channel of cache (core's default when
 * unset) whose fields equal match ({field: JSON value}; a dotted field
 * reaches into nested objects).
 */
function pubsubSensor(channel, { match, cache, timeout } = {}) {
  return new Sensor('pubsub', { channel, match, cache, timeout });
}

const NODE_FIELDS = ['dependencies', 'retries', 'retryDelay', 'pool', 'poolSlots', 'priorityWeight', 'dependsOnPast', 'triggerRule'];

/** A DAG task. Built by httpNode and sensorNode. */
class DAGNode {
  constructor(nodeId, nodeType, strategy, metadata, fields = {}) {
    checkKeys('DAGNode', fields, NODE_FIELDS);
    this._wire = compact({
      node_id: text('node id', nodeId, { required: true }),
      node_type: text('node type', nodeType, { required: true }),
      execution_strategy: oneOf('execution_strategy', strategy, STRATEGIES),
      dependencies: strings('dependencies', fields.dependencies),
      retries: integer('retries', fields.retries, 0, 10),
      retry_delay: duration('retry_delay', fields.retryDelay),
      pool: text('pool', fields.pool),
      pool_slots: integer('pool_slots', fields.poolSlots, 1),
      priority_weight: integer('priority_weight', fields.priorityWeight),
      depends_on_past: bool('depends_on_past', fields.dependsOnPast) ? true : undefined,
      trigger_rule: isSet(fields.triggerRule) ? oneOf('trigger_rule', fields.triggerRule, TRIGGER_RULES) : undefined,
      metadata,
    });
  }

  toJSON() {
    return this._wire;
  }
}

/** An http-api task: settings is an HTTPSettings; fields are the task's
 *  dependencies, retries, retryDelay, pool, poolSlots, priorityWeight,
 *  dependsOnPast and triggerRule. */
function httpNode(id, strategy, settings, fields = {}) {
  return new DAGNode(id, 'http-api', strategy, instance('httpNode settings', settings, HTTPSettings, { required: true }), fields);
}

/** A sensor task: sensor is a Sensor; fields as httpNode's. */
function sensorNode(id, strategy, sensor, fields = {}) {
  return new DAGNode(id, 'sensor', strategy, instance('sensorNode sensor', sensor, Sensor, { required: true }), fields);
}

/** A periodic trigger: a cron schedule read in timezone (UTC when unset). */
class PeriodicTrigger {
  constructor(schedule, opts = {}) {
    checkKeys('PeriodicTrigger', opts, ['timezone', 'timeoutMinutes', 'catchup', 'catchupWindow']);
    this._wire = compact({
      schedule: text('schedule', schedule, { required: true }),
      timezone: text('timezone', opts.timezone),
      timeout_minutes: integer('timeout_minutes', opts.timeoutMinutes, 0),
      catchup: isSet(opts.catchup) ? oneOf('catchup', opts.catchup, CATCHUPS) : undefined,
      catchup_window: duration('catchup_window', opts.catchupWindow),
    });
  }

  toJSON() {
    return this._wire;
  }
}

/** An event trigger: events of eventType, under paths for file events. */
class EventTrigger {
  constructor(eventType, opts = {}) {
    checkKeys('EventTrigger', opts, ['eventFilter', 'debounceMs', 'timeoutMinutes', 'paths']);
    const eventFilter = object('event_filter', opts.eventFilter);
    if (eventFilter && Object.values(eventFilter).some((v) => typeof v !== 'string')) {
      throw new TypeError('event_filter must map fields to strings');
    }
    this._wire = compact({
      event_type: text('event_type', eventType, { required: true }),
      event_filter: eventFilter,
      debounce_ms: integer('debounce_ms', opts.debounceMs, 0),
      timeout_minutes: integer('timeout_minutes', opts.timeoutMinutes, 0),
      paths: strings('paths', opts.paths),
    });
  }

  toJSON() {
    return this._wire;
  }
}

/** When an automation runs and how its runs are bounded. */
class TriggerConfig {
  constructor(opts = {}) {
    checkKeys('TriggerConfig', opts, ['periodic', 'event', 'retries', 'retryDelay', 'maxActiveRuns', 'sla']);
    this._wire = compact({
      periodic: instance('periodic', opts.periodic, PeriodicTrigger),
      event: instance('event', opts.event, EventTrigger),
      retries: integer('retries', opts.retries, 0),
      retry_delay: duration('retry_delay', opts.retryDelay),
      max_active_runs: integer('max_active_runs', opts.maxActiveRuns, 0),
      sla: duration('sla', opts.sla),
    });
  }

  toJSON() {
    return this._wire;
  }
}

/** An automation's DAG: its id, name (the id when unset) and DAGNodes. */
class DAGConfig {
  constructor(opts = {}) {
    checkKeys('DAGConfig', opts, ['dagId', 'name', 'description', 'nodes']);
    const nodes = opts.nodes || [];
    if (!Array.isArray(nodes) || nodes.some((n) => !(n instanceof DAGNode))) {
      throw new TypeError('DAGConfig nodes must be DAGNodes (httpNode, sensorNode)');
    }
    const dagId = text('dag_id', opts.dagId, { required: true });
    this._wire = compact({
      dag_id: dagId,
      name: text('dag name', opts.name) || dagId,
      description: text('dag description', opts.description),
      nodes,
    });
  }

  toJSON() {
    return this._wire;
  }
}

/** The body of POST /apps/automation/api/automations. nodeId is required by
 *  core for a local_only automation and sent only when set. */
class CreateAutomationRequest {
  constructor(opts = {}) {
    checkKeys('CreateAutomationRequest', opts, ['name', 'description', 'dagConfig', 'triggerType', 'triggerConfig', 'isEnabled', 'nodeId']);
    this._wire = compact({
      name: text('name', opts.name, { required: true }),
      description: text('description', opts.description),
      trigger_type: text('trigger_type', opts.triggerType),
      is_enabled: bool('is_enabled', opts.isEnabled),
      trigger_config: instance('trigger_config', opts.triggerConfig, TriggerConfig),
      dag_config: instance('dag_config', opts.dagConfig, DAGConfig, { required: true }),
      node_id: text('node_id', opts.nodeId),
    });
  }

  toJSON() {
    return this._wire;
  }
}

module.exports = {
  AppCall, appCall, HTTPSettings, Sensor, eventSensor, timeSensor, fileSensor, pubsubSensor,
  DAGNode, httpNode, sensorNode, PeriodicTrigger, EventTrigger, TriggerConfig, DAGConfig, CreateAutomationRequest,
};
