/**
 * Localitas Node.js SDK — mirrors the Go client at /client/client.go.
 *
 * Usage:
 *   const { LocalitasClient } = require('@localitas/client');
 *   const client = LocalitasClient.default();
 *   const notes = client.db('notes');
 *   const forecast = await client.app('weather').get('/api/forecast');
 *   client.cache('events').subscribe('orders', 'worker-1', (msg) => console.log(msg.value));
 */

const { checkAppName, checkAppPath } = require('./address');

// Header the platform sets on automation-triggered HTTP calls; carries the run
// ID a handler publishes its async result back to (see AutomationClient.runAsync).
const AUTOMATION_RUN_ID_HEADER = 'Localitas-Automation-Run-ID';

// How close to its expiry a client refreshes the identity token it acts with.
const REFRESH_BEFORE_SECONDS = 60;

// The phases of a node's lifecycle waitReady can wait for: every shard has a
// leader; core serves its own calls (users still get 503); every route serves.
const PHASE_RAFT_READY = 'raft_ready';
const PHASE_SERVING = 'serving';
const PHASE_READY = 'ready';

// How long core holds one readiness question before answering that the node
// is not there yet: under core's shortest HTTP write timeout (30 s), which
// would cut a longer one.
const READY_POLL_TIMEOUT_S = 25;
const REDIAL_FIRST_MS = 100;
const REDIAL_MAX_MS = 5000;

class APIError extends Error {
  constructor(method, path, statusCode, body) {
    super(`${method} ${path}: ${statusCode} ${body}`);
    this.method = method;
    this.path = path;
    this.statusCode = statusCode;
    this.body = body;
  }
}

/** A client is missing configuration it cannot guess, such as CORE_URL. */
class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const CORE_URL_UNSET = 'CORE_URL is not set: core sets it for every app it runs; outside core pass the URL to the constructor';

/** CORE_URL without trailing slashes; a ConfigError when unset or not an absolute http(s) URL. */
function coreUrlFromEnv() {
  const raw = (process.env.CORE_URL || '').trim();
  if (!raw) throw new ConfigError(CORE_URL_UNSET);
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch (_) {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.host) {
    throw new ConfigError(`CORE_URL ${JSON.stringify(raw)} is not an absolute http(s) URL`);
  }
  return raw.replace(/\/+$/, '');
}

/** The WebSocket URL of a cache's pub/sub socket on core at baseUrl: ws for
 *  http, wss for https. Every socket the SDK opens is built here. */
function cacheSocketUrl(baseUrl, cache) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new ConfigError(CORE_URL_UNSET);
  const scheme = base.startsWith('https://') ? 'wss://' : 'ws://';
  return scheme + base.replace(/^https?:\/\//, '') + `/apps/cache/ws/${esc(cache)}`;
}

class LocalitasClient {
  constructor(baseUrl = '', token = '') {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = token;
    /** Unix seconds now; identity tokens are refreshed against it. */
    this.now = () => Date.now() / 1000;
  }

  /** The client of an app core runs: core at CORE_URL, acting with
   *  LOCALITAS_API_TOKEN. Throws a ConfigError naming whichever is missing. */
  static default() {
    const baseUrl = coreUrlFromEnv();
    const token = process.env.LOCALITAS_API_TOKEN || '';
    if (!token) throw new ConfigError('LOCALITAS_API_TOKEN is not set: core sets it for every app it runs; outside core pass the token to the constructor');
    return new LocalitasClient(baseUrl, token);
  }

  /** baseUrl + path; a ConfigError for a client without a base URL. */
  _url(path) {
    if (!this.baseUrl) throw new ConfigError(CORE_URL_UNSET);
    return this.baseUrl + path;
  }

  /** The token to send. An identity token within a minute of its expiry is
   *  first refreshed with core (POST /api/auth/identity/refresh), up to the
   *  max claim core fixed when it minted it; if the refresh fails the current
   *  token is sent and core decides. */
  async _bearer() {
    if (!this.token) return '';
    const { unverifiedClaims } = require('./scope');
    const claims = unverifiedClaims(this.token);
    const exp = Number(claims.exp || 0);
    const max = Number(claims.max || 0);
    if (exp && max > exp && exp - this.now() < REFRESH_BEFORE_SECONDS) {
      try {
        const resp = await fetch(this._url('/api/auth/identity/refresh'), {
          method: 'POST', headers: { Authorization: `Bearer ${this.token}` },
        });
        if (resp.ok) {
          const body = await resp.json();
          if (body && body.token) this.token = body.token;
        }
      } catch (_) {
        // keep the current token; core decides
      }
    }
    return this.token;
  }

  /** Ask core for a short-lived identity token for an existing user, so the
   *  app's background work can act as that user. Only core's system token may
   *  ask; core grants at most write, never more than the user's own
   *  permission, caps the lifetime at 15 minutes and audit-logs it. */
  async identityForUser(userId, permission = 'read', ttlSeconds = 300) {
    const resp = await this._do('POST', '/api/auth/identity/for-user', { user_id: userId, permission, ttl_seconds: ttlSeconds });
    return (resp && resp.token) || '';
  }

  withToken(token) {
    return new LocalitasClient(this.baseUrl, token);
  }

  /**
   * Call another app by name: its endpoints are at /apps/ext/<name> on core,
   * whichever node runs it.
   * @param {string} name - The app's name.
   * @returns {AppRef}
   */
  app(name) {
    return new AppRef(this, checkAppName(name));
  }

  /**
   * The app's system database named name, as a Database. Its ID is resolved
   * on first use (and retried on the next use after a failure), so an app
   * started while core's data shard elects does not fail here.
   * @param {string} name - The database's name.
   * @returns {Database}
   */
  db(name) {
    if (typeof name !== 'string' || !name) throw new TypeError('db name must be a non-empty string');
    return new Database(null, { client: this, name });
  }

  // ── Databases ──────────────────────────────────────────────

  async listDatabases() {
    return this._do('GET', '/apps/data/api/databases');
  }

  async createDatabase(name, system = false) {
    if (system) return this._do('POST', '/apps/data/api/system-dbs', { name });
    return this._do('POST', '/apps/data/api/databases', { name });
  }

  async getDatabase(dbId) {
    return this._do('GET', `/apps/data/api/databases/${esc(dbId)}`);
  }

  async deleteDatabase(dbId) {
    return this._do('DELETE', `/apps/data/api/databases/${esc(dbId)}`);
  }

  // ── Migrations ─────────────────────────────────────────────

  async listMigrations(dbId) {
    return this._do('GET', `/apps/data/api/databases/${esc(dbId)}/migrations`);
  }

