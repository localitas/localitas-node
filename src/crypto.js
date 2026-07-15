/**
 * Client-side AES-256-GCM encryption — mirrors the Go client's crypto.go.
 *
 * Produces/consumes the platform's `enc:`-prefixed format so values encrypted
 * here interoperate with Go components. The 32-byte key lives at
 * `~/.localitas/secret.key` and is auto-generated on first use.
 *
 * Uses Node's built-in `crypto` module — no external dependency.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

let cachedKey = null;

function getOrCreateKey() {
  if (cachedKey) return cachedKey;
  const keyPath = path.join(os.homedir(), '.localitas', 'secret.key');
  try {
    const data = fs.readFileSync(keyPath);
    if (data.length === 32) {
      cachedKey = data;
      return cachedKey;
    }
  } catch (_) {
    // fall through to generate
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  cachedKey = key;
  return cachedKey;
}

/** Encrypt a string, returning `enc:` + base64(nonce || ciphertext || tag).
 *  Empty input returns empty string. */
function encrypt(plaintext) {
  if (plaintext === '') return '';
  const key = getOrCreateKey();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Go's gcm.Seal appends the tag to the ciphertext; match that layout.
  return 'enc:' + Buffer.concat([nonce, ct, tag]).toString('base64');
}

/** Decrypt a value produced by {@link encrypt}. Values not prefixed with `enc:`
 *  are returned unchanged (plaintext passthrough). */
function decrypt(encoded) {
  if (encoded === '') return '';
  if (!encoded.startsWith('enc:')) return encoded;
  const raw = Buffer.from(encoded.slice(4), 'base64');
  if (raw.length < 12 + 16) throw new Error('ciphertext too short');
  const key = getOrCreateKey();
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
