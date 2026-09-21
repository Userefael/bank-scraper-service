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

const SCRAPE_TIMEOUT_MS = 110 * 1000;
const SESSION_TTL_MS = 3 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 3;
const DEFAULT_START_DAYS_BACK = 90;
const NAVIGATION_TIMEOUT_MS = 60 * 1000;

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
  SCRAPE_TIMEOUT_MS,
  SESSION_TTL_MS,
  MAX_OTP_ATTEMPTS,
  DEFAULT_START_DAYS_BACK,
  NAVIGATION_TIMEOUT_MS,
  CHROMIUM_ARGS,
  dataDir,
  connectionsFile,
  port,
  isProvider,
};
