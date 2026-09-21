'use strict';

const crypto = require('crypto');
const express = require('express');

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
const {
  buildScraper,
  closeQuietly,
  mapScrapeResult,
  resolveStartDate,
  supportsTwoFactor,
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
      logger.error('request_failed', { route, error_code: code });
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

      const scraper = buildScraper({ provider, startDate: resolveStartDate(null) });

      // Providers whose scraper implements the library's two-factor flow get a
      // session; the browser stays alive until /otp completes or the TTL ends.
      if (supportsTwoFactor(scraper) && !credentials.otpLongTermToken) {
        if (!isNonEmptyString(credentials.phoneNumber)) {
          await closeQuietly(scraper);
          return sendError(res, ERROR_CODES.INVALID_CREDENTIALS);
        }
        let triggered;
        try {
          triggered = await withTimeout(scraper, () => scraper.triggerTwoFactorAuth(credentials.phoneNumber));
        } catch (err) {
          await closeQuietly(scraper);
          throw err;
        }
        if (!triggered || triggered.success !== true) {
          await closeQuietly(scraper);
          const code = errorCodeFromScraperResult(triggered);
          logger.warn('connect_failed', { route: '/connect', provider, error_code: code });
          return sendError(res, code);
        }
        const sessionId = sessions.create({ provider, credentials, scraper });
        logger.info('otp_session_created', { route: '/connect', provider });
        return res.json({ ok: true, requires_otp: true, session_id: sessionId });
      }

      let result;
      try {
        result = await withTimeout(scraper, () => scraper.scrape(credentials));
      } finally {
        await closeQuietly(scraper);
      }

      if (!result || result.success !== true) {
        const code = errorCodeFromScraperResult(result);
        logger.warn('connect_failed', { route: '/connect', provider, error_code: code });
        return sendError(res, code);
      }

      const saved = await store.saveConnection({ provider, credentials });
      logger.info('connected', { route: '/connect', provider, connection_id: saved.connection_id });
      return res.json({ ok: true, connection_id: saved.connection_id });
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
        // An expired or unknown session is indistinguishable from here.
        logger.warn('otp_session_missing', { route: '/otp', error_code: ERROR_CODES.UNKNOWN });
        return sendError(res, ERROR_CODES.UNKNOWN, 400);
      }

      const tokenResult = await withTimeout(session.scraper, () =>
        session.scraper.getLongTermTwoFactorToken(String(otpCode)),
      );

      if (!tokenResult || tokenResult.success !== true) {
        session.otp_failures += 1;
        const code = errorCodeFromScraperResult(tokenResult);
        const exhausted = session.otp_failures >= config.MAX_OTP_ATTEMPTS;
        if (exhausted) sessions.remove(sessionId);
        logger.warn('otp_rejected', {
          route: '/otp',
          provider: session.provider,
          error_code: code,
          event: exhausted ? 'session_discarded' : 'attempt_failed',
        });
        return sendError(res, code);
      }

      const { provider } = session;
      const credentials = credentialsForStorage(session.credentials, tokenResult.longTermTwoFactorAuthToken);
      sessions.remove(sessionId);

      // Completing the login means proving the long term token actually works.
      const verifier = buildScraper({ provider, startDate: resolveStartDate(null) });
      let result;
      try {
        result = await withTimeout(verifier, () => verifier.scrape(credentials));
      } finally {
        await closeQuietly(verifier);
      }

      if (!result || result.success !== true) {
        const code = errorCodeFromScraperResult(result);
        logger.warn('otp_login_failed', { route: '/otp', provider, error_code: code });
        return sendError(res, code);
      }

      const saved = await store.saveConnection({ provider, credentials });
      logger.info('connected', { route: '/otp', provider, connection_id: saved.connection_id });
      return res.json({ ok: true, connection_id: saved.connection_id });
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
        const scraper = buildScraper({ provider, startDate: resolveStartDate(since) });
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
