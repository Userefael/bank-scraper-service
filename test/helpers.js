'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || 'test-api-key';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DATA_DIR =
  process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'bank-scraper-test-'));

const { createApp } = require('../src/app');
const { setScraperFactory } = require('../src/scraper');
const { BaseScraper } = require('israeli-bank-scrapers/lib/scrapers/base-scraper');

const API_KEY = process.env.SCRAPER_API_KEY;

/**
 * Builds a fake scraper factory. `behaviour` receives the scraper options and
 * returns the handlers a test needs; anything it omits behaves like a provider
 * without two-factor support.
 */
function fakeFactory(behaviour) {
  return (options) => {
    const handlers = behaviour(options) || {};
    const scraper = {
      options,
      scrape: handlers.scrape || (async () => ({ success: true, accounts: [] })),
      onProgress: () => {},
    };
    // Matching the base implementation is how the service detects that a
    // provider has no two-factor flow.
    scraper.triggerTwoFactorAuth =
      handlers.triggerTwoFactorAuth || BaseScraper.prototype.triggerTwoFactorAuth;
    scraper.getLongTermTwoFactorToken =
      handlers.getLongTermTwoFactorToken || BaseScraper.prototype.getLongTermTwoFactorToken;
    return scraper;
  };
}

async function startServer() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function call(url, route, body, { apiKey = API_KEY, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey !== null) headers['X-API-Key'] = apiKey;
  const method = body === undefined && raw === undefined ? 'GET' : 'POST';
  const res = await fetch(`${url}${route}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

module.exports = { API_KEY, fakeFactory, setScraperFactory, startServer, call };
