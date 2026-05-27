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

module.exports = { LocalitasClient, APIError };
