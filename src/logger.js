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
  'reason',
]);

/**
 * Error messages from the library and puppeteer name URLs, selectors and HTTP
 * status codes, which are what makes a failure diagnosable. Digit runs are
 * masked anyway so that no code, card or account number can ride along.
 */
function scrubReason(value) {
  return String(value).replace(/\d{4,}/g, '***').slice(0, 200);
}

function pick(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (value === undefined || value === null) continue;
    out[key] = key === 'reason' ? scrubReason(value) : value;
  }
  return out;
}

function emit(level, message, fields) {
  const line = { level, msg: message, ...pick(fields) };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * Page-shape diagnostics for a login that landed somewhere unexpected. The
 * payload is built from element names, types and labels only, never values,
 * which is why it can be logged without a flag: a login nobody can diagnose
 * is worse than a log line nobody reads.
 */
function diagnostic(message, payload) {
  if (!payload) return;
  process.stdout.write(`${JSON.stringify({ level: 'debug', msg: message, page: payload })}\n`);
}

module.exports = {
  diagnostic,
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};