  async applyMigration(dbId, version, description, upSql, downSql = '') {
    return this._do('POST', `/apps/data/api/databases/${esc(dbId)}/migrations`, {
      version, description, up_sql: upSql, down_sql: downSql,
    });
  }

  // ── Tables & Rows ──────────────────────────────────────────

  async listTables(dbId) {
    return this._do('GET', `/apps/data/api/databases/${esc(dbId)}/tables`);
  }

  async insertRow(dbId, tableId, values) {
    return this._do('POST', `/apps/data/api/databases/${esc(dbId)}/tables/${esc(tableId)}/rows`, { values });
  }

  async updateRow(dbId, tableId, rowId, values) {
    return this._do('PUT', `/apps/data/api/databases/${esc(dbId)}/tables/${esc(tableId)}/rows/${esc(rowId)}`, { values });
  }

  async deleteRow(dbId, tableId, rowId) {
    return this._do('DELETE', `/apps/data/api/databases/${esc(dbId)}/tables/${esc(tableId)}/rows/${esc(rowId)}`);
  }

  async listRows(dbId, tableId, limit = 100, offset = 0) {
    return this._do('GET', `/apps/data/api/databases/${esc(dbId)}/tables/${esc(tableId)}/rows?limit=${limit}&offset=${offset}`);
  }

  async getRow(dbId, tableId, rowId) {
    return this._do('GET', `/apps/data/api/databases/${esc(dbId)}/tables/${esc(tableId)}/rows/${esc(rowId)}`);
  }

  // ── Raw SQL ────────────────────────────────────────────────

  async sqlExec(dbId, sql, ...args) {
    return this._do('POST', `/apps/data/api/databases/${esc(dbId)}/exec`, { sql, args });
  }

  async sqlQuery(dbId, sql, ...args) {
    return this._do('POST', `/apps/data/api/databases/${esc(dbId)}/query`, { sql, args });
  }

  /**
   * Apply statements ({sql, args}) as one atomic transaction. `unlessExists`
   * ({sql, args}) makes it conditional: core runs that read-only query inside
   * the replicated transaction, on the state every node holds at its place in
   * the log, and applies nothing when it returns a row. The result then has
   * `skipped: true` — a success, not an error — so of writers racing on one
   * condition exactly one applies. Core refuses a query that is not one
   * read-only SELECT, WITH or VALUES statement.
   */
  async sqlTransaction(dbId, statements, unlessExists) {
    const body = { statements };
    if (unlessExists) body.unless_exists = unlessExists;
    return this._do('POST', `/apps/data/api/databases/${esc(dbId)}/exec`, body);
  }

  // ── Search ─────────────────────────────────────────────────

  async searchFts(query, limit = 100, databaseId = '') {
    let path = `/apps/data/api/search?q=${esc(query)}&limit=${limit}`;
    if (databaseId) path += `&database_id=${esc(databaseId)}`;
    return this._do('GET', path);
  }

  /**
   * Register the app listening on port with core, so core proxies to it and
   * runs its jobs. The app tells core only where it is (that port on its own
   * host); core reads the rest from its health.json,
   * cron.json and public-paths.json. Returns at once and, in the background,
   * waits until core is ready (waitReady) and registers the app once, since
   * core reads the app while registering it. A registration core answers 503
   * (not ready: it restarted) waits again; any other failure is logged as an
   * error and not tried again. Call withdraw() on shutdown.
   *
   * In a container it does nothing: core registers app containers itself
   * when Docker reports them healthy, and only core knows the port it
   * published.
   */
  announce(port) {
    return new Announcement(this, port);
  }

  /**
   * Wait until the node this client talks to is at phase (PHASE_READY,
   * PHASE_SERVING or PHASE_RAFT_READY) with every hook of it finished. Asks
   * core's readiness endpoint, a long poll core answers at the transition
   * itself, and asks again when core answers that the node is not there
   * yet: the poll's timeout passed, or the node drains (its next boot
   * follows). Resolves once ready; rejects with signal's reason once signal
   * aborts, and with any other failure, a fault no waiting mends.
   */
  async waitReady(phase = PHASE_READY, { signal } = {}) {
    let redial = REDIAL_FIRST_MS;
    for (;;) {
      signal?.throwIfAborted();
      let answer;
      try {
        answer = await this._askReady(phase, signal);
      } catch (e) {
        if (signal?.aborted || !coreDown(e)) throw e;
        // Core's process is not running or not yet listening: the one case
        // with no event to wait on, so dial again after a bounded backoff.
        await sleep(redial, signal);
        redial = Math.min(2 * redial, REDIAL_MAX_MS);
        continue;
      }
      redial = REDIAL_FIRST_MS;
      if (answer.ready) return;
      // A draining node answers at once until its HTTP stops; core says when
      // to ask again.
      if (answer.phase === 'draining' || answer.phase === 'stopped') await sleep(answer.retryAfterMs, signal);
    }
  }

  /** Ask core's readiness endpoint once, held up to READY_POLL_TIMEOUT_S. */
  async _askReady(phase, signal) {
    const path = `/api/system/ready?phase=${esc(phase)}&timeout=${READY_POLL_TIMEOUT_S}s`;
    const resp = await fetch(this._url(path), { signal });
    const text = await resp.text();
    if (resp.status !== 200 && resp.status !== 503) throw new APIError('GET', path, resp.status, text);
    let answer = null;
    try {
      answer = JSON.parse(text);
    } catch {
      answer = null;
    }
    if (!answer || typeof answer !== 'object' || answer.ready !== (resp.status === 200)) {
      throw new APIError('GET', path, resp.status, `not core's readiness answer: ${text}`);
    }
    const retryAfter = Number(resp.headers.get('retry-after') ?? '1');
    return { ready: answer.ready, phase: answer.phase || '', retryAfterMs: (Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 1) * 1000 };
  }

  // ── Permissions ────────────────────────────────────────────

  /** Make the calling user the owner of an unowned resource (or one it already owns). */
  async claimResource(app, resourceType, resourceId) {
    return this._do('POST', '/api/permissions/set-owner', {
      app, resource_type: resourceType, resource_id: resourceId,
    });
  }

  /** The calling user's permission on a resource ('' for none). */
  async checkPermission(app, resourceType, resourceId) {
    const result = await this._do('POST', '/api/permissions/check', {
      app, resource_type: resourceType, resource_id: resourceId,
    });
    return result?.permission || '';
  }

  // The *AsUser methods let an app backend, holding an admin-scoped system
  // token, act for the user making the request.

  async setResourceOwnerAsUser(userId, app, resourceType, resourceId) {
    return this._do('POST', `/api/permissions/users/${esc(userId)}/set-owner`, {
      app, resource_type: resourceType, resource_id: resourceId,
    });
  }

