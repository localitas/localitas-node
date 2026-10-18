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
const ED25519_KID_PREFIX = 'ed25519-';
const CLOCK_SKEW = 120;

let identityKey = null; // legacy HMAC key
let publicKeys = null; // kid -> KeyObject; null until resolved
let legacyExplicit = null;
let legacyFetched = null;

/** Name an identity public key as core does: a prefix and the base64url of
 *  the first 9 bytes of its SHA-256. */
function ed25519KeyId(publicKey) {
  return ED25519_KID_PREFIX + crypto.createHash('sha256').update(publicKey).digest().subarray(0, 9).toString('base64url');
}

function parseKeys(keys) {
  const out = new Map();
  for (const k of keys) {
    if (!k || !k.trim()) continue;
    const raw = Buffer.from(k.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url');
    if (raw.length !== 32) throw new Error(`identity public key must be 32 bytes, got ${raw.length}`);
    const keyObject = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
    out.set(ed25519KeyId(raw), keyObject);
  }
  return out;
}

/** Verify identity tokens with these Ed25519 public keys (base64url) instead
 *  of LOCALITAS_IDENTITY_PUBLIC_KEY or the key core serves. */
function setIdentityPublicKeys(...keys) {
  publicKeys = parseKeys(keys);
  legacyFetched = null;
}

/** Resolve the public keys again from LOCALITAS_IDENTITY_PUBLIC_KEY
 *  (comma-separated), or from core with loadIdentityPublicKey(). */
function resetIdentityPublicKeys() {
  publicKeys = null;
  legacyFetched = null;
}

/** Accept (or refuse) HMAC-signed tokens and tokens without an expiry,
 *  instead of LOCALITAS_ACCEPT_LEGACY_IDENTITY_TOKENS or what core reports. */
function setAcceptLegacyIdentityTokens(accept) {
  legacyExplicit = Boolean(accept);
}

function resetAcceptLegacyIdentityTokens() {
  legacyExplicit = null;
}

/** Ask core (CORE_URL, with LOCALITAS_API_TOKEN) for its identity public key
 *  and legacy policy. An app running on the host, without
 *  LOCALITAS_IDENTITY_PUBLIC_KEY, awaits this once at startup. */
async function loadIdentityPublicKey() {
  const { defaultToken } = require('./index');
  const token = process.env.LOCALITAS_API_TOKEN || defaultToken();
  const base = (process.env.CORE_URL || 'http://localhost:8080').replace(/\/+$/, '');
  const resp = await fetch(base + '/api/auth/identity/public-key', { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`identity public key: ${resp.status}`);
  const body = await resp.json();
  publicKeys = body.public_key ? parseKeys([body.public_key]) : new Map();
  legacyFetched = Boolean(body.accept_legacy);
}

/** Verify legacy identity tokens with the key core derives from its API
 *  token. Apps normally need not call this: the key is derived from
 *  LOCALITAS_API_TOKEN, or the token in ~/.localitas/config-core.yaml. */
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

function resolve() {
  if (publicKeys === null && process.env.LOCALITAS_IDENTITY_PUBLIC_KEY) {
    publicKeys = parseKeys(process.env.LOCALITAS_IDENTITY_PUBLIC_KEY.split(','));
  }
  const env = (process.env.LOCALITAS_ACCEPT_LEGACY_IDENTITY_TOKENS || '').toLowerCase();
  let legacy = true;
  if (legacyExplicit !== null) legacy = legacyExplicit;
  else if (env === 'false' || env === '0') legacy = false;
  else if (env === 'true' || env === '1') legacy = true;
  else if (legacyFetched !== null) legacy = legacyFetched;
  return { keys: publicKeys || new Map(), legacy };
}

/** An identity token's claims without verifying it, for a client to learn
 *  when the token it holds expires. */
function unverifiedClaims(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : {};
  } catch (_) {
    return {};
  }
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
 *  base64url JSON claims and core's Ed25519 signature, verified with
 *  LOCALITAS_IDENTITY_PUBLIC_KEY or the key loadIdentityPublicKey fetched) and
 *  return its claims { user_id, email, name, permission, iat, exp }. Throws for
 *  an unsigned, tampered or wrong-key token, and one expired (beyond two
 *  minutes of clock skew) or issued in the future. Legacy tokens — HMAC-signed
 *  under the key derived from the API token, or without an expiry — verify
 *  only while legacy tokens are accepted. `now` (unix seconds) is for tests. */
function parseBearerToken(token, { now } = {}) {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) throw new Error('identity token is not signed');
  const payload = token.slice(0, dot);
  const sigText = token.slice(dot + 1);
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (_) {
    throw new Error('identity token payload is not JSON');
  }
  if (typeof claims !== 'object' || claims === null) {
    throw new Error('token payload is not an object');
  }

  const { keys, legacy } = resolve();
  const kid = claims.kid || '';
  if (kid.startsWith(ED25519_KID_PREFIX)) {
    const pub = keys.get(kid);
    if (!pub) {
      throw new Error(keys.size ? 'identity token signed with an unknown key' : 'no identity public key: set LOCALITAS_IDENTITY_PUBLIC_KEY or await loadIdentityPublicKey()');
    }
    if (!crypto.verify(null, Buffer.from(payload), pub, Buffer.from(sigText, 'base64url'))) {
      throw new Error('identity token signature does not verify');
    }
  } else {
    if (!legacy) throw new Error('legacy identity tokens are no longer accepted');
    const key = currentIdentityKey();
    if (key.length === 0) throw new Error('no identity key: set LOCALITAS_API_TOKEN');
    const sig = Buffer.from(sigText);
    const expected = Buffer.from(crypto.createHmac('sha256', key).update(payload).digest('base64url'));
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) {
      throw new Error('identity token signature does not verify');
    }
  }

  const exp = Number(claims.exp || 0);
  if (!exp) {
    if (!legacy) throw new Error('legacy identity tokens are no longer accepted');
    return claims;
  }
  const current = now === undefined ? Date.now() / 1000 : now;
  if (current > exp + CLOCK_SKEW) throw new Error('identity token expired');
  if (Number(claims.iat || 0) > current + CLOCK_SKEW) throw new Error('identity token issued in the future');
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
  setIdentityPublicKeys,
  resetIdentityPublicKeys,
  setAcceptLegacyIdentityTokens,
  resetAcceptLegacyIdentityTokens,
  loadIdentityPublicKey,
  ed25519KeyId,
  unverifiedClaims,
  tokenFromAuthHeader,
  identityFromAuthHeader,
  requireScope,
};
