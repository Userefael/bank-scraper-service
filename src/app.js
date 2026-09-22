'use strict';

const crypto = require('crypto');
const express = require('express');

const browser = require('./browser');
const config = require('./config');
const logger = require('./logger');
const locks = require('./locks');
const sessions = require('./sessions');
const store = require('./store');
const {
  ApiError,
  ERROR_CODES,
  errorCodeFromException,
  errorCodeFromScraperResult,
  sendError,
} = require('./errors');
const { beginLogin } = require('./login');
const {
  buildScraper,
  closeQuietly,
  mapScrapeResult,
  resolveStartDate,
  withTimeout,
} = require('./scraper');

/** Constant-time comparison that never reveals the expected key's length. */
function secretsMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireApiKey(req, res, next) {
  if (!secretsMatch(req.get('X-API-Key'), process.env.SCRAPER_API_KEY)) {
    logger.warn('unauthorized', { route: req.path, status: 401 });
    return sendError(res, ERROR_CODES.INVALID_CREDENTIALS, 401);
  }
  return next();
}

/** Wraps an async handler so a rejection becomes a contract error response. */
function handler(route, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const code = errorCodeFromException(err);
      const status = err instanceof ApiError ? err.status : undefined;
      logger.error('request_failed', { route, error_code: code, reason: err && err.message });
      if (!res.headersSent) sendError(res, code, status);
    }
  };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCredentialsObject(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every((v) => typeof v === 'string' || typeof v === 'number')
  );
}

/**
 * Why a login the library reported as unsuccessful failed, for the log. The
 * library's `errorType` is a short token and its `errorMessage` is its own
 * wording, neither of which carries anything the customer typed; the logger
 * masks digit runs in it anyway.
 */
function scraperFailureReason(result) {
  if (!result) return 'no result';
  return [result.errorType, result.errorMessage].filter(Boolean).join(': ') || 'no error type';
}