  async checkPermissionAsUser(userId, app, resourceType, resourceId) {
    const result = await this._do('POST', `/api/permissions/users/${esc(userId)}/check`, {
      app, resource_type: resourceType, resource_id: resourceId,
    });
    return result?.permission || '';
  }

  async deleteResourcePermissionsAsUser(userId, app, resourceType, resourceId) {
    const path = `/api/permissions/users/${esc(userId)}/resources/${esc(app)}/${esc(resourceType)}/${esc(resourceId)}`;
    return this._do('DELETE', path);
  }

  async listResourceMembers(app, resourceType, resourceId) {
    const path = `/api/permissions/${esc(app)}/${esc(resourceType)}/${esc(resourceId)}/members`;
    const result = await this._do('GET', path);
    return result?.members || [];
  }

  async addResourceMember(app, resourceType, resourceId, userId = '', groupId = '', permission = 'read') {
    const path = `/api/permissions/${esc(app)}/${esc(resourceType)}/${esc(resourceId)}/members`;
    return this._do('POST', path, { user_id: userId, group_id: groupId, permission });
  }

  async removeResourceMember(app, resourceType, resourceId, userId = '', groupId = '') {
    const path = `/api/permissions/${esc(app)}/${esc(resourceType)}/${esc(resourceId)}/members`;
    return this._do('DELETE', path, { user_id: userId, group_id: groupId });
  }

  async getResourceOwner(app, resourceType, resourceId) {
    const path = `/api/permissions/${esc(app)}/${esc(resourceType)}/${esc(resourceId)}/owner`;
    const result = await this._do('GET', path);
    return result?.owner_id || '';
  }

  async deleteResourcePermissions(app, resourceType, resourceId) {
    const path = `/api/permissions/${esc(app)}/${esc(resourceType)}/${esc(resourceId)}`;
    return this._do('DELETE', path);
  }

  async listAccessibleResources(app, resourceType) {
    const path = `/api/permissions/accessible?app=${esc(app)}&resource_type=${esc(resourceType)}`;
    const result = await this._do('GET', path);
    return result?.resources || [];
  }

  async getUserGroupIds(userId) {
    const path = `/api/users/${esc(userId)}/groups`;
    const result = await this._do('GET', path);
    return result?.group_ids || [];
  }

  async listUsers() {
    const result = await this._do('GET', '/api/users');
    return result?.users || [];
  }

  async listGroups() {
    const result = await this._do('GET', '/api/groups');
    return result?.groups || [];
  }

  // ── Vault ──────────────────────────────────────────────────

  async vaultListCredentials() {
    const result = await this._do('GET', '/apps/vault/api/credentials');
    return result?.credentials || [];
  }

  async vaultGetSecrets(publicId) {
    return this._do('GET', `/apps/vault/api/credentials/${esc(publicId)}/secrets`);
  }

  async vaultCreateCredential(name, { url = '', keychainSync = false, data = {} } = {}) {
    return this._do('POST', '/apps/vault/api/credentials', {
      name, url, keychain_sync: keychainSync, data,
    });
  }

  async vaultUpdateCredential(publicId, name, { url = '', keychainSync = false, data = {} } = {}) {
    return this._do('PUT', `/apps/vault/api/credentials/${esc(publicId)}`, {
      name, url, keychain_sync: keychainSync, data,
    });
  }

  async vaultDeleteCredential(publicId) {
    return this._do('DELETE', `/apps/vault/api/credentials/${esc(publicId)}`);
  }

  // ── Metrics (TSDB) ─────────────────────────────────────────

  /** Ingest structured metric points. Each is { name, value, type?, tags? }.
   *  Returns the accepted count. */
  async ingestMetrics(metrics) {
    const result = await this._do('POST', '/apps/tsdb/api/ingest', { metrics });
    return result?.accepted || 0;
  }

  /** Ingest DogStatsD-format metric lines (text/plain). Returns accepted count. */
  async ingestDogStatsD(lines) {
    const headers = { 'Content-Type': 'text/plain' };
    const bearer = await this._bearer();
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    const resp = await fetch(this._url('/apps/tsdb/api/ingest'), {
      method: 'POST', headers, body: lines,
    });
    const text = await resp.text();
    if (!resp.ok) throw new APIError('POST', '/apps/tsdb/api/ingest', resp.status, text);
    return text ? (JSON.parse(text).accepted || 0) : 0;
  }

  // ── Notifications ──────────────────────────────────────────

  async createNotification({ title, message = '', app = '', level = '' }) {
    return this._do('POST', '/api/notifications', { app, level, title, message });
  }

  // ── Cache ──────────────────────────────────────────────────

  /** Create a named in-memory cache. */
  async createCache(name) {
    return this._do('POST', '/apps/cache/api/caches', { name });
  }

  /** List all named caches. */
  async listCaches() {
    return (await this._cacheDo('GET', '/apps/cache/api/caches')).caches ?? [];
  }

  /** Delete a named cache. Cannot delete 'public_paths'. */
  async deleteCache(name) {
    return this._do('DELETE', `/apps/cache/api/caches/${esc(name)}`);
  }

  /**
   * Return a CacheRef for key-value and data structure operations.
   * @param {string} name - Cache name.
   * @returns {CacheRef}
   */
  cache(name) {
    return new CacheRef(this, name);
  }

  /** Return an AutomationClient for run management and async job signaling. */
  automation() {
    return new AutomationClient(this);
  }

  // ── Transport ──────────────────────────────────────────────

  async _do(method, path, body = null) {
    const url = this._url(path);
    const opts = {
      method,
      headers: {},
    };

    const bearer = await this._bearer();
    if (bearer) {
      opts.headers['Authorization'] = `Bearer ${bearer}`;
    }
    if (body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const resp = await fetch(url, opts);
    const text = await resp.text();

    if (!resp.ok) {
      throw new APIError(method, path, resp.status, text);
    }

    return text ? JSON.parse(text) : null;
  }

  /** Call a cache data endpoint and return the result of core's envelope. */
  async _cacheDo(method, path, body = null) {
    const r = await this._do(method, path, body);
    if (r === null || typeof r !== 'object' || !('result' in r)) {
      throw new Error(`${method} ${path}: response has no result envelope: ${JSON.stringify(r)}`);
    }
    return r.result;
  }
}

/** Whether e says core's process is not there: it refused the connection,
 *  or dropped it without answering. */
function coreDown(e) {
  const code = e?.cause?.code ?? e?.code;
  return ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(code);
}

/** Whether a call failed because core could not take it yet: it answered
 *  503 (not ready), or its process is not there. */
function notReady(e) {
  if (e instanceof APIError) return e.statusCode === 503;
  return coreDown(e);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function inContainer() {
  const fs = require('fs');
  if (fs.existsSync('/.dockerenv')) return true;
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return ['docker', 'containerd', 'kubepods'].some((k) => cgroup.includes(k));
  } catch {
    return false;
  }
}

/** An app's registration with core, made by LocalitasClient.announce. */
class Announcement {
  constructor(client, port) {
    this._client = client;
    this._url = `http://localhost:${port}`;
    this._name = '';
    this._settled = false;
    this._stop = new AbortController();
    this._done = inContainer() ? Promise.resolve() : this._run();
    this._done.then(() => { this._settled = true; });
  }

