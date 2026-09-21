'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const PREFIX = 'v1';

/**
 * Reads ENCRYPTION_KEY and returns a 32 byte key.
 * Accepts 64 hex chars or base64 of 32 bytes. Anything else fails loudly at
 * startup rather than silently weakening the encryption.
 */
function loadKey(raw = process.env.ENCRYPTION_KEY) {
  if (!raw) throw new Error('ENCRYPTION_KEY is not set');
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/=_-]+$/.test(value)) {
    const buf = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buf.length === KEY_BYTES) return buf;
  }
  throw new Error('ENCRYPTION_KEY must be 32 bytes, given as 64 hex chars or base64');
}

/** Encrypts an object to "v1:<iv>:<tag>:<ciphertext>" (all base64). */
function encryptJson(value, key = loadKey()) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/** Decrypts a payload produced by encryptJson. Throws on a wrong key or tampering. */
function decryptJson(payload, key = loadKey()) {
  if (typeof payload !== 'string') throw new Error('encrypted payload must be a string');
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error('unsupported encrypted payload format');
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = { loadKey, encryptJson, decryptJson, ALGORITHM };
