'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  call,
  fakeBrowser,
  fakeFactory,
  setInteractiveScraperFactory,
  setScraperFactory,
  startServer,
} = require('./helpers');
const { ALL_ERROR_CODES } = require('../src/errors');
const { PROVIDERS } = require('../src/config');
const sessions = require('../src/sessions');

test.beforeEach(() => {
  fakeBrowser();
});

const ACCOUNTS = [
  {
    accountNumber: '12345',
    balance: 1500.5,
    currency: 'ILS',
    txns: [
      {
        type: 'normal',
        identifier: 777,
        date: '2026-09-01T00:00:00.000Z',
        processedDate: '2026-09-03T00:00:00.000Z',
        originalAmount: -50,
        originalCurrency: 'ILS',
        chargedAmount: -50,
        chargedCurrency: 'ILS',
        description: 'סופר',
        status: 'completed',
        memo: 'should not reach the client',
      },
      {
        type: 'normal',
        date: '2026-09-05T00:00:00.000Z',
        processedDate: '',
        originalAmount: -12,
        originalCurrency: 'ILS',
        chargedAmount: -12,
        description: 'קפה',
        status: 'pending',
      },
      {
        type: 'normal',
        date: '2026-09-05T00:00:00.000Z',
        processedDate: '',
        originalAmount: -12,
        originalCurrency: 'ILS',
        chargedAmount: -12,
        description: 'קפה',
        status: 'pending',
      },
    ],
  },
];

function assertErrorShape(response) {
  assert.deepEqual(Object.keys(response.body).sort(), ['error_code', 'ok']);
  assert.equal(response.body.ok, false);
  assert.ok(ALL_ERROR_CODES.includes(response.body.error_code), `unexpected code ${response.body.error_code}`);
}

test('every route rejects a missing or wrong API key with 401', async (t) => {
  setScraperFactory(fakeFactory(() => ({})));
  const server = await startServer();
  t.after(() => server.close());

  for (const [route, body] of [
    ['/health', undefined],
    ['/connect', { provider: 'leumi', credentials: { username: 'u', password: 'p' } }],
    ['/otp', { session_id: 'x', otp_code: '1234' }],
    ['/sync', { connection_id: 'x' }],
    ['/disconnect', { connection_id: 'x' }],
  ]) {
    const missing = await call(server.url, route, body, { apiKey: null });
    assert.equal(missing.status, 401, `${route} without a key`);
    assertErrorShape(missing);

    const wrong = await call(server.url, route, body, { apiKey: 'nope' });
    assert.equal(wrong.status, 401, `${route} with a wrong key`);
    assertErrorShape(wrong);
  }
});

test('GET /health lists the supported providers', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const res = await call(server.url, '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.providers, PROVIDERS);
});

test('connect, sync, disconnect round trip', async (t) => {
  const seen = [];
  setScraperFactory(
    fakeFactory((options) => {
      seen.push(options);
      return { scrape: async () => ({ success: true, accounts: ACCOUNTS }) };
    }),
  );
  const server = await startServer();
  t.after(() => server.close());

  const connected = await call(server.url, '/connect', {
    provider: 'leumi',
    credentials: { username: 'user', password: 'secret' },
  });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.ok, true);
  assert.match(connected.body.connection_id, /^[0-9a-f-]{36}$/);

  // /connect only validates the login, so it asks for the shortest window;
  // fetching 90 days here would be time the caller waits for and data we drop.
  const connectOptions = seen[0];
  assert.equal(connectOptions.companyId, 'leumi');
  assert.equal(connectOptions.combineInstallments, false);
  const daysBack = (Date.now() - connectOptions.startDate.getTime()) / 86400000;
  assert.ok(daysBack > 0.9 && daysBack < 1.1, `startDate was ${daysBack} days back`);

  const connectionId = connected.body.connection_id;
  const synced = await call(server.url, '/sync', {
    connection_id: connectionId,
    since: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(synced.status, 200);
  assert.deepEqual(Object.keys(synced.body).sort(), ['balance', 'currency', 'ok', 'transactions']);
  assert.equal(synced.body.balance, 1500.5);
  assert.equal(synced.body.currency, 'ILS');
  assert.equal(seen[1].startDate.toISOString(), '2026-09-01T00:00:00.000Z');

  const [first, second, third] = synced.body.transactions;
  assert.deepEqual(Object.keys(first).sort(), [
    'amount',
    'charge_date',
    'currency',
    'date',
    'description',
    'external_id',
    'is_pending',
  ]);
  assert.deepEqual(first, {
    external_id: '777',
    date: '2026-09-01T00:00:00.000Z',
    charge_date: '2026-09-03T00:00:00.000Z',
    description: 'סופר',
    amount: -50,
    currency: 'ILS',
    is_pending: false,
  });
  // No identifier: a stable hash, and charge_date falls back to date.
  assert.match(second.external_id, /^[0-9a-f]{24}$/);
  assert.equal(second.charge_date, second.date);
  assert.equal(second.is_pending, true);
  // An identical transaction stays distinguishable.
  assert.equal(third.external_id, `${second.external_id}#2`);

  const disconnected = await call(server.url, '/disconnect', { connection_id: connectionId });
  assert.equal(disconnected.status, 200);
  assert.deepEqual(disconnected.body, { ok: true });

  const gone = await call(server.url, '/sync', { connection_id: connectionId });
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error_code, 'unknown');

  // Disconnect is idempotent.
  const again = await call(server.url, '/disconnect', { connection_id: connectionId });
  assert.deepEqual(again.body, { ok: true });
});

