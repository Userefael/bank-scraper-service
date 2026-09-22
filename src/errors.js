'use strict';

/** The only error codes this service is allowed to return. */
const ERROR_CODES = {
  INVALID_CREDENTIALS: 'invalid_credentials',
  OTP_REQUIRED: 'otp_required',
  BLOCKED: 'blocked',
  TIMEOUT: 'timeout',
  SERVICE_UNAVAILABLE: 'service_unavailable',
  UNKNOWN: 'unknown',
};

const ALL_ERROR_CODES = Object.values(ERROR_CODES);

/** Default HTTP status per error code. Routes may override (401, 404, 409). */
const STATUS_BY_CODE = {
  [ERROR_CODES.INVALID_CREDENTIALS]: 400,
  [ERROR_CODES.OTP_REQUIRED]: 400,
  [ERROR_CODES.BLOCKED]: 403,
  [ERROR_CODES.TIMEOUT]: 504,
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 503,
  [ERROR_CODES.UNKNOWN]: 500,
};

/**
 * errorType values of israeli-bank-scrapers 6.x (lib/scrapers/errors.d.ts),
 * verified against the installed version.
 */
const SCRAPER_ERROR_TYPE_MAP = {
  INVALID_PASSWORD: ERROR_CODES.INVALID_CREDENTIALS,
  CHANGE_PASSWORD: ERROR_CODES.INVALID_CREDENTIALS,
  TWO_FACTOR_RETRIEVER_MISSING: ERROR_CODES.OTP_REQUIRED,
  ACCOUNT_BLOCKED: ERROR_CODES.BLOCKED,
  TIMEOUT: ERROR_CODES.TIMEOUT,
  GENERIC: ERROR_CODES.UNKNOWN,
  GENERAL_ERROR: ERROR_CODES.UNKNOWN,
};

class ApiError extends Error {
  constructor(code, { status, internalMessage } = {}) {
    super(internalMessage || code);
    this.name = 'ApiError';
    this.code = ALL_ERROR_CODES.includes(code) ? code : ERROR_CODES.UNKNOWN;
    this.status = status || STATUS_BY_CODE[this.code];
  }
}

/** Maps a library `{ success: false, errorType }` result to an error code. */
function errorCodeFromScraperResult(result) {
  const type = result && result.errorType;
  return SCRAPER_ERROR_TYPE_MAP[type] || ERROR_CODES.UNKNOWN;
}

/**
 * Maps a thrown exception to an error code. Browser/launch failures are
 * infrastructure problems, so they surface as service_unavailable.
 */
function errorCodeFromException(err) {
  if (err instanceof ApiError) return err.code;
  const message = String((err && err.message) || '');
  if (/timeout|timed out/i.test(message)) return ERROR_CODES.TIMEOUT;
  if (
    /Failed to launch|executable doesn't exist|ENOENT|spawn|Target closed|Protocol error|net::ERR|socket hang up|EAI_AGAIN|ECONNREFUSED|ENOTFOUND|Failed to navigate|status code/i.test(
      message,
    )
  ) {
    return ERROR_CODES.SERVICE_UNAVAILABLE;
  }
  return ERROR_CODES.UNKNOWN;
}

function sendError(res, code, status) {
  const errorCode = ALL_ERROR_CODES.includes(code) ? code : ERROR_CODES.UNKNOWN;
  return res.status(status || STATUS_BY_CODE[errorCode]).json({ ok: false, error_code: errorCode });
}

module.exports = {
  ERROR_CODES,
  ALL_ERROR_CODES,
  STATUS_BY_CODE,
  SCRAPER_ERROR_TYPE_MAP,
  ApiError,
  errorCodeFromScraperResult,
  errorCodeFromException,
  sendError,
};