  async _run() {
    const { signal } = this._stop;
    for (;;) {
      try {
        await this._client.waitReady(PHASE_READY, { signal });
      } catch (e) {
        if (!signal.aborted) console.error(`waiting for core to be ready failed; the app at ${this._url} is not announced: ${e.message}`);
        return;
      }
      if (signal.aborted) return;
      try {
        const app = await this._client._do('POST', '/apps/ext', { url: this._url });
        this._name = (app && app.name) || '';
        console.log(`announced ${this._name} at ${this._url}`);
        return;
      } catch (e) {
        if (signal.aborted) return;
        if (!notReady(e)) {
          console.error(`core refused the app at ${this._url}; it is not announced: ${e.message}`);
          return;
        }
        console.log(`core is not ready to take the app at ${this._url}; waiting for it: ${e.message}`);
      }
    }
  }

  /** The app core registered, or '' while core has not taken it. */
  get name() {
    return this._settled ? this._name : '';
  }

  /** Stop announcing and take the app out of core, if core had taken it. A
   *  wait for core's readiness ends at once; a registration in flight is
   *  waited for, since only core's answer names the app it took. */
  async withdraw() {
    this._stop.abort();
    await this._done;
    if (this._name) {
      await this._client._do('DELETE', `/apps/ext/${esc(this._name)}`);
      this._name = '';
    }
  }
}

/**
 * Another app's endpoints, by the app's name: each call goes to
 * /apps/ext/<name><path> on core with the client's token, sends body as
 * JSON and resolves to the decoded JSON (null for an empty body). An error
 * status rejects with APIError; a path that is not a path rejects with
 * TypeError.
 */
class AppRef {
  constructor(client, name) {
    this._client = client;
    this.name = name;
  }

  async get(path) { return this._call('GET', path); }
  async post(path, body = null) { return this._call('POST', path, body); }
  async put(path, body = null) { return this._call('PUT', path, body); }
  async delete(path) { return this._call('DELETE', path); }

  async _call(method, path, body = null) {
    return this._client._do(method, `/apps/ext/${this.name}${checkAppPath(path)}`, body);
  }
}

function esc(s) {
  return encodeURIComponent(String(s));
}

/**
 * A 404 the cache answered for an absent key, member or element. An unknown
 * cache is a plain-text 404 and is not a miss.
 */
function isMiss(e) {
  if (!(e instanceof APIError) || e.statusCode !== 404) return false;
  try {
    const body = JSON.parse(e.body);
    return body !== null && typeof body === 'object' && Boolean(body.error);
  } catch (_) {
    return false;
  }
}

/**
 * Deprecated: use LocalitasClient.default(). The API token from
 * LOCALITAS_API_TOKEN, else ~/.localitas/config-core.yaml
 * (core.auth.api_token); '' if neither has one.
 */
function defaultToken() {
  if (process.env.LOCALITAS_API_TOKEN) return process.env.LOCALITAS_API_TOKEN;
  const fs = require('fs');
  const path = require('path');
  const home = require('os').homedir();
  const configPath = path.join(home, '.localitas', 'config-core.yaml');

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('api_token:')) {
        const val = trimmed.slice('api_token:'.length).trim().replace(/^["']|["']$/g, '');
        if (val.startsWith('lt_')) return val;
      }
    }
  } catch (_) {}

  return '';
}

/**
 * Reference to a named cache. Provides Redis-like key-value operations
 * and typed data structure accessors.
 *
 * @example
 *   const cache = client.cache('sessions');
 *
 *   // KV with TTL
 *   await cache.set('user:abc', '{"name":"Alice"}', 1800);
 *   const val = await cache.get('user:abc');
 *
 *   // Rate limiting
 *   const count = await cache.incrWithTTL('rate:ip:1.2.3.4', 1, 60);
 *   if (count > 100) throw new Error('rate limited');
 *
 *   // Distributed lock
 *   const acquired = await cache.setNX('lock:resource', 'owner-1', 30);
 *
 *   // Data structures
 *   const list = cache.list('recent');
 *   await list.rpush('a', 'b', 'c');
 *
 *   const tags = cache.setStore('tags');
 *   await tags.add('go', 'rust');
 *
 *   const user = cache.hash('user:123');
 *   await user.set({ name: 'Alice', email: 'alice@example.com' });
 *
 *   const lb = cache.sortedSet('leaderboard');
 *   await lb.add(['alice', 1500], ['bob', 2100]);
 *
 *   const q = cache.queue('jobs', 1000);
 *   await q.enqueue('{"type":"email"}');
 *
 *   const ch = cache.pubSub('notifications', { maxSize: 1000, maxAgeSeconds: 1209600 });
 *   await ch.publish('{"type":"signup"}');
 *   const msgs = await ch.read('audit-svc', 50);
 *
 *   // Real-time delivery over the cache's socket
 *   const socket = cache.subscribe('notifications', 'worker-1', (msg) => console.log(msg.value));
 */
class CacheRef {
  constructor(client, name) {
    this._client = client;
    this._name = name;
    this._base = `/apps/cache/api/caches/${esc(name)}`;
    this._ws = null;
  }

  // ── Real-time ──────────────────────────────────────────────

  /**
   * PubSubWS.subscribe on this cache's socket, opened on first use from the
   * client's base URL and token and shared by later calls on this ref.
   * @returns {PubSubWS} the socket, to close() or listen on.
   */
  subscribe(channel, consumer, callback) {
    const ws = this._socket();
    ws.subscribe(channel, consumer, callback);
    return ws;
  }

  /**
   * PubSubWS.watch on this cache's socket (see subscribe).
   * @returns {PubSubWS}
   */
  watch(channel, afterSeq, callback) {
    const ws = this._socket();
    ws.watch(channel, afterSeq, callback);
    return ws;
  }

  /**
   * PubSubWS.watchLatest on this cache's socket (see subscribe).
   * @returns {PubSubWS}
   */
  watchLatest(channel, callback) {
    const ws = this._socket();
    ws.watchLatest(channel, callback);
    return ws;
  }