/** Keeps only the credential fields the library accepts for a stored login. */
function credentialsForStorage(credentials, longTermToken) {
  const stored = { ...credentials, otpLongTermToken: longTermToken };
  delete stored.phoneNumber;
  delete stored.otpCodeRetriever;
  return stored;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use(requireApiKey);
  app.use(express.json({ limit: '64kb' }));

  app.get(
    '/health',
    handler('/health', async (_req, res) => {
      res.json({ ok: true, providers: config.PROVIDERS });
    }),
  );

  app.post(
    '/connect',
    handler('/connect', async (req, res) => {
      const { provider, credentials } = req.body || {};
      if (!config.isProvider(provider) || !isCredentialsObject(credentials)) {
        return sendError(res, ERROR_CODES.INVALID_CREDENTIALS);
      }

      // The id is minted here, before the login, because the browser profile
      // that carries this connection's device trust is named after it.
      const connectionId = crypto.randomUUID();
      // A connect only proves the credentials work, so it scrapes the shortest
      // window the library accepts; the transactions it returns are discarded.
      const startDate = resolveStartDate(null, config.CONNECT_START_DAYS_BACK);
      const handles = {};

      let outcome;
      try {
        outcome = await withTimeout(
          handles,
          () => beginLogin({ provider, credentials, connectionId, startDate, handles }),
          config.connectTimeoutMs(),
        );
      } catch (err) {
        await closeQuietly(handles);
        await browser.removeProfile(connectionId);
        throw err;
      }

      if (outcome.status === 'otp_required') {
        const sessionId = sessions.create({
          provider,
          credentials,
          flow: outcome.flow,
          connectionId,
        });
        logger.info('otp_session_created', { route: '/connect', provider });
        return res.json({ ok: true, requires_otp: true, session_id: sessionId });
      }

      if (outcome.status === 'failed') {
        await browser.removeProfile(connectionId);
        logger.warn('connect_failed', {
          route: '/connect',
          provider,
          error_code: outcome.errorCode,
          reason: outcome.outcome || 'login failed',
        });
        return sendError(res, outcome.errorCode);
      }

      const result = outcome.result;
      if (!result || result.success !== true) {
        await browser.removeProfile(connectionId);
        const code = errorCodeFromScraperResult(result);
        logger.warn('connect_failed', {
          route: '/connect',
          provider,
          error_code: code,
          reason: scraperFailureReason(result),
        });
        return sendError(res, code);
      }

      await store.saveConnection({ connectionId, provider, credentials });
      logger.info('connected', { route: '/connect', provider, connection_id: connectionId });
      return res.json({ ok: true, connection_id: connectionId });
    }),
  );

  app.post(
    '/otp',
    handler('/otp', async (req, res) => {
      const { session_id: sessionId, otp_code: otpCode } = req.body || {};
      if (!isNonEmptyString(sessionId) || !isNonEmptyString(String(otpCode ?? ''))) {
        return sendError(res, ERROR_CODES.INVALID_CREDENTIALS);
      }

      const session = sessions.get(sessionId);
      if (!session) {
        // Sessions hold a live browser, so they cannot outlive the process and
        // there is no telling an expired one from one lost to a restart. Both
        // mean the same thing to the caller: the code is stale, connect again.
        // `timeout` says that; `unknown` would read as a rejected code.
        logger.warn('otp_session_missing', { route: '/otp', error_code: ERROR_CODES.TIMEOUT });
        return sendError(res, ERROR_CODES.TIMEOUT, 400);
      }

      const { provider, connection_id: connectionId } = session;
      const outcome = await withTimeout(
        session.flow,
        () => session.flow.complete(String(otpCode)),
        config.connectTimeoutMs(),
      );

      if (outcome.status === 'otp_rejected') {
        session.otp_failures += 1;
        const exhausted = session.otp_failures >= config.MAX_OTP_ATTEMPTS;
        if (exhausted) {
          sessions.remove(sessionId);
          await browser.removeProfile(connectionId);
        }
        logger.warn('otp_rejected', {
          route: '/otp',
          provider,
          error_code: outcome.errorCode,
          event: exhausted ? 'session_discarded' : 'attempt_failed',
        });
        return sendError(res, outcome.errorCode);
      }

      const credentials = outcome.credentials || session.credentials;
      const result = outcome.result;
      sessions.remove(sessionId);

      if (outcome.status === 'failed' || !result || result.success !== true) {
        await browser.removeProfile(connectionId);
        const code = outcome.errorCode || errorCodeFromScraperResult(result);
        logger.warn('otp_login_failed', {
          route: '/otp',
          provider,
          error_code: code,
          reason: outcome.outcome || scraperFailureReason(result),
        });
        return sendError(res, code);
      }

      await store.saveConnection({ connectionId, provider, credentials });
      logger.info('connected', { route: '/otp', provider, connection_id: connectionId });
      return res.json({ ok: true, connection_id: connectionId });
    }),
  );

  /**
   * Runs a login and reports the page it ended on, so a login that fails in
   * production can be diagnosed without access to the logs. It saves nothing
   * and returns no values from the page, only element names and labels, but it
   * is a real login attempt against the bank: banks lock accounts that are
   * hammered, so this is for one deliberate run, not for polling.
   */
  app.post(
    '/debug/login',
    handler('/debug/login', async (req, res) => {
      const { provider, credentials } = req.body || {};
      if (!config.isProvider(provider) || !isCredentialsObject(credentials)) {
        return sendError(res, ERROR_CODES.INVALID_CREDENTIALS);
      }

      const connectionId = crypto.randomUUID();
      const handles = {};
      let outcome;
      // Everything this route opened is closed before it answers, so nothing
      // is left running or stored once the caller has its diagnosis.
      try {
        outcome = await withTimeout(
          handles,
          () =>
            beginLogin({
              provider,
              credentials,
              connectionId,
              startDate: resolveStartDate(null, config.CONNECT_START_DAYS_BACK),
              handles,
            }),
          config.connectTimeoutMs(),
        );
        if (outcome.status === 'otp_required') await outcome.flow.close();
      } finally {
        await closeQuietly(handles);
        await browser.removeProfile(connectionId);
      }

      logger.info('debug_login', { route: '/debug/login', provider, event: outcome.status });
      return res.json({
        ok: true,
        status: outcome.status,
        outcome: outcome.outcome || null,
        page: outcome.page || null,
      });
    }),
  );

  app.post(
    '/sync',
    handler('/sync', async (req, res) => {
      const { connection_id: connectionId, since } = req.body || {};
      if (!isNonEmptyString(connectionId)) return sendError(res, ERROR_CODES.INVALID_CREDENTIALS);

      const stored = await store.getCredentials(connectionId);
      if (!stored) {
        logger.warn('sync_unknown_connection', { route: '/sync', connection_id: connectionId });
        return sendError(res, ERROR_CODES.UNKNOWN, 404);
      }

      if (!locks.acquire(connectionId)) {
        logger.warn('sync_locked', { route: '/sync', connection_id: connectionId, status: 409 });
        return sendError(res, ERROR_CODES.SERVICE_UNAVAILABLE, 409);
      }

      const startedAt = Date.now();
      try {
        const { provider, credentials } = stored;
        const instance = await browser.launch({ profileDir: browser.profileDirFor(connectionId) });
        const scraper = buildScraper({ provider, startDate: resolveStartDate(since), browser: instance });
        let result;
        try {
          result = await withTimeout(scraper, () => scraper.scrape(credentials));
        } finally {
          await closeQuietly(scraper);
        }

        if (!result || result.success !== true) {
          const code = errorCodeFromScraperResult(result);
          logger.warn('sync_failed', { route: '/sync', provider, connection_id: connectionId, error_code: code });
          return sendError(res, code);
        }

        const mapped = mapScrapeResult({ provider, accounts: result.accounts });
        logger.info('synced', {
          route: '/sync',
          provider,
          connection_id: connectionId,
          accounts: Array.isArray(result.accounts) ? result.accounts.length : 0,
          transactions: mapped.transactions.length,
          duration_ms: Date.now() - startedAt,
        });
        return res.json({ ok: true, ...mapped });
      } finally {
        locks.release(connectionId);
      }
    }),
  );

  app.post(
    '/disconnect',
    handler('/disconnect', async (req, res) => {
      const { connection_id: connectionId } = req.body || {};
      if (!isNonEmptyString(connectionId)) return sendError(res, ERROR_CODES.INVALID_CREDENTIALS);
      const removed = await store.deleteConnection(connectionId);
      // The profile holds this bank's cookies, so it goes with the connection.
      await browser.removeProfile(connectionId);
      logger.info('disconnected', {
        route: '/disconnect',
        connection_id: connectionId,
        event: removed ? 'deleted' : 'already_absent',
      });
      return res.json({ ok: true });
    }),
  );

  app.use((_req, res) => sendError(res, ERROR_CODES.UNKNOWN, 404));

  // Malformed JSON and any other middleware failure, without echoing the body.
  app.use((err, req, res, _next) => {
    const badRequest = err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' || err.status === 400);
    const code = badRequest ? ERROR_CODES.UNKNOWN : errorCodeFromException(err);
    logger.error('request_rejected', { route: req.path, error_code: code });
    return sendError(res, code, badRequest ? 400 : undefined);
  });

  return app;
}

module.exports = { createApp };
