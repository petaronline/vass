/**
 * AES-256-GCM encryption for secrets at rest.
 *
 * Used to encrypt the Meta App Secret and access token before storing in DB.
 * Key is derived from SESSION_SECRET using HKDF-like SHA-256 (one-way).
 *
 * Format of encrypted strings: base64(iv) + ':' + base64(authTag) + ':' + base64(ciphertext)
 *
 * If SESSION_SECRET ever changes, all stored secrets become unrecoverable.
 * Keep SESSION_SECRET in .env and back it up.
 */
import crypto from 'node:crypto';
import { env } from './env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, standard for GCM
const KEY_LENGTH = 32; // 256 bits

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  // Derive a 32-byte key from SESSION_SECRET deterministically
  cachedKey = crypto
    .createHash('sha256')
    .update('vass-secret-encryption-v1' + env.SESSION_SECRET)
    .digest()
    .subarray(0, KEY_LENGTH);
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function decryptSecret(encrypted: string): string {
  if (!encrypted) return '';
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted secret format');
  }
  const iv = Buffer.from(parts[0], 'base64');
  const authTag = Buffer.from(parts[1], 'base64');
  const ciphertext = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

// =====================================================================
// HMAC-signed tokens for short-lived public URLs (Patch 4.25).
//
// Used to grant Meta time-limited access to upload bytes so it can fetch
// images during organic publishing. The token encodes the upload id +
// an expiration timestamp, signed with the same SESSION_SECRET-derived
// key as the encryption helpers above (but a different HKDF input).
// =====================================================================

let cachedHmacKey: Buffer | null = null;

function getHmacKey(): Buffer {
  if (cachedHmacKey) return cachedHmacKey;
  cachedHmacKey = crypto
    .createHash('sha256')
    .update('vass-hmac-public-url-v1' + env.SESSION_SECRET)
    .digest();
  return cachedHmacKey;
}

/**
 * Sign a payload string with our HMAC key. Returns `${payload}.${sig}`
 * where sig is base64url over the raw HMAC-SHA256.
 */
export function signToken(payload: string): string {
  const sig = crypto
    .createHmac('sha256', getHmacKey())
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

/** Verify a token returned by signToken. Returns the payload on success,
 *  null on tamper or malformed token. */
export function verifyToken(token: string): string | null {
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return null;
  const payload = token.slice(0, lastDot);
  const presentedSig = token.slice(lastDot + 1);
  const expectedSig = crypto
    .createHmac('sha256', getHmacKey())
    .update(payload)
    .digest('base64url');
  // Constant-time compare
  const a = Buffer.from(presentedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return payload;
}

/**
 * Build a short-lived public access token for an upload id.
 * Payload format: `{uploadId}:{expiresAtMillis}`.
 */
export function makeUploadPublicToken(uploadId: string, ttlSeconds: number = 3600): string {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  return signToken(`${uploadId}:${expiresAt}`);
}

/**
 * Verify a public-upload token. Returns the upload id when the token
 * is valid AND the embedded expiration hasn't passed. Null otherwise.
 */
export function verifyUploadPublicToken(uploadId: string, token: string): boolean {
  const payload = verifyToken(token);
  if (!payload) return false;
  const [tokenUploadId, expiresStr] = payload.split(':');
  if (tokenUploadId !== uploadId) return false;
  const expiresAt = Number(expiresStr);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt < Date.now()) return false;
  return true;
}
