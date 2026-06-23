/**
 * Localitas Node.js SDK — mirrors the Go client at /client/client.go.
 *
 * Usage:
 *   const { LocalitasClient } = require('@localitas/client');
 *   const client = new LocalitasClient('http://localhost:8090');
 *   const authed = client.withToken(bearerToken);
 *   const databases = await authed.listDatabases();
 */

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
  }

  withToken(token) {
    return new LocalitasClient(this.baseUrl, token);
  }

  // ── Databases ──────────────────────────────────────────────

  async listDatabases() {
    return this._do('GET', '/apps/data/api/databases');
  }

  async createDatabase(name, system = false) {
    const body = { name };
    if (system) body.system = true;
    return this._do('POST', '/apps/data/api/databases', body);
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

  async sqlTransaction(dbId, statements) {
    return this._do('POST', `/apps/data/api/databases/${esc(dbId)}/exec`, { statements });
  }

  // ── Search ─────────────────────────────────────────────────

  async searchFts(query, limit = 100, databaseId = '') {
    let path = `/apps/data/api/search?q=${esc(query)}&limit=${limit}`;
    if (databaseId) path += `&database_id=${esc(databaseId)}`;
    return this._do('GET', path);
  }

  async searchHybrid(query, limit = 100, databaseId = '') {
    const body = { q: query, limit };
    if (databaseId) body.database_id = databaseId;
    return this._do('POST', '/apps/data/api/search/hybrid', body);
  }

  // ── Permissions ────────────────────────────────────────────

  async setResourceOwner(app, resourceType, resourceId, ownerId) {
    return this._do('POST', '/api/permissions/set-owner', {
      app, resource_type: resourceType, resource_id: resourceId, owner_id: ownerId,
    });
  }

  async checkPermission(app, resourceType, resourceId, userId = '') {
    const body = { app, resource_type: resourceType, resource_id: resourceId };
    if (userId) body.user_id = userId;
    const result = await this._do('POST', '/api/permissions/check', body);
    return result?.permission || '';
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

  // ── Vault ──────────────────────────────────────────────────

  async vaultListCredentials() {
    const result = await this._do('GET', '/apps/vault/api/credentials');
    return result?.credentials || [];
  }

  async vaultGetSecrets(publicId) {
    return this._do('GET', `/apps/vault/api/credentials/${esc(publicId)}/secrets`);
  }

  // ── Cache ──────────────────────────────────────────────────

  /** Create a named in-memory cache. */
  async createCache(name) {
    return this._do('POST', '/apps/cache/api/caches', { name });
  }

  /** List all named caches. */
  async listCaches() {
    return this._do('GET', '/apps/cache/api/caches');
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

  // ── Transport ──────────────────────────────────────────────

  async _do(method, path, body = null) {
    const url = this.baseUrl + path;
    const opts = {
      method,
      headers: {},
    };

    if (this.token) {
      opts.headers['Authorization'] = `Bearer ${this.token}`;
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
}

function esc(s) {
  return encodeURIComponent(String(s));
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
 *   await cache.set('user:abc', '{"name":"Alice"}', 1800);
 *   const val = await cache.get('user:abc');
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
    try {
      const r = await this._client._do('GET', `${this._base}/keys/${key}`);
      return r?.result?.value ?? null;
    } catch (e) {
      if (e.statusCode === 404) return null;
      throw e;
    }
  }

  /** Set a key with optional TTL in seconds. */
  async set(key, value, ttl = 0) {
    return this._client._do('PUT', `${this._base}/keys/${key}`, { value, ttl });
  }

  /** Delete a key. */
  async del(key) {
    return this._client._do('DELETE', `${this._base}/keys/${key}`);
  }

  /** Atomically increment. Creates with delta if missing. */
  async incr(key, delta = 1) {
    const r = await this._client._do('POST', `${this._base}/incr/${key}`, { delta });
    return r?.result?.value ?? 0;
  }

  /** Atomic increment + set TTL only on first call. For rate limiting. */
  async incrWithTTL(key, delta = 1, ttl = 60) {
    const r = await this._client._do('POST', `${this._base}/incrttl/${key}`, { delta, ttl });
    return r?.result?.value ?? 0;
  }

  /** Set only if key doesn't exist. Returns true if set. For distributed locks. */
  async setNX(key, value, ttl = 0) {
    const r = await this._client._do('POST', `${this._base}/setnx/${key}`, { value, ttl });
    return r?.result?.acquired ?? false;
  }

  /** List keys matching glob pattern. */
  async keys(pattern = '*') {
    const r = await this._client._do('GET', `${this._base}/keys?pattern=${esc(pattern)}`);
    return r?.result?.keys ?? [];
  }

  /** Flush all data in this cache. */
  async flush() {
    return this._client._do('POST', `${this._base}/flush`);
  }

  /** Get cache stats. */
  async stats() {
    const r = await this._client._do('GET', `${this._base}/stats`);
    return r?.result ?? {};
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
    this._base = `${cache._base}/list/${esc(name)}`;
  }
  async lpush(...values) { return (await this._c._do('POST', `${this._base}/lpush`, { values }))?.result?.length ?? 0; }
  async rpush(...values) { return (await this._c._do('POST', `${this._base}/rpush`, { values }))?.result?.length ?? 0; }
  async lpop() { try { return (await this._c._do('POST', `${this._base}/lpop`))?.result?.value; } catch(e) { if(e.statusCode===404) return null; throw e; } }
  async rpop() { try { return (await this._c._do('POST', `${this._base}/rpop`))?.result?.value; } catch(e) { if(e.statusCode===404) return null; throw e; } }
  async range(start = 0, stop = -1) { return (await this._c._do('GET', `${this._base}?start=${start}&stop=${stop}`))?.result?.values ?? []; }
  async del() { return this._c._do('DELETE', this._base); }
}

/** Unique unordered set. */
class SetRef {
  constructor(cache, name) {
    this._c = cache._client;
    this._base = `${cache._base}/set/${esc(name)}`;
  }
  async add(...members) { return (await this._c._do('POST', `${this._base}/add`, { members }))?.result?.added ?? 0; }
  async rem(...members) { return (await this._c._do('POST', `${this._base}/rem`, { members }))?.result?.removed ?? 0; }
  async members() { return (await this._c._do('GET', this._base))?.result?.members ?? []; }
  async del() { return this._c._do('DELETE', this._base); }
}

/** Field→value map. */
class HashRef {
  constructor(cache, name) {
    this._c = cache._client;
    this._base = `${cache._base}/hash/${esc(name)}`;
  }
  async set(fields) { return this._c._do('PUT', this._base, { fields }); }
  async get(field) { try { return (await this._c._do('GET', `${this._base}/field/${esc(field)}`))?.result?.value; } catch(e) { if(e.statusCode===404) return null; throw e; } }
  async getAll() { return (await this._c._do('GET', this._base))?.result?.fields ?? {}; }
  async toJSON() { return (await this._c._do('GET', `${this._base}/json`))?.result?.json ?? '{}'; }
  async fromJSON(jsonStr) { return this._c._do('PUT', `${this._base}/json`, { json: jsonStr }); }
  async del() { return this._c._do('DELETE', this._base); }
}

/** Members ordered by score. */
class SortedSetRef {
  constructor(cache, name) {
    this._c = cache._client;
    this._base = `${cache._base}/zset/${esc(name)}`;
  }
  async add(...entries) { return (await this._c._do('POST', `${this._base}/add`, { entries: entries.map(([m,s]) => ({member:m,score:s})) }))?.result?.added ?? 0; }
  async score(member) { try { return (await this._c._do('GET', `${this._base}/score/${esc(member)}`))?.result?.score; } catch(e) { return null; } }
  async rank(member) { try { return (await this._c._do('GET', `${this._base}/rank/${esc(member)}`))?.result?.rank ?? -1; } catch(e) { return -1; } }
  async range(start = 0, stop = -1) { return (await this._c._do('GET', `${this._base}?start=${start}&stop=${stop}`))?.result?.entries ?? []; }
  async rem(...members) { return (await this._c._do('POST', `${this._base}/rem`, { members }))?.result?.removed ?? 0; }
  async incrBy(member, delta) { return (await this._c._do('POST', `${this._base}/incrby`, { member, delta }))?.result?.score ?? 0; }
  async del() { return this._c._do('DELETE', this._base); }
}

/** FIFO queue. Bounded queues drop oldest on overflow. */
class QueueRef {
  constructor(cache, name, maxSize) {
    this._c = cache._client;
    this._maxSize = maxSize;
    this._base = `${cache._base}/queue/${esc(name)}`;
  }
  async enqueue(value) { return (await this._c._do('POST', `${this._base}/enqueue`, { value, max_size: this._maxSize }))?.result?.length ?? 0; }
  async dequeue() { try { return (await this._c._do('POST', `${this._base}/dequeue`))?.result?.value; } catch(e) { if(e.statusCode===404) return null; throw e; } }
  async peek() { try { return (await this._c._do('GET', this._base))?.result?.value; } catch(e) { if(e.statusCode===404) return null; throw e; } }
}

/** LIFO stack. Bounded stacks drop bottom on overflow. */
class StackRef {
  constructor(cache, name, maxSize) {
    this._c = cache._client;
    this._maxSize = maxSize;
    this._base = `${cache._base}/stack/${esc(name)}`;
  }
  async push(value) { return (await this._c._do('POST', `${this._base}/push`, { value, max_size: this._maxSize }))?.result?.length ?? 0; }
  async pop() { try { return (await this._c._do('POST', `${this._base}/pop`))?.result?.value; } catch(e) { if(e.statusCode===404) return null; throw e; } }
  async peek() { try { return (await this._c._do('GET', this._base))?.result?.value; } catch(e) { if(e.statusCode===404) return null; throw e; } }
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
    return (await this._c._do('POST', `${this._base}/publish`, body))?.result?.seq ?? 0;
  }
  async read(consumerId, count = 50) { return (await this._c._do('GET', `${this._base}/read?consumer=${esc(consumerId)}&count=${count}`))?.result?.messages ?? []; }
  async createGroup(groupName) { return this._c._do('POST', `${this._base}/group/${esc(groupName)}`); }
  async claim(groupName, consumerId) { return (await this._c._do('POST', `${this._base}/group/${esc(groupName)}/claim?consumer=${esc(consumerId)}`))?.result?.message; }
  async ack(groupName, seq) { return this._c._do('POST', `${this._base}/group/${esc(groupName)}/ack`, { seq }); }
  async del() { return this._c._do('DELETE', this._base); }
}

module.exports = { LocalitasClient, CacheRef, ListRef, SetRef, HashRef, SortedSetRef, QueueRef, StackRef, PubSubRef, APIError, defaultToken };
