'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers');
const { encryptJson, decryptJson, loadKey } = require('../src/crypto');
const { mapScrapeResult, resolveStartDate, withTimeout } = require('../src/scraper');
const {
  CONNECT_START_DAYS_BACK,
  DEFAULT_START_DAYS_BACK,
  connectTimeoutMs,
  scrapeTimeoutMs,
} = require('../src/config');

test('credentials encrypt and decrypt with AES-256-GCM', () => {
  const credentials = { username: 'user', password: 'secret' };
  const payload = encryptJson(credentials);
  assert.match(payload, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.ok(!payload.includes('secret'));
  assert.deepEqual(decryptJson(payload), credentials);

  // Two encryptions of the same value differ (fresh IV each time).
  assert.notEqual(payload, encryptJson(credentials));
});

test('a tampered payload or a wrong key fails to decrypt', () => {
  const payload = encryptJson({ password: 'secret' });
  const parts = payload.split(':');
  const flipped = Buffer.from(parts[3], 'base64');
  flipped[0] ^= 0xff;
  parts[3] = flipped.toString('base64');
  assert.throws(() => decryptJson(parts.join(':')));
  assert.throws(() => decryptJson(payload, Buffer.alloc(32, 7)));
});

test('the encryption key must be 32 bytes', () => {
  assert.equal(loadKey('b'.repeat(64)).length, 32);
  assert.equal(loadKey(Buffer.alloc(32, 3).toString('base64')).length, 32);
  assert.throws(() => loadKey('too-short'), /32 bytes/);
  assert.throws(() => loadKey(''), /not set/);
});

test('resolveStartDate falls back to 90 days back', () => {
  const explicit = resolveStartDate('2026-01-15T00:00:00.000Z');
  assert.equal(explicit.toISOString(), '2026-01-15T00:00:00.000Z');

  for (const value of [null, undefined, '', 'not-a-date']) {
    const days = (Date.now() - resolveStartDate(value).getTime()) / 86400000;
    assert.ok(Math.abs(days - DEFAULT_START_DAYS_BACK) < 0.1, `${value} gave ${days} days`);
  }

  // A future date is clamped to now so the library never rejects it.
  const future = resolveStartDate(new Date(Date.now() + 86400000).toISOString());
  assert.ok(future.getTime() <= Date.now() + 1000);
});

test('resolveStartDate honours a shorter window', () => {
  const days = (Date.now() - resolveStartDate(null, CONNECT_START_DAYS_BACK).getTime()) / 86400000;
  assert.ok(Math.abs(days - CONNECT_START_DAYS_BACK) < 0.1, `got ${days} days`);
});

test('the scrape caps fall back to their defaults and follow the environment', (t) => {
  const saved = { scrape: process.env.SCRAPE_TIMEOUT_MS, connect: process.env.CONNECT_TIMEOUT_MS };
  t.after(() => {
    if (saved.scrape === undefined) delete process.env.SCRAPE_TIMEOUT_MS;
    else process.env.SCRAPE_TIMEOUT_MS = saved.scrape;
    if (saved.connect === undefined) delete process.env.CONNECT_TIMEOUT_MS;
    else process.env.CONNECT_TIMEOUT_MS = saved.connect;
  });

  delete process.env.SCRAPE_TIMEOUT_MS;
  delete process.env.CONNECT_TIMEOUT_MS;
  assert.equal(scrapeTimeoutMs(), 110000);
  assert.equal(connectTimeoutMs(), 90000);

  process.env.SCRAPE_TIMEOUT_MS = '45000';
  process.env.CONNECT_TIMEOUT_MS = '30000';
  assert.equal(scrapeTimeoutMs(), 45000);
  assert.equal(connectTimeoutMs(), 30000);

  // A nonsense value must not disable the cap.
  process.env.CONNECT_TIMEOUT_MS = 'soon';
  assert.equal(connectTimeoutMs(), 90000);
});

test('mapScrapeResult sums balances and keeps per transaction currency', () => {
  const mapped = mapScrapeResult({
    provider: 'leumi',
    accounts: [
      { balance: 100, currency: 'ILS', txns: [] },
      {
        balance: 25.5,
        txns: [
          {
            identifier: 'abc',
            date: '2026-09-01T00:00:00.000Z',
            processedDate: '2026-09-02T00:00:00.000Z',
            description: 'Amazon',
            chargedAmount: -40,
            originalCurrency: 'USD',
            status: 'completed',
          },
        ],
      },
    ],
  });
  assert.equal(mapped.balance, 125.5);
  assert.equal(mapped.currency, 'ILS');
  assert.equal(mapped.transactions[0].currency, 'USD');
});

test('mapScrapeResult handles a provider that reports no balance', () => {
  const mapped = mapScrapeResult({ provider: 'max', accounts: [{ txns: [] }] });
  assert.equal(mapped.balance, null);
  assert.equal(mapped.currency, 'ILS');
  assert.deepEqual(mapped.transactions, []);
});

test('withTimeout closes the browser and raises timeout', async () => {
  let closed = false;
  const scraper = {
    __closeBrowser: async () => {
      closed = true;
    },
  };
  await assert.rejects(
    withTimeout(scraper, () => new Promise(() => {}), 25),
    (err) => err.code === 'timeout' && err.status === 504,
  );
  assert.equal(closed, true);
});

test('logged reasons keep the diagnosis and drop the digits', () => {
  const { ERROR_CODES, errorCodeFromException } = require('../src/errors');

  assert.equal(
    errorCodeFromException(new Error('Failed to navigate to url https://login.bankhapoalim.co.il, status code: 403')),
    ERROR_CODES.SERVICE_UNAVAILABLE,
  );
  assert.equal(errorCodeFromException(new Error('waiting for selector timed out')), ERROR_CODES.TIMEOUT);
  assert.equal(errorCodeFromException(new Error('something else entirely')), ERROR_CODES.UNKNOWN);
});

test('the code boxes are recognised the way Bank Hapoalim draws them', () => {
  const { chooseOtpFields } = require('../src/scrapers/hapoalim-otp');

  const box = (index, extra = {}) => ({
    index,
    id: '',
    name: '',
    type: 'tel',
    placeholder: '',
    label: '',
    maxLength: 1,
    disabled: false,
    visible: true,
    ...extra,
  });

  // Five single character boxes, one per digit, is the real dialog.
  const five = chooseOtpFields([box(0), box(1), box(2), box(3), box(4)], { textMatches: true });
  assert.deepEqual(five, { mode: 'multi', indexes: [0, 1, 2, 3, 4] });

  // The login page itself must never look like a code challenge.
  const loginPage = chooseOtpFields(
    [
      box(0, { id: 'userCode', maxLength: null, type: 'text' }),
      box(1, { id: 'password', maxLength: null, type: 'password' }),
    ],
    { textMatches: false },
  );
  assert.equal(loginPage, null);

  // A single named field still works, whatever the page says.
  assert.deepEqual(
    chooseOtpFields([box(0, { id: 'otpCode', maxLength: 6 })], { textMatches: false }),
    { mode: 'single', indexes: [0] },
  );

  // A lone numeric field counts only when the page reads like a challenge.
  const bare = [box(0, { maxLength: 6 })];
  assert.equal(chooseOtpFields(bare, { textMatches: false }), null);
  assert.deepEqual(chooseOtpFields(bare, { textMatches: true }), { mode: 'single', indexes: [0] });

  // Hidden or disabled boxes are not entry points.
  assert.equal(
    chooseOtpFields([box(0, { visible: false }), box(1, { disabled: true })], { textMatches: true }),
    null,
  );
});