  /** @private */
  _socket() {
    if (!this._ws || this._ws._intentionalClose) {
      this._ws = new PubSubWS({ url: cacheSocketUrl(this._client.baseUrl, this._name), token: this._client.token });
    }
    return this._ws;
  }

  // ── KV ─────────────────────────────────────────────────────

  /** Get a key's value. Returns null on miss. */
  async get(key) {
    return this._get(`${this._base}/keys/${esc(key)}`);
  }

  /**
   * get that sees every write committed before it, through whichever node it
   * entered: a plain read answers from that node's own copy, which may not
   * yet hold a write made through another node a moment ago. Use it where a
   * stale value is wrong, such as a count of failed logons.
   */
  async getConsistent(key) {
    return this._get(`${this._base}/keys/${esc(key)}?consistent=true`);
  }

  /** @private */
  async _get(path) {
    try {
      const r = await this._client._cacheDo('GET', path);
      return r?.value ?? null;
    } catch (e) {
      if (isMiss(e)) return null;
      throw e;
    }
  }

  /** Set a key with optional TTL in seconds. */
  async set(key, value, ttl = 0) {
    return this._client._cacheDo('PUT', `${this._base}/keys/${esc(key)}`, { value, ttl });
  }

  /**
   * Remaining time-to-live in seconds: -1 if the key has no expiry, -2 if it
   * doesn't exist or has expired. An unknown cache rejects.
   */
  async ttl(key) {
    try {
      const r = await this._client._cacheDo('GET', `${this._base}/keys/${esc(key)}`);
      return r?.ttl_remaining ?? 0;
    } catch (e) {
      if (isMiss(e)) return -2;
      throw e;
    }
  }

  /**
   * Set or update the TTL (seconds) of an existing key. Resolves false if the
   * key doesn't exist; a non-positive ttl rejects (400).
   */
  async expire(key, ttl) {
    try {
      await this._client._cacheDo('POST', `${this._base}/keys/expire/${esc(key)}`, { ttl });
      return true;
    } catch (e) {
      if (isMiss(e)) return false;
      throw e;
    }
  }

  /** Atomically set a key and return its old value, or null if it had none. */
  async getSet(key, value, ttl = 0) {
    const r = await this._client._cacheDo('POST', `${this._base}/keys/getset/${esc(key)}`, { value, ttl });
    return r?.had_old ? r.old_value : null;
  }

  /** Delete a key. */
  async del(key) {
    return this._client._cacheDo('DELETE', `${this._base}/keys/${esc(key)}`);
  }

  /** Atomically increment. Creates with delta if missing. */
  async incr(key, delta = 1) {
    const r = await this._client._cacheDo('POST', `${this._base}/keys/incr/${esc(key)}`, { delta });
    return r?.value ?? 0;
  }

  /** Atomic increment + set TTL only on first call. For rate limiting. */
  async incrWithTTL(key, delta = 1, ttl = 60) {
    const r = await this._client._cacheDo('POST', `${this._base}/keys/incrttl/${esc(key)}`, { delta, ttl });
    return r?.value ?? 0;
  }

  /** Set only if key doesn't exist. Returns true if set. For distributed locks. */
  async setNX(key, value, ttl = 0) {
    const r = await this._client._cacheDo('POST', `${this._base}/keys/setnx/${esc(key)}`, { value, ttl });
    return r?.acquired ?? false;
  }

  /** List keys matching glob pattern. */
  async keys(pattern = '*') {
    const r = await this._client._cacheDo('GET', `${this._base}/keys?pattern=${esc(pattern)}`);
    return r?.keys ?? [];
  }

  /** Flush all data in this cache. */
  async flush() {
    return this._client._cacheDo('POST', `${this._base}/flush`);
  }

  /** Get cache stats. */
  async stats() {
    return this._client._cacheDo('GET', `${this._base}/stats`);
  }

  // ── Data structure accessors ────────────────────────────────

  /** @returns {ListRef} */
  list(name) { return new ListRef(this, name); }
  /** @returns {SetRef} */
  setStore(name) { return new SetRef(this, name); }
  /** @returns {HashRef} */
  hash(name) { return new HashRef(this, name); }
  /** @returns {SortedSetRef} */
  sortedSet(name) { return new SortedSetRef(this, name); }
  /** @returns {QueueRef} */
  queue(name, maxSize = 0) { return new QueueRef(this, name, maxSize); }
  /** @returns {StackRef} */
  stack(name, maxSize = 0) { return new StackRef(this, name, maxSize); }
  /** @returns {PubSubRef} */
  pubSub(channel, opts = {}) { return new PubSubRef(this, channel, opts); }
}

/** Double-headed deque. */
class ListRef {
  constructor(cache, name) {
    this._c = cache._client;
    this._base = `${cache._base}/lists/${esc(name)}`;
  }
  async lpush(...values) { return (await this._c._cacheDo('POST', `${this._base}/lpush`, { values }))?.length ?? 0; }
  async rpush(...values) { return (await this._c._cacheDo('POST', `${this._base}/rpush`, { values }))?.length ?? 0; }
  async lpop() { try { return (await this._c._cacheDo('POST', `${this._base}/lpop`))?.value; } catch(e) { if (isMiss(e)) return null; throw e; } }
  async rpop() { try { return (await this._c._cacheDo('POST', `${this._base}/rpop`))?.value; } catch(e) { if (isMiss(e)) return null; throw e; } }
  async range(start = 0, stop = -1) { return (await this._c._cacheDo('GET', `${this._base}?start=${start}&stop=${stop}`))?.values ?? []; }
  async len() { return (await this._c._cacheDo('GET', `${this._base}?start=0&stop=-1`))?.length ?? 0; }
  async del() { return this._c._cacheDo('DELETE', this._base); }
}

/** Unique unordered set. */
class SetRef {
  constructor(cache, name) {
    this._c = cache._client;
    this._base = `${cache._base}/sets/${esc(name)}`;
  }
  async add(...members) { return (await this._c._cacheDo('POST', `${this._base}/add`, { members }))?.added ?? 0; }
  async rem(...members) { return (await this._c._cacheDo('POST', `${this._base}/rem`, { members }))?.removed ?? 0; }
  async members() { return (await this._c._cacheDo('GET', this._base))?.members ?? []; }
  async del() { return this._c._cacheDo('DELETE', this._base); }
}

