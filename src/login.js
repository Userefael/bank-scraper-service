'use strict';

const browser = require('./browser');
const config = require('./config');
const logger = require('./logger');
const { ERROR_CODES, errorCodeFromScraperResult } = require('./errors');
const { HapoalimOtpScraper, LOGIN_OUTCOMES } = require('./scrapers/hapoalim-otp');
const { buildScraper, closeQuietly, supportsTwoFactor } = require('./scraper');

/**
 * One entry point for the three ways a login can go, so the routes do not have
 * to know which provider needs which dance:
 *
 *   - a provider this service drives itself (Hapoalim), which can stop at the
 *     bank's SMS code page and resume when /otp brings the code;
 *   - a provider whose scraper implements the library's own two-factor flow;
 *   - everything else, where a plain scrape either logs in or does not.
 *
 * Every connection gets a Chromium profile on the volume, so a bank that
 * challenges an unrecognised device only challenges the first login.
 */

/** Swappable so tests can drive the interactive flow without a real bank. */
let interactiveScraperFactory = (options) => new HapoalimOtpScraper(options);

function setInteractiveScraperFactory(factory) {
  interactiveScraperFactory = factory || ((options) => new HapoalimOtpScraper(options));
}

const OUTCOME_ERROR_CODES = {
  [LOGIN_OUTCOMES.INVALID_PASSWORD]: ERROR_CODES.INVALID_CREDENTIALS,
  [LOGIN_OUTCOMES.CHANGE_PASSWORD]: ERROR_CODES.INVALID_CREDENTIALS,
  [LOGIN_OUTCOMES.UNKNOWN]: ERROR_CODES.UNKNOWN,
};

function isInteractive(provider) {
  return config.interactiveOtpProviders().includes(provider);
}

/** Records the browser on `handles` so a timeout can still close it. */
function trackBrowser(handles, instance) {
  handles.__closeBrowser = async () => {
    try {
      await instance.close();
    } catch {
      // Already closed by the library's own terminate step.
    }
  };
}

const PENDING = Symbol('login still running');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function beginInteractiveLogin({ provider, credentials, connectionId, startDate, handles }) {
  const instance = await browser.launch({ profileDir: browser.profileDirFor(connectionId) });
  trackBrowser(handles, instance);

  const scraper = interactiveScraperFactory({
    companyId: provider,
    startDate,
    combineInstallments: false,
    browser: instance,
    defaultTimeout: config.NAVIGATION_TIMEOUT_MS,
  });
  const possibleResults = scraper.getLoginOptions(credentials).possibleResults;

  const finish = async (success) => {
    try {
      await scraper.finish(success);
    } catch {
      await closeQuietly(handles);
    }
  };

  const failure = async (outcome) => {
    const page = await scraper.describePage().catch(() => null);
    if (outcome === LOGIN_OUTCOMES.UNKNOWN) {
      // Only reachable when the bank showed something this service does not know.
      logger.diagnostic('login_page_unrecognised', page);
    }
    await finish(false);
    logger.warn('login_outcome', { provider, event: outcome });
    return {
      status: 'failed',
      outcome,
      page,
      errorCode: OUTCOME_ERROR_CODES[outcome] || ERROR_CODES.UNKNOWN,
    };
  };

  // A login that succeeded needs no data here: /connect only proves the
  // credentials, and /sync is what fetches. Skipping the throwaway scrape is
  // what lets /otp answer while the customer is still holding the code.
  const connected = async () => {
    await finish(true);
    return { status: 'connected', result: { success: true, accounts: [] } };
  };

  const login = scraper.beginLogin(credentials);
  login.catch(() => {});

  const raced = await Promise.race([
    login.then((outcome) => ({ outcome }), (error) => ({ error })),
    delay(config.fastAnswerMs()).then(() => PENDING),
  ]);

  if (raced !== PENDING) {
    if (raced.error) {
      logger.diagnostic('login_page_unrecognised', await scraper.describePage().catch(() => null));
      await finish(false);
      throw raced.error;
    }
    if (raced.outcome === LOGIN_OUTCOMES.SUCCESS) return connected();
    if (raced.outcome !== LOGIN_OUTCOMES.OTP_REQUIRED) return failure(raced.outcome);
  }

  // Either the code dialog is already up, or the login is taking longer than
  // this service is willing to hold the request open. Both answer now with a
  // session: the bank has sent the code by then, or is about to, and the
  // customer can be typing it while this finishes.
  logger.info('otp_session_opened', {
    provider,
    event: raced === PENDING ? 'login_pending' : 'code_page_reached',
  });

  // A session handed out on a pending login is a guess, and the guess is only
  // settled later, inside the browser. Logging what it settled on is the only
  // way to tell a real code challenge from a login that was merely slow.
  if (raced === PENDING) {
    login.then(
      (outcome) => logger.info('login_settled', { provider, event: outcome }),
      (error) => logger.warn('login_settled', { provider, event: 'error', reason: error && error.message }),
    );
  }

  return {
    status: 'otp_required',
    outcome: LOGIN_OUTCOMES.OTP_REQUIRED,
    page: raced === PENDING ? null : await scraper.describePage().catch(() => null),
    flow: {
      __closeBrowser: handles.__closeBrowser,
      close: () => finish(false),
      complete: async (code) => {
        // The login may still be running when the code arrives.
        const settled = await login.catch((error) => ({ error }));
        if (settled && settled.error) throw settled.error;
        if (settled === LOGIN_OUTCOMES.SUCCESS) return connected();
        if (settled !== LOGIN_OUTCOMES.OTP_REQUIRED) return failure(settled);

        const verdict = await scraper.completeOtp(code, possibleResults);
        if (verdict === LOGIN_OUTCOMES.SUCCESS) return connected();
        if (verdict === LOGIN_OUTCOMES.INVALID_PASSWORD) {
          // A rejected code and a code the dialog never received look the same
          // from here, so the dialog's own shape goes to the log: whether it is
          // still up, and what it is offering now.
          logger.diagnostic('otp_page_after_submit', await scraper.describePage().catch(() => null));
          // The session stays open so the caller can try another code.
          return { status: 'otp_rejected', errorCode: ERROR_CODES.INVALID_CREDENTIALS };
        }
        return failure(verdict);
      },
    },
  };
}