test('library failures map to the allowed error codes', async (t) => {
  const cases = [
    ['INVALID_PASSWORD', 'invalid_credentials', 400],
    ['CHANGE_PASSWORD', 'invalid_credentials', 400],
    ['ACCOUNT_BLOCKED', 'blocked', 403],
    ['TIMEOUT', 'timeout', 504],
    ['TWO_FACTOR_RETRIEVER_MISSING', 'otp_required', 400],
    ['GENERIC', 'unknown', 500],
    ['GENERAL_ERROR', 'unknown', 500],
    ['SOMETHING_NEW', 'unknown', 500],
  ];
  const server = await startServer();
  t.after(() => server.close());

  for (const [errorType, expectedCode, expectedStatus] of cases) {
    setScraperFactory(
      fakeFactory(() => ({
        scrape: async () => ({ success: false, errorType, errorMessage: 'nope' }),
      })),
    );
    const res = await call(server.url, '/connect', {
      provider: 'max',
      credentials: { username: 'user', password: 'secret' },
    });
    assertErrorShape(res);
    assert.equal(res.body.error_code, expectedCode, errorType);
    assert.equal(res.status, expectedStatus, errorType);
  }
});

test('a thrown launch failure becomes service_unavailable', async (t) => {
  setScraperFactory(
    fakeFactory(() => ({
      scrape: async () => {
        throw new Error('Failed to launch the browser process');
      },
    })),
  );
  const server = await startServer();
  t.after(() => server.close());

  const res = await call(server.url, '/connect', {
    provider: 'leumi',
    credentials: { username: 'user', password: 'secret' },
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.error_code, 'service_unavailable');
});

test('bad input is rejected without reaching a scraper', async (t) => {
  let built = 0;
  setScraperFactory(
    fakeFactory(() => {
      built += 1;
      return {};
    }),
  );
  const server = await startServer();
  t.after(() => server.close());

  const cases = [
    ['/connect', { provider: 'notabank', credentials: { username: 'u', password: 'p' } }],
    ['/connect', { provider: 'leumi' }],
    ['/connect', { provider: 'leumi', credentials: {} }],
    ['/sync', {}],
    ['/disconnect', {}],
    ['/otp', { session_id: 'abc' }],
  ];
  for (const [route, body] of cases) {
    const res = await call(server.url, route, body);
    assert.equal(res.status, 400, `${route} ${JSON.stringify(body)}`);
    assert.equal(res.body.error_code, 'invalid_credentials');
  }
  assert.equal(built, 0);

  const malformed = await call(server.url, '/sync', undefined, { raw: '{"connection_id":' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error_code, 'unknown');

  const notFound = await call(server.url, '/nope', {});
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error_code, 'unknown');
});

test('the OTP flow issues a session, counts failures and stores the connection', async (t) => {
  const triggered = [];
  setScraperFactory(
    fakeFactory(() => ({
      triggerTwoFactorAuth: async (phoneNumber) => {
        triggered.push(phoneNumber);
        return { success: true };
      },
      getLongTermTwoFactorToken: async (otpCode) =>
        otpCode === '1234'
          ? { success: true, longTermTwoFactorAuthToken: 'long-term-token' }
          : { success: false, errorType: 'INVALID_PASSWORD', errorMessage: 'bad code' },
      scrape: async (credentials) =>
        credentials.otpLongTermToken === 'long-term-token'
          ? { success: true, accounts: ACCOUNTS }
          : { success: false, errorType: 'INVALID_PASSWORD', errorMessage: 'no token' },
    })),
  );
  const server = await startServer();
  t.after(() => {
    sessions.clear();
    return server.close();
  });

  const credentials = { email: 'a@b.c', password: 'secret', phoneNumber: '0500000000' };
  const started = await call(server.url, '/connect', { provider: 'leumi', credentials });
  assert.equal(started.status, 200);
  assert.deepEqual(Object.keys(started.body).sort(), ['ok', 'requires_otp', 'session_id']);
  assert.equal(started.body.requires_otp, true);
  assert.deepEqual(triggered, ['0500000000']);

  // Three wrong codes discard the session.
  const sessionId = started.body.session_id;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await call(server.url, '/otp', { session_id: sessionId, otp_code: '0000' });
    assert.equal(res.body.error_code, 'invalid_credentials', `attempt ${attempt}`);
    assert.equal(res.status, 400);
  }
  const afterDiscard = await call(server.url, '/otp', { session_id: sessionId, otp_code: '1234' });
  assert.equal(afterDiscard.status, 400);
  assert.equal(afterDiscard.body.error_code, 'unknown');

  // A fresh session with the right code yields a connection.
  const restarted = await call(server.url, '/connect', { provider: 'leumi', credentials });
  const done = await call(server.url, '/otp', {
    session_id: restarted.body.session_id,
    otp_code: '1234',
  });
  assert.equal(done.status, 200);
  assert.match(done.body.connection_id, /^[0-9a-f-]{36}$/);
  assert.equal(sessions.size(), 0);

  // The stored credentials carry the long term token, so /sync needs no OTP.
  const synced = await call(server.url, '/sync', { connection_id: done.body.connection_id });
  assert.equal(synced.status, 200);
  assert.equal(synced.body.transactions.length, 3);

  const unknownSession = await call(server.url, '/otp', { session_id: 'no-such-session', otp_code: '1234' });
  assert.equal(unknownSession.status, 400);
  assert.equal(unknownSession.body.error_code, 'unknown');
});