/** Field→value map. */
class HashRef {
  constructor(cache, name) {
    this._c = cache._client;
    this._base = `${cache._base}/hashes/${esc(name)}`;
  }
  async set(fields) { return this._c._cacheDo('PUT', this._base, { fields }); }
  async get(field) { try { return (await this._c._cacheDo('GET', `${this._base}/fields/${esc(field)}`))?.value; } catch(e) { if (isMiss(e)) return null; throw e; } }
  async getAll() { return (await this._c._cacheDo('GET', this._base))?.fields ?? {}; }
  async toJSON() { return (await this._c._cacheDo('GET', `${this._base}/json`))?.json ?? '{}'; }
  async fromJSON(jsonStr) { return this._c._cacheDo('PUT', `${this._base}/json`, { json: jsonStr }); }
  /** Remove fields from the hash. Resolves to the number removed. */
  async delFields(...fields) {
    let removed = 0;
    for (const field of fields) {
      removed += (await this._c._cacheDo('DELETE', `${this._base}/fields/${esc(field)}`))?.removed ?? 0;
    }
    return removed;
  }
  async del() { return this._c._cacheDo('DELETE', this._base); }
}

/** Members ordered by score. */
class SortedSetRef {
  constructor(cache, name) {
    this._c = cache._client;
    this._base = `${cache._base}/zsets/${esc(name)}`;
  }
  async add(...entries) { return (await this._c._cacheDo('POST', `${this._base}/add`, { entries: entries.map(([m,s]) => ({member:m,score:s})) }))?.added ?? 0; }
  async score(member) { try { return (await this._c._cacheDo('GET', `${this._base}/score/${esc(member)}`))?.score; } catch(e) { if (isMiss(e)) return null; throw e; } }
  async rank(member) { try { return (await this._c._cacheDo('GET', `${this._base}/rank/${esc(member)}`))?.rank ?? -1; } catch(e) { if (isMiss(e)) return -1; throw e; } }
  async range(start = 0, stop = -1) { return (await this._c._cacheDo('GET', `${this._base}?start=${start}&stop=${stop}`))?.entries ?? []; }
  /** Entries with scores between min and max (inclusive). */
  async rangeByScore(min, max) {
    const query = new URLSearchParams({ min: String(min), max: String(max) });
    return (await this._c._cacheDo('GET', `${this._base}/byscore?${query}`))?.entries ?? [];
  }
  async rem(...members) { return (await this._c._cacheDo('POST', `${this._base}/rem`, { members }))?.removed ?? 0; }
  async incrBy(member, delta) { return (await this._c._cacheDo('POST', `${this._base}/incrby`, { member, delta }))?.score ?? 0; }
  async del() { return this._c._cacheDo('DELETE', this._base); }
}

/** FIFO queue. Bounded queues drop oldest on overflow. */
class QueueRef {
  constructor(cache, name, maxSize) {
    this._c = cache._client;
    this._maxSize = maxSize;
    this._base = `${cache._base}/queues/${esc(name)}`;
  }
  async enqueue(value) { return (await this._c._cacheDo('POST', `${this._base}/enqueue`, { value, max_size: this._maxSize }))?.length ?? 0; }
  async dequeue() { try { return (await this._c._cacheDo('POST', `${this._base}/dequeue`))?.value; } catch(e) { if (isMiss(e)) return null; throw e; } }
  async peek() { try { return (await this._c._cacheDo('GET', this._base))?.value; } catch(e) { if (isMiss(e)) return null; throw e; } }
}

/** LIFO stack. Bounded stacks drop bottom on overflow. */
class StackRef {
  constructor(cache, name, maxSize) {
    this._c = cache._client;
    this._maxSize = maxSize;
    this._base = `${cache._base}/stacks/${esc(name)}`;
  }
  async push(value) { return (await this._c._cacheDo('POST', `${this._base}/push`, { value, max_size: this._maxSize }))?.length ?? 0; }
  async pop() { try { return (await this._c._cacheDo('POST', `${this._base}/pop`))?.value; } catch(e) { if (isMiss(e)) return null; throw e; } }
  async peek() { try { return (await this._c._cacheDo('GET', this._base))?.value; } catch(e) { if (isMiss(e)) return null; throw e; } }
}

/** Durable pub/sub channel with broadcast and consumer groups. */
class PubSubRef {
  constructor(cache, channel, opts) {
    this._c = cache._client;
    this._channel = channel;
    this._maxSize = opts.maxSize || 0;
    this._maxAgeSeconds = opts.maxAgeSeconds || 0;
    this._base = `${cache._base}/pubsub/${esc(channel)}`;
  }
  async publish(value) {
    const body = { value };
    if (this._maxSize > 0) body.max_size = this._maxSize;
    if (this._maxAgeSeconds > 0) body.max_age_seconds = this._maxAgeSeconds;
    return (await this._c._cacheDo('POST', `${this._base}/publish`, body))?.seq ?? 0;
  }
  async read(consumerId, count = 50) { return (await this._c._cacheDo('GET', `${this._base}/read?consumer=${esc(consumerId)}&count=${count}`))?.messages ?? []; }
  async createGroup(groupName) { return this._c._cacheDo('POST', `${this._base}/group/${esc(groupName)}`); }
  async claim(groupName, consumerId) { return (await this._c._cacheDo('POST', `${this._base}/group/${esc(groupName)}/claim?consumer=${esc(consumerId)}`))?.message; }
  async ack(groupName, seq) { return this._c._cacheDo('POST', `${this._base}/group/${esc(groupName)}/ack`, { seq }); }
  /**
   * Re-assign to consumerId the group's messages pending longer than
   * timeoutSeconds without an ack, and resolve to them.
   */
  async reclaim(groupName, consumerId, timeoutSeconds = 30) {
    const query = new URLSearchParams({ consumer: consumerId, timeout: String(timeoutSeconds) });
    return (await this._c._cacheDo('POST', `${this._base}/group/${esc(groupName)}/reclaim?${query}`))?.messages ?? [];
  }
  /** Remove messages older than maxAgeSeconds. Resolves to the number removed; a non-positive age rejects (400). */
  async trim(maxAgeSeconds) { return (await this._c._cacheDo('POST', `${this._base}/trim`, { max_age: maxAgeSeconds }))?.removed ?? 0; }
  async del() { return this._c._cacheDo('DELETE', this._base); }
  /** Describe the channel on the node asked: name, message_count, last_message_at, last_seq. */
  async info() { return this._c._cacheDo('GET', this._base); }
  /**
   * The newest message's sequence number on the node asked. Note it before
   * starting something whose outcome is published here, then
   * PubSubWS.watch after it, and the outcome cannot be missed.
   */
  async lastSeq() { return (await this.info())?.last_seq ?? 0; }
}

const WebSocket = require('ws');

const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

function headerValue(headers, name) {
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== want) continue;
    const v = headers[key];
    return String((Array.isArray(v) ? v[0] : v) ?? '');
  }
  return '';
}

