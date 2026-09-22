'use strict';

const crypto = require('crypto');

const { createScraper } = require('israeli-bank-scrapers');
const { BaseScraper } = require('israeli-bank-scrapers/lib/scrapers/base-scraper');

const {
  CHROMIUM_ARGS,
  DEFAULT_START_DAYS_BACK,
  NAVIGATION_TIMEOUT_MS,
  scrapeTimeoutMs,
} = require('./config');
const { ApiError, ERROR_CODES } = require('./errors');

/** Swappable so tests can drive the routes without launching a browser. */
let scraperFactory = createScraper;

function setScraperFactory(factory) {
  scraperFactory = factory || createScraper;
}

/**
 * Builds a scraper for a provider. The browser instance is captured through
 * the `prepareBrowser` hook so a scrape that overruns can be torn down.
 */
function buildScraper({ provider, startDate }) {
  const state = { browser: null };
  const options = {
    companyId: provider,
    startDate,
    combineInstallments: false,
    args: CHROMIUM_ARGS,
    timeout: NAVIGATION_TIMEOUT_MS,
    defaultTimeout: NAVIGATION_TIMEOUT_MS,
    prepareBrowser: async (browser) => {
      state.browser = browser;
    },
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const scraper = scraperFactory(options);
  scraper.__closeBrowser = async () => {
    const browser = state.browser;
    state.browser = null;
    if (browser && typeof browser.close === 'function') await browser.close();
  };
  return scraper;
}

/** True when this provider's scraper implements the library's two-factor flow. */
function supportsTwoFactor(scraper) {
  return (
    typeof scraper.triggerTwoFactorAuth === 'function' &&
    scraper.triggerTwoFactorAuth !== BaseScraper.prototype.triggerTwoFactorAuth
  );
}

async function closeQuietly(scraper) {
  if (!scraper || typeof scraper.__closeBrowser !== 'function') return;
  try {
    await scraper.__closeBrowser();
  } catch {
    /* nothing useful to do, and nothing loggable here */
  }
}

/**
 * Runs a scraper call under the 110 second cap. On overrun the browser is
 * closed and a timeout error code is raised.
 */
async function withTimeout(scraper, run, timeoutMs = scrapeTimeoutMs()) {
  let timer = null;
  const pending = Promise.resolve().then(run);
  try {
    return await Promise.race([
      pending,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new ApiError(ERROR_CODES.TIMEOUT, { internalMessage: 'scrape timeout' })), timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.code === ERROR_CODES.TIMEOUT) {
      pending.catch(() => {});
      await closeQuietly(scraper);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** startDate for a scrape: `since` when usable, otherwise `daysBack` days back. */
function resolveStartDate(since, daysBack = DEFAULT_START_DAYS_BACK) {
  const fallback = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  if (since === undefined || since === null || since === '') return fallback;
  const parsed = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(parsed.getTime())) return fallback;
  if (parsed.getTime() > Date.now()) return new Date();
  return parsed;
}

function hashedExternalId({ provider, date, description, amount }) {
  return crypto
    .createHash('sha1')
    .update(`${provider}|${date}|${description}|${amount}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * Flattens the library's accounts into the wire contract.
 * Field names verified against israeli-bank-scrapers 6.12.1
 * (lib/transactions.d.ts): identifier, date, processedDate, description,
 * chargedAmount, chargedCurrency, status.
 */
function mapScrapeResult({ provider, accounts }) {
  const list = Array.isArray(accounts) ? accounts : [];

  let balance = null;
  for (const account of list) {
    if (typeof account.balance === 'number' && Number.isFinite(account.balance)) {
      balance = (balance || 0) + account.balance;
    }
  }

  let currency = list.find((account) => account.currency)?.currency || null;
  const transactions = [];
  const seen = new Map();

  for (const account of list) {
    const accountCurrency = account.currency || null;
    for (const txn of account.txns || []) {
      const date = txn.date || null;
      const description = txn.description || '';
      const amount = typeof txn.chargedAmount === 'number' ? txn.chargedAmount : Number(txn.chargedAmount) || 0;
      const txnCurrency = txn.chargedCurrency || txn.originalCurrency || accountCurrency || 'ILS';

      let externalId =
        txn.identifier === undefined || txn.identifier === null || txn.identifier === ''
          ? hashedExternalId({ provider, date, description, amount })
          : String(txn.identifier);
      const count = (seen.get(externalId) || 0) + 1;
      seen.set(externalId, count);
      if (count > 1) externalId = `${externalId}#${count}`;

      if (!currency) currency = txnCurrency;

      transactions.push({
        external_id: externalId,
        date,
        charge_date: txn.processedDate || date,
        description,
        amount,
        currency: txnCurrency,
        is_pending: txn.status === 'pending',
      });
    }
  }

  return { balance, currency: currency || 'ILS', transactions };
}

module.exports = {
  buildScraper,
  supportsTwoFactor,
  withTimeout,
  closeQuietly,
  resolveStartDate,
  mapScrapeResult,
  setScraperFactory,
};
