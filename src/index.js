/**
 * Localitas Node.js SDK — mirrors the Go client at /client/client.go.
 *
 * Usage:
 *   const { LocalitasClient } = require('@localitas/client');
 *   const client = new LocalitasClient('http://localhost:8090');
 *   const authed = client.withToken(bearerToken);
 *   const databases = await authed.listDatabases();
 */

// Header the platform sets on automation-triggered HTTP calls; carries the run
// ID a handler publishes its async result back to (see AutomationClient.runAsync).
const AUTOMATION_RUN_ID_HEADER = 'Localitas-Automation-Run-ID';

// How close to its expiry a client refreshes the identity token it acts with.
const REFRESH_BEFORE_SECONDS = 60;

class APIError extends Error {
  constructor(method, path, statusCode, body) {
    super(`${method} ${path}: ${statusCode} ${body}`);
    this.method = method;
    this.path = path;
    this.statusCode = statusCode;
    this.body = body;
  }
}

class LocalitasClient {
  constructor(baseUrl, token = '') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    /** Unix seconds now; identity tokens are refreshed against it. */
    this.now = () => Date.now() / 1000;
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
        const resp = await fetch(this.baseUrl + '/api/auth/identity/refresh', {
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
   * runs its jobs. The app tells core only where it is
   * (http://localhost:<port>); core reads the rest from its health.json,
   * cron.json and public-paths.json. Returns at once and keeps trying in the
   * background until core takes the app, since core reads the app while
   * registering it. Call withdraw() on shutdown.
   *
   * In a container it does nothing: core registers app containers itself
   * when Docker reports them healthy, and only core knows the port it
   * published.
   */
  announce(port) {
    return new Announcement(this, port);
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
    const resp = await fetch(this.baseUrl + '/apps/tsdb/api/ingest', {
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
    const url = this.baseUrl + path;
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

const ANNOUNCE_RETRY_FIRST_MS = 1000;
const ANNOUNCE_RETRY_MAX_MS = 30000;

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
    this._stopped = false;
    this._settled = false;
    this._wake = null;
    this._done = inContainer() ? Promise.resolve() : this._run();
    this._done.then(() => { this._settled = true; });
  }

  async _run() {
    let wait = ANNOUNCE_RETRY_FIRST_MS;
    while (!this._stopped) {
      try {
        const app = await this._client._do('POST', '/apps/ext', { url: this._url });
        this._name = (app && app.name) || '';
        console.log(`announced ${this._name} at ${this._url}`);
        return;
      } catch (e) {
        console.warn(`core has not taken the app at ${this._url} yet; trying again in ${wait / 1000}s: ${e.message}`);
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, wait);
        timer.unref();
        this._wake = () => { clearTimeout(timer); resolve(); };
      });
      wait = Math.min(2 * wait, ANNOUNCE_RETRY_MAX_MS);
    }
  }

  /** The app core registered, or '' while core has not taken it. */
  get name() {
    return this._settled ? this._name : '';
  }

  /** Stop announcing and take the app out of core, if core had taken it. */
  async withdraw() {
    this._stopped = true;
    if (this._wake) this._wake();
    await this._done;
    if (this._name) {
      await this._client._do('DELETE', `/apps/ext/${esc(this._name)}`);
      this._name = '';
    }
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
 * Read the API token from ~/.localitas/config-core.yaml (core.auth.api_token).
 * Returns empty string if not found.
 */
function defaultToken() {
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
 */
class CacheRef {
  constructor(client, name) {
    this._client = client;
    this._name = name;
    this._base = `/apps/cache/api/caches/${esc(name)}`;
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

/**
 * WebSocket-based real-time pub/sub client for Localitas DurablePubSub.
 *
 * Provides automatic reconnection with exponential backoff, cursor-based
 * message delivery (no missed messages), and consumer group support.
 *
 * @example
 *   const { PubSubWS } = require('@localitas/client');
 *   const pubsub = new PubSubWS({
 *     url: 'ws://localhost:8080/apps/cache/ws/my-cache',
 *     token: 'your-api-token',
 *   });
 *
 *   pubsub.subscribe('notifications', 'worker-1', (msg) => {
 *     console.log('Got:', msg.value);
 *   });
 *
 *   pubsub.publish('events', '{"type":"click"}');
 *   pubsub.on('connected', () => console.log('connected'));
 */
class AutomationClient {
  constructor(client) {
    this._client = client;
  }

  /** Trigger an automation and return the run. */
  async trigger(automationId) {
    return this._client._do('POST', `/apps/automation/api/automations/${automationId}/trigger`);
  }

  /** Get a run by ID. */
  async getRun(runId) {
    return this._client._do('GET', `/apps/automation/api/runs/${runId}`);
  }

  /** Signal async job completion. Called from inside the background job. */
  async publishResult(runId, status = 'completed', result = {}, error = '') {
    return this._client._do('POST', `/apps/automation/api/runs/${runId}/complete`, { status, result, error });
  }

  /**
   * Run ``work`` in the background and publish its result back to the automation
   * run when done. ``work`` is an async function returning an object (or null).
   * Returns true if a runId was supplied (so the handler should respond 202
   * immediately), false otherwise — mirroring the Go RunAsync pattern. Extract
   * runId from the request's AUTOMATION_RUN_ID_HEADER header before calling.
   * @param {string} runId
   * @param {() => Promise<object|null>} work
   * @returns {boolean}
   */
  runAsync(runId, work) {
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
      await this.publishResult(runId, status, result, error);
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

    const baseUrl = this._client.baseUrl || '';
    const wsUrl = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/apps/cache/ws/localitas_automations';
    const ps = new PubSubWS({ url: wsUrl, token: this._client.token });
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

module.exports = {
  LocalitasClient, Database, CacheRef, ListRef, SetRef, HashRef, SortedSetRef,
  QueueRef, StackRef, PubSubRef, PubSubWS, AutomationClient, APIError, Announcement, defaultToken,
  AUTOMATION_RUN_ID_HEADER,
  Migrator: migrator.Migrator,
  crypto,
  scope,
};