async function beginLibraryTwoFactorLogin({
  provider,
  credentials,
  connectionId,
  startDate,
  scraper,
  handles,
}) {
  const triggered = await scraper.triggerTwoFactorAuth(credentials.phoneNumber);
  if (!triggered || triggered.success !== true) {
    await closeQuietly(scraper);
    return { status: 'failed', errorCode: errorCodeFromScraperResult(triggered) };
  }

  return {
    status: 'otp_required',
    flow: {
      __closeBrowser: scraper.__closeBrowser,
      close: () => closeQuietly(scraper),
      complete: async (code) => {
        const tokenResult = await scraper.getLongTermTwoFactorToken(String(code));
        if (!tokenResult || tokenResult.success !== true) {
          return { status: 'otp_rejected', errorCode: errorCodeFromScraperResult(tokenResult) };
        }

        const stored = { ...credentials, otpLongTermToken: tokenResult.longTermTwoFactorAuthToken };
        delete stored.phoneNumber;
        delete stored.otpCodeRetriever;
        await closeQuietly(scraper);

        // The token is only proven once a login actually uses it. That needs a
        // fresh browser on the same profile: the first one is closed by now.
        const instance = await browser.launch({ profileDir: browser.profileDirFor(connectionId) });
        trackBrowser(handles, instance);
        const verifier = buildScraper({ provider, startDate, browser: instance });
        try {
          const result = await verifier.scrape(stored);
          return { status: 'connected', result, credentials: stored };
        } finally {
          await closeQuietly(verifier);
        }
      },
    },
  };
}

async function beginLogin({ provider, credentials, connectionId, startDate, handles = {} }) {
  if (isInteractive(provider)) {
    return beginInteractiveLogin({ provider, credentials, connectionId, startDate, handles });
  }

  const instance = await browser.launch({ profileDir: browser.profileDirFor(connectionId) });
  trackBrowser(handles, instance);

  const scraper = buildScraper({ provider, startDate, browser: instance });
  if (supportsTwoFactor(scraper) && !credentials.otpLongTermToken) {
    return beginLibraryTwoFactorLogin({
      provider,
      credentials,
      connectionId,
      startDate,
      scraper,
      handles,
    });
  }

  try {
    const result = await scraper.scrape(credentials);
    return { status: 'connected', result };
  } finally {
    await closeQuietly(scraper);
  }
}

module.exports = { beginLogin, isInteractive, setInteractiveScraperFactory };