/** The run ID and Idempotency-Key of an automation's async call, from the
 *  run ID itself, an incoming request (its .headers) or its headers. */
function asyncCall(runIdOrReq) {
  if (!runIdOrReq) return { runId: '', idempotencyKey: '' };
  if (typeof runIdOrReq === 'string') return { runId: runIdOrReq, idempotencyKey: '' };
  const headers = runIdOrReq.headers && typeof runIdOrReq.headers === 'object' ? runIdOrReq.headers : runIdOrReq;
  return {
    runId: headerValue(headers, AUTOMATION_RUN_ID_HEADER),
    idempotencyKey: headerValue(headers, IDEMPOTENCY_KEY_HEADER),
  };
}

class AutomationClient {
  constructor(client) {
    this._client = client;
  }

  /**
   * Create an automation and return it.
   * @param {CreateAutomationRequest|Object} request
   */
  async create(request) {
    return this._client._do('POST', '/apps/automation/api/automations', request);
  }

  /** Trigger an automation and return the run. */
  async trigger(automationId) {
    return this._client._do('POST', `/apps/automation/api/automations/${automationId}/trigger`);
  }

  /** Get a run by ID. */
  async getRun(runId) {
    return this._client._do('GET', `/apps/automation/api/runs/${runId}`);
  }

  /**
   * Signal async job completion. Called from inside the background job.
   * idempotencyKey, the Idempotency-Key of the call this completes, restricts
   * the completion to that try.
   */
  async publishResult(runId, status = 'completed', result = {}, error = '', { idempotencyKey = '' } = {}) {
    const body = { status, result, error };
    if (idempotencyKey) body.idempotency_key = idempotencyKey;
    return this._client._do('POST', `/apps/automation/api/runs/${runId}/complete`, body);
  }

  /**
   * Run ``work`` in the background and publish its result back to the automation
   * run when done. ``work`` is an async function returning an object (or null).
   * Pass the incoming request (or its headers): the run ID comes from its
   * Localitas-Automation-Run-ID header and its Idempotency-Key is echoed, so
   * the completion ends only the try that made the call. A run ID string
   * still works and completes the run's running tasks.
   * Returns true if the call was an automation's (so the handler should
   * respond 202 immediately), false otherwise — mirroring the Go RunAsync pattern.
   * @param {string|{headers: Object}|Headers|Object} runIdOrReq
   * @param {() => Promise<object|null>} work
   * @returns {boolean}
   */
  runAsync(runIdOrReq, work) {
    const { runId, idempotencyKey } = asyncCall(runIdOrReq);
    if (!runId) return false;
    (async () => {
      const start = Date.now();
      let status = 'completed';
      let error = '';
      let result = null;
      try {
        result = await work();
      } catch (err) {
        status = 'failed';
        error = String(err && err.message ? err.message : err);
      }
      if (result === null || result === undefined) result = {};
      result.duration_ms = Date.now() - start;
      await this.publishResult(runId, status, result, error, { idempotencyKey });
    })();
    return true;
  }