test('a second sync of the same connection gets 409', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let scrapes = 0;
  setScraperFactory(
    fakeFactory(() => ({
      scrape: async () => {
        scrapes += 1;
        if (scrapes > 1) await gate;
        return { success: true, accounts: ACCOUNTS };
      },
    })),
  );
  const server = await startServer();
  t.after(() => server.close());

  const connected = await call(server.url, '/connect', {
    provider: 'isracard',
    credentials: { id: '1', card6Digits: '123456', password: 'secret' },
  });
  const connectionId = connected.body.connection_id;

  const first = call(server.url, '/sync', { connection_id: connectionId });
  // Give the first request time to take the lock before the second arrives.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await call(server.url, '/sync', { connection_id: connectionId });
  assert.equal(second.status, 409);
  assert.equal(second.body.error_code, 'service_unavailable');

  release();
  const firstResult = await first;
  assert.equal(firstResult.status, 200);

  // The lock is released, so a later sync succeeds.
  const third = await call(server.url, '/sync', { connection_id: connectionId });
  assert.equal(third.status, 200);
});

/** Stands in for the Bank Hapoalim flow this service drives itself. */
function fakeInteractiveScraper({ outcome, codes = ['1234'], accounts = ACCOUNTS }) {
  const state = { finished: null, attempts: 0 };
  setInteractiveScraperFactory(() => ({
    getLoginOptions: () => ({ possibleResults: { SUCCESS: ['https://bank/home'] } }),
    beginLogin: async () => outcome,
    completeOtp: async (code) => {
      state.attempts += 1;
      return codes.includes(code) ? 'success' : 'invalid_password';
    },
    fetchAfterLogin: async () => ({ success: true, accounts }),
    finish: async (success) => {
      state.finished = success;
    },
    describePage: async () => ({ url: 'https://bank/unknown', title: '', inputs: [], buttons: [] }),
  }));
  return state;
}

