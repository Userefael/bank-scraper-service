'use strict';

const path = require('path');

/** Provider ids this service exposes (all exist in CompanyTypes of the installed library). */
const PROVIDERS = [
  'leumi',
  'hapoalim',
  'discount',
  'mizrahi',
  'otsarHahayal',
  'beinleumi',
  'massad',
  'yahav',
  'isracard',
  'amex',
  'visaCal',
  'max',
  'behatsdaa',
];

function msFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Caps on a single scrape. Both are env tunable because the limit that matters
 * in production is the gateway's: a cap above it turns into an opaque 504 for
 * the client instead of an { ok: false, error_code } body from this service.
 */
function scrapeTimeoutMs() {
  return msFromEnv('SCRAPE_TIMEOUT_MS', 110 * 1000);
}

function connectTimeoutMs() {
  return msFromEnv('CONNECT_TIMEOUT_MS', 90 * 1000);
}

const SESSION_TTL_MS = 3 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 3;
const DEFAULT_START_DAYS_BACK = 90;
/**
 * /connect only has to prove the credentials work; the transactions it would
 * fetch are discarded, and every extra month is time the caller waits for.
 */
const CONNECT_START_DAYS_BACK = 1;
const NAVIGATION_TIMEOUT_MS = 60 * 1000;

/**
 * Providers whose login this service drives itself so it can stop at the bank's
 * SMS code page and resume from /otp, as a comma separated environment value.
 * Empty by default: every provider then logs in through the library's own
 * scraper. Setting it to `hapoalim` turns on the flow in
 * src/scrapers/hapoalim-otp.js, which is the only one implemented.
 */
function interactiveOtpProviders() {
  return (process.env.INTERACTIVE_OTP_PROVIDERS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/** How long a login may run before the code page is expected to have appeared. */
function loginWaitMs() {
  return msFromEnv('LOGIN_WAIT_MS', 45 * 1000);
}

/**
 * How long /connect waits for a self-driven login before it answers with a
 * session and lets the login finish in the background. It has to be short:
 * the caller sits behind a gateway that gives up long before a bank login
 * ends, and an answer that arrives after that is an answer nobody receives.
 */
function fastAnswerMs() {
  return msFromEnv('FAST_ANSWER_MS', 8 * 1000);
}

const CHROMIUM_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

function dataDir() {
  return process.env.DATA_DIR || '/data';
}

function connectionsFile() {
  return path.join(dataDir(), 'connections.json');
}

function port() {
  return Number(process.env.PORT) || 3000;
}

function isProvider(value) {
  return typeof value === 'string' && PROVIDERS.includes(value);
}

module.exports = {
  PROVIDERS,
  scrapeTimeoutMs,
  connectTimeoutMs,
  CONNECT_START_DAYS_BACK,
  SESSION_TTL_MS,
  MAX_OTP_ATTEMPTS,
  DEFAULT_START_DAYS_BACK,
  NAVIGATION_TIMEOUT_MS,
  interactiveOtpProviders,
  loginWaitMs,
  fastAnswerMs,
  CHROMIUM_ARGS,
  dataDir,
  connectionsFile,
  port,
  isProvider,
};
