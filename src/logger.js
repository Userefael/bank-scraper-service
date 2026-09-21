'use strict';

/**
 * Safe logger. Only non-sensitive identifiers may be logged: provider,
 * connection_id, route, error_code, http status and timings.
 * Never pass credentials, passwords, OTP codes or decrypted payloads here.
 */

const ALLOWED_FIELDS = new Set([
  'route',
  'provider',
  'connection_id',
  'error_code',
  'status',
  'duration_ms',
  'transactions',
  'accounts',
  'event',
]);

function pick(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

function emit(level, message, fields) {
  const line = { level, msg: message, ...pick(fields) };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

module.exports = {
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};
