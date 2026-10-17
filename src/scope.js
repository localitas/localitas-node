/**
 * Server-side auth/scope helpers — mirrors the Go client's scope.go + auth.go.
 *
 * For apps that expose their own HTTP endpoints (the external-app model): verify
 * the identity token core puts on every request it forwards to the app, and
 * enforce a minimum scope.
 *
 * The scope hierarchy is: guest < read < write < admin.
 */

const crypto = require('crypto');

const IDENTITY_KEY_DOMAIN = 'localitas-internal-token-v1';
let identityKey = null;

/** Verify identity tokens with the key core derives from its API token. Apps
 *  normally need not call this: the key is derived from LOCALITAS_API_TOKEN,
 *  or the token in ~/.localitas/config-core.yaml. */
function setIdentityKeyFromApiToken(apiToken) {
  identityKey = deriveIdentityKey(apiToken);
}

function deriveIdentityKey(apiToken) {
  if (!apiToken) return Buffer.alloc(0);
  const digest = crypto.createHash('sha256').update(`${IDENTITY_KEY_DOMAIN}:${apiToken}`).digest();
  return Buffer.from(digest.toString('base64'));
}

function currentIdentityKey() {
  if (identityKey === null) {
    const { defaultToken } = require('./index');
    identityKey = deriveIdentityKey(process.env.LOCALITAS_API_TOKEN || defaultToken());
  }
  return identityKey;
}

const SCOPE_GUEST = '';
const SCOPE_READ = 'read';
const SCOPE_WRITE = 'write';
const SCOPE_ADMIN = 'admin';

const RANK = { [SCOPE_ADMIN]: 3, [SCOPE_WRITE]: 2, [SCOPE_READ]: 1, [SCOPE_GUEST]: 0 };

function scopeRank(scope) {
  return RANK[scope || ''] || 0;
}

/** True if `userScope` meets or exceeds `required`. */
function hasScope(userScope, required) {
  return scopeRank(userScope) >= scopeRank(required);
}

/** Verify an identity token core put on a forwarded request ("payload.signature":
 *  base64url JSON claims and their HMAC-SHA256 under the key core derives from
 *  its API token) and return its claims { user_id, email, name, permission }.
 *  Throws for an unsigned, tampered or wrong-key token, so a caller cannot claim
 *  to be another user. */
function parseBearerToken(token) {
  const key = currentIdentityKey();
  if (key.length === 0) throw new Error('no identity key: set LOCALITAS_API_TOKEN');
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) throw new Error('identity token is not signed');
  const payload = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(crypto.createHmac('sha256', key).update(payload).digest('base64url'));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) {
    throw new Error('identity token signature does not verify');
  }
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (typeof claims !== 'object' || claims === null) {
    throw new Error('token payload is not an object');
  }
  return claims;
}

/** Extract the bearer token from an Authorization header value, or '' if
 *  missing/malformed. */
function tokenFromAuthHeader(authorization) {
  if (!authorization || !authorization.startsWith('Bearer ')) return '';
  return authorization.slice('Bearer '.length);
}

/** Parse the caller's identity claims from an Authorization header, or {} if
 *  absent/invalid. */
function identityFromAuthHeader(authorization) {
  const token = tokenFromAuthHeader(authorization);
  if (!token) return {};
  try {
    return parseBearerToken(token);
  } catch (_) {
    return {};
  }
}

/**
 * Enforce a minimum scope for a request's Authorization header. Returns the
 * caller's identity claims on success. Throws an Error with `.status` set to
 * 401 (missing/invalid token) or 403 (under-scoped), so an Express/http handler
 * can map it to a response.
 *
 * Framework-agnostic — call from an Express middleware passing
 * `req.headers.authorization`.
 */
function requireScope(authorization, required) {
  const claims = identityFromAuthHeader(authorization);
  if (!claims.user_id && !claims.email) {
    const err = new Error('authorization required');
    err.status = 401;
    throw err;
  }
  if (!hasScope(claims.permission || '', required)) {
    const err = new Error('insufficient permission');
    err.status = 403;
    throw err;
  }
  return claims;
}

module.exports = {
  SCOPE_GUEST,
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_ADMIN,
  scopeRank,
  hasScope,
  parseBearerToken,
  setIdentityKeyFromApiToken,
  tokenFromAuthHeader,
  identityFromAuthHeader,
  requireScope,
};
