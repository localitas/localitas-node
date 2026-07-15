/**
 * Server-side auth/scope helpers — mirrors the Go client's scope.go + auth.go.
 *
 * For apps that expose their own HTTP endpoints (the external-app model): parse
 * the platform bearer token (base64-encoded JSON) and enforce a minimum scope.
 *
 * The scope hierarchy is: guest < read < write < admin.
 */

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

/** Decode a Localitas bearer token (base64 JSON) into its identity claims:
 *  { user_id, email, name, permission }. Client-side parse only — does not
 *  validate against the server. Throws on malformed input. */
function parseBearerToken(token) {
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const claims = JSON.parse(decoded);
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
  tokenFromAuthHeader,
  identityFromAuthHeader,
  requireScope,
};