  /**
   * Return the run once it has finished, without polling it.
   *
   * Every finished run is announced once, after its outcome is recorded, on
   * the channel its first read names (its owner's own completions channel;
   * only the owner can read the run, so the caller is the owner), or on the
   * shared 'completions' channel of a core that names none. This reads the
   * run to learn the channel, notes the channel's last message, then reads
   * the run again; the read is linearizable, so a run whose completion is at
   * or before the noted message is read finished. A run still going is
   * waited for by watching the channel after the noted message: its
   * completion comes after it, so it cannot be missed.
   */
  async waitForRun(runId, { timeout = 3600000 } = {}) {
    let run = await this.getRun(runId);
    if (run.status === 'completed' || run.status === 'failed') return run;
    const channel = run.completion_channel || 'completions';
    const noted = await this._client.cache('localitas_automations').pubSub(channel).lastSeq();
    run = await this.getRun(runId);
    if (run.status === 'completed' || run.status === 'failed') return run;

    const ps = new PubSubWS({ url: cacheSocketUrl(this._client.baseUrl, 'localitas_automations'), token: this._client.token });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for run ${runId}`)), timeout);
        ps.watch(channel, noted, (msg) => {
          let announced = {};
          try { announced = JSON.parse(msg.value || '{}'); } catch (_) { return; }
          if (announced.run_id === runId) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      return await this.getRun(runId);
    } finally {
      ps.close();
    }
  }
}

/**
 * WebSocket-based real-time pub/sub client for Localitas DurablePubSub.
 *
 * Provides automatic reconnection with exponential backoff, cursor-based
 * message delivery (no missed messages), and consumer group support. Open
 * one through a cache, which builds its URL from the client's:
 *
 * @example
 *   const pubsub = LocalitasClient.default().cache('my-cache')
 *     .subscribe('notifications', 'worker-1', (msg) => console.log('Got:', msg.value));
 *
 *   pubsub.publish('events', '{"type":"click"}');
 *   pubsub.on('connected', () => console.log('connected'));
 */
class PubSubWS {
  /**
   * Create a new PubSubWS client. Connects automatically.
   *
   * @param {Object} opts - Connection options.
   * @param {string} opts.url - WebSocket URL (ws://host/apps/cache/ws/{cache}).
   * @param {string} opts.token - Bearer token for authentication.
   * @param {number} [opts.reconnectInterval=2000] - Base reconnect interval in ms.
   * @param {number} [opts.maxReconnectInterval=30000] - Maximum reconnect interval cap in ms.
   * @param {number} [opts.batchSize=50] - Messages the server reads per batch for a subscribe or watch.
   */
  constructor(opts) {
    this.url = opts.url;
    this.token = opts.token || '';
    this.reconnectInterval = opts.reconnectInterval || 2000;
    this.maxReconnectInterval = opts.maxReconnectInterval || 30000;
    this.batchSize = opts.batchSize || 50;

    /** @private */
    this._ws = null;
    /** @private */
    this._subscriptions = {};
    /** @private */
    this._listeners = {};
    /** @private */
    this._reconnectAttempts = 0;
    /** @private */
    this._intentionalClose = false;

    this._connect();
  }

  /**
   * Subscribe to a channel. The callback fires for each incoming message.
   * On reconnect, subscriptions are automatically re-established from the
   * server's last cursor position so no messages are missed.
   *
   * @param {string} channel - Channel name to subscribe to.
   * @param {string} consumer - Consumer ID for cursor tracking.
   * @param {Function} callback - Called with { seq, value, channel } for each message.
   */
  subscribe(channel, consumer, callback) {
    this._start(channel, { consumer, callback });
  }

  /**
   * Watch a channel: the callback fires for each message published after
   * afterSeq, as the server's node applies it. A watch keeps no cursor and
   * asks the cluster for nothing. To miss nothing a later action publishes,
   * note PubSubRef.lastSeq() before the action and watch after it. A
   * reconnect resumes after the last message delivered.
   *
   * @param {string} channel - Channel name to watch.
   * @param {number} afterSeq - Deliver messages after this sequence number.
   * @param {Function} callback - Called with { seq, value, channel } for each message.
   */
  watch(channel, afterSeq, callback) {
    this._start(channel, { callback, watch: true, after: afterSeq, fromLatest: false });
  }

  /**
   * watch from the channel's newest message when the watch starts.
   *
   * @param {string} channel - Channel name to watch.
   * @param {Function} callback - Called with { seq, value, channel } for each message.
   */
  watchLatest(channel, callback) {
    this._start(channel, { callback, watch: true, after: 0, fromLatest: true });
  }

  /** @private */
  _start(channel, sub) {
    this._subscriptions[channel] = sub;
    if (this._isConnected()) {
      this._send(this._request(channel, sub));
    }
  }

  /** @private */
  _request(channel, sub) {
    const count = this.batchSize;
    if (!sub.watch) return { action: 'subscribe', channel, consumer: sub.consumer, count };
    if (sub.fromLatest) return { action: 'watch', channel, from_latest: true, count };
    return { action: 'watch', channel, seq: sub.after, count };
  }

  /**
   * Unsubscribe from a channel.
   *
   * @param {string} channel - Channel name to unsubscribe from.
   */
  unsubscribe(channel) {
    delete this._subscriptions[channel];
    if (this._isConnected()) {
      this._send({ action: 'unsubscribe', channel });
    }
  }

  /**
   * Publish a message to a channel.
   *
   * @param {string} channel - Channel to publish to.
   * @param {string} value - Message value (typically JSON string).
   * @param {Object} [opts] - Publish options.
   * @param {number} [opts.maxSize] - Bound channel by message count.
   * @param {number} [opts.maxAgeSeconds] - Auto-expire messages older than this many seconds.
   */
  publish(channel, value, opts = {}) {
    const msg = { action: 'publish', channel, value };
    if (opts.maxSize) msg.max_size = opts.maxSize;
    if (opts.maxAgeSeconds) msg.max_age_seconds = opts.maxAgeSeconds;
    this._send(msg);
  }

  /**
   * Acknowledge a consumer group message.
   *
   * @param {string} channel - Channel name.
   * @param {string} group - Consumer group name.
   * @param {number} seq - Sequence number to acknowledge.
   */
  ack(channel, group, seq) {
    this._send({ action: 'ack', channel, group, seq });
  }

  /**
   * Register an event listener.
   *
   * @param {string} event - Event name: 'connected', 'disconnected', 'error', 'reconnecting'.
   * @param {Function} callback - Event handler.
   */
  on(event, callback) {
    if (!this._listeners[event]) {
      this._listeners[event] = [];
    }
    this._listeners[event].push(callback);
  }

  /**
   * Remove an event listener.
   *
   * @param {string} event - Event name.
   * @param {Function} callback - Handler to remove.
   */
  off(event, callback) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
    }
  }

  /**
   * Intentionally close the connection. Does not auto-reconnect.
   */
  close() {
    this._intentionalClose = true;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  /** @private */
  _connect() {
    // The server authenticates the upgrade by its Authorization header (a
    // query token is not read), as the Go and Python clients send it.
    const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {};
    this._ws = new WebSocket(this.url, { headers });

    this._ws.on('open', () => {
      this._reconnectAttempts = 0;
      this._emit('connected');

      for (const channel in this._subscriptions) {
        this._send(this._request(channel, this._subscriptions[channel]));
      }
    });

    this._ws.on('close', () => {
      this._emit('disconnected');
      if (!this._intentionalClose) {
        this._reconnect();
      }
    });

    this._ws.on('error', (err) => {
      this._emit('error', err);
    });

    this._ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (_) {
        return;
      }
      this._handleMessage(msg);
    });
  }

  /** @private */
  _handleMessage(msg) {
    // The server's greeting is the socket opening, already emitted as
    // 'connected': a second one would run connect handlers twice.
    if (msg.type && msg.type !== 'connected') this._emit(msg.type, msg);
    if (msg.type === 'subscribed' && msg.channel) {
      const sub = this._subscriptions[msg.channel];
      if (sub && sub.watch && sub.fromLatest) {
        sub.after = msg.seq || 0;
        sub.fromLatest = false;
      }
    }
    if (msg.type === 'message' && msg.channel) {
      const sub = this._subscriptions[msg.channel];
      if (sub && sub.watch) {
        // A resumed watch may resend what came before the drop.
        if ((msg.seq || 0) <= sub.after) return;
        sub.after = msg.seq || 0;
      }
      if (sub && sub.callback) {
        sub.callback({ seq: msg.seq, value: msg.value, channel: msg.channel });
      }
    }
  }

  /** @private */
  _send(data) {
    if (this._isConnected()) {
      this._ws.send(JSON.stringify(data));
    }
  }

  /** @private */
  _isConnected() {
    return this._ws && this._ws.readyState === WebSocket.OPEN;
  }

  /** @private */
  _reconnect() {
    this._reconnectAttempts++;
    const delay = Math.min(
      this.reconnectInterval * Math.pow(1.5, this._reconnectAttempts - 1),
      this.maxReconnectInterval
    );
    if (delay >= this.maxReconnectInterval) {
      this._reconnectAttempts = 0;
    }
    this._emit('reconnecting', { attempt: this._reconnectAttempts, delay });
    setTimeout(() => this._connect(), delay);
  }

  /** @private */
  _emit(event, data) {
    if (this._listeners[event]) {
      this._listeners[event].forEach(cb => cb(data));
    }
  }
}

const { Database } = require('./dbapi');

const migrator = require('./migrator');
const crypto = require('./crypto');
const scope = require('./scope');
const automation = require('./automation');

module.exports = {
  LocalitasClient, Database, CacheRef, ListRef, SetRef, HashRef, SortedSetRef,
  QueueRef, StackRef, PubSubRef, PubSubWS, AutomationClient, APIError, Announcement, defaultToken,
  AppRef, ConfigError, cacheSocketUrl, coreUrlFromEnv,
  AUTOMATION_RUN_ID_HEADER, IDEMPOTENCY_KEY_HEADER, PHASE_RAFT_READY, PHASE_SERVING, PHASE_READY,
  ...automation,
  Migrator: migrator.Migrator,
  crypto,
  scope,
};