test('hapoalim stops at the code page and resumes from /otp', async (t) => {
  const state = fakeInteractiveScraper({ outcome: 'otp_required' });
  const server = await startServer();
  t.after(() => {
    sessions.clear();
    return server.close();
  });

  const started = await call(server.url, '/connect', {
    provider: 'hapoalim',
    credentials: { userCode: 'user', password: 'secret' },
  });
  assert.equal(started.status, 200);
  assert.deepEqual(Object.keys(started.body).sort(), ['ok', 'requires_otp', 'session_id']);
  assert.equal(started.body.requires_otp, true);

  // A wrong code keeps the session open for another try.
  const wrong = await call(server.url, '/otp', {
    session_id: started.body.session_id,
    otp_code: '0000',
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error_code, 'invalid_credentials');
  assert.equal(sessions.size(), 1);

  const done = await call(server.url, '/otp', {
    session_id: started.body.session_id,
    otp_code: '1234',
  });
  assert.equal(done.status, 200);
  assert.match(done.body.connection_id, /^[0-9a-f-]{36}$/);
  assert.equal(state.finished, true);
  assert.equal(sessions.size(), 0);

  // The connection is usable afterwards, with no second code.
  setScraperFactory(fakeFactory(() => ({ scrape: async () => ({ success: true, accounts: ACCOUNTS }) })));
  const synced = await call(server.url, '/sync', { connection_id: done.body.connection_id });
  assert.equal(synced.status, 200);
  assert.equal(synced.body.transactions.length, 3);
});

test('three wrong codes end the hapoalim session', async (t) => {
  fakeInteractiveScraper({ outcome: 'otp_required' });
  const server = await startServer();
  t.after(() => {
    sessions.clear();
    return server.close();
  });

  const started = await call(server.url, '/connect', {
    provider: 'hapoalim',
    credentials: { userCode: 'user', password: 'secret' },
  });
  const sessionId = started.body.session_id;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await call(server.url, '/otp', { session_id: sessionId, otp_code: '0000' });
    assert.equal(res.body.error_code, 'invalid_credentials', `attempt ${attempt}`);
  }
  assert.equal(sessions.size(), 0);

  const afterwards = await call(server.url, '/otp', { session_id: sessionId, otp_code: '1234' });
  assert.equal(afterwards.body.error_code, 'unknown');
});

test('a hapoalim login that needs no code connects straight away', async (t) => {
  fakeInteractiveScraper({ outcome: 'success' });
  const server = await startServer();
  t.after(() => server.close());

  const res = await call(server.url, '/connect', {
    provider: 'hapoalim',
    credentials: { userCode: 'user', password: 'secret' },
  });
  assert.equal(res.status, 200);
  assert.match(res.body.connection_id, /^[0-9a-f-]{36}$/);
});

test('a rejected hapoalim login maps to invalid_credentials', async (t) => {
  fakeInteractiveScraper({ outcome: 'invalid_password' });
  const server = await startServer();
  t.after(() => server.close());

  const res = await call(server.url, '/connect', {
    provider: 'hapoalim',
    credentials: { userCode: 'user', password: 'wrong' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error_code, 'invalid_credentials');
});

test('the browser profile lives and dies with the connection', async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  setScraperFactory(fakeFactory(() => ({ scrape: async () => ({ success: true, accounts: ACCOUNTS }) })));
  const server = await startServer();
  t.after(() => server.close());

  const connected = await call(server.url, '/connect', {
    provider: 'discount',
    credentials: { id: '1', password: 'secret', num: '2' },
  });
  const profile = path.join(process.env.DATA_DIR, 'profiles', connected.body.connection_id);
  assert.equal(fs.existsSync(profile), true, 'profile created for the connection');

  await call(server.url, '/disconnect', { connection_id: connected.body.connection_id });
  assert.equal(fs.existsSync(profile), false, 'profile removed with the connection');
});
