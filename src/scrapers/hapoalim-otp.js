'use strict';

const HapoalimScraper = require('israeli-bank-scrapers/lib/scrapers/hapoalim').default;
const {
  clickButton,
  fillInput,
  pageEvalAll,
  waitUntilElementFound,
} = require('israeli-bank-scrapers/lib/helpers/elements-interactions');
const { getCurrentUrl } = require('israeli-bank-scrapers/lib/helpers/navigation');

const { loginWaitMs } = require('../config');

/** Outcomes of a login phase, mapped to error codes by the caller. */
const LOGIN_OUTCOMES = {
  SUCCESS: 'success',
  OTP_REQUIRED: 'otp_required',
  INVALID_PASSWORD: 'invalid_password',
  CHANGE_PASSWORD: 'change_password',
  UNKNOWN: 'unknown',
};

const LOGIN_FIELD_SELECTORS = ['#userCode', '#password'];

/**
 * Candidate selectors for the bank's code field, most specific first. The real
 * markup can only be confirmed against a live challenge, so the list is broad
 * and the first two entries are environment overrides for exactly that reason.
 */
function otpInputSelectors() {
  return [
    process.env.HAPOALIM_OTP_INPUT_SELECTOR,
    'input[autocomplete="one-time-code"]',
    'input[id*="otp" i]',
    'input[name*="otp" i]',
    'input[id*="sms" i]',
    'input[name*="sms" i]',
    'input[id*="code" i]',
    'input[name*="code" i]',
    'input[type="tel"]',
    'input[type="number"]',
  ].filter(Boolean);
}

function otpSubmitSelectors() {
  return [
    process.env.HAPOALIM_OTP_SUBMIT_SELECTOR,
    'button[type="submit"]',
    'input[type="submit"]',
    '.btn-primary',
    '.login-btn',
  ].filter(Boolean);
}

const POLL_INTERVAL_MS = 500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function urlMatches(current, candidates) {
  return (candidates || []).some((candidate) =>
    candidate instanceof RegExp ? candidate.test(current) : current.startsWith(candidate),
  );
}

/**
 * Drives the Bank Hapoalim login far enough to reach the SMS code page and
 * stops there, keeping the page alive, so an HTTP caller can come back with the
 * code. The library's own scraper only compares the landing URL against three
 * known pages, so a code challenge leaves it waiting for a redirect that never
 * arrives; everything after login still uses the library's own fetching.
 */
class HapoalimOtpScraper extends HapoalimScraper {
  /** Runs the login up to the point where the bank decides what it wants. */
  async beginLogin(credentials) {
    await this.initialize();
    const options = this.getLoginOptions(credentials);

    await this.navigateTo(options.loginUrl, options.waitUntil);
    await waitUntilElementFound(this.page, options.submitButtonSelector);
    await this.fillInputs(this.page, options.fields);
    await clickButton(this.page, options.submitButtonSelector);

    return this.waitForLoginOutcome(options.possibleResults);
  }

  /** Polls for whichever comes first: a known landing page or a code field. */
  async waitForLoginOutcome(possibleResults) {
    const deadline = Date.now() + loginWaitMs();
    while (Date.now() < deadline) {
      const current = await getCurrentUrl(this.page, true);
      if (urlMatches(current, possibleResults.SUCCESS)) return LOGIN_OUTCOMES.SUCCESS;
      if (urlMatches(current, possibleResults.INVALID_PASSWORD)) return LOGIN_OUTCOMES.INVALID_PASSWORD;
      if (urlMatches(current, possibleResults.CHANGE_PASSWORD)) return LOGIN_OUTCOMES.CHANGE_PASSWORD;
      if (await this.findOtpInput()) return LOGIN_OUTCOMES.OTP_REQUIRED;
      await delay(POLL_INTERVAL_MS);
    }
    return LOGIN_OUTCOMES.UNKNOWN;
  }

  /** The first code-field selector present on the page, or null. */
  async findOtpInput() {
    for (const selector of otpInputSelectors()) {
      if (LOGIN_FIELD_SELECTORS.includes(selector)) continue;
      const usable = await pageEvalAll(
        this.page,
        selector,
        false,
        (elements, excluded) =>
          elements.some((element) => {
            if (excluded.includes(`#${element.id}`)) return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && !element.disabled;
          }),
        LOGIN_FIELD_SELECTORS,
      ).catch(() => false);
      if (usable) return selector;
    }
    return null;
  }

  /** Types the code, submits it, and waits for the bank's verdict. */
  async completeOtp(code, possibleResults) {
    const selector = await this.findOtpInput();
    if (!selector) return LOGIN_OUTCOMES.UNKNOWN;

    await fillInput(this.page, selector, code);
    if (!(await this.submitOtpForm())) {
      await this.page.keyboard.press('Enter');
    }

    const deadline = Date.now() + loginWaitMs();
    while (Date.now() < deadline) {
      const current = await getCurrentUrl(this.page, true);
      if (urlMatches(current, possibleResults.SUCCESS)) return LOGIN_OUTCOMES.SUCCESS;
      if (urlMatches(current, possibleResults.INVALID_PASSWORD)) return LOGIN_OUTCOMES.INVALID_PASSWORD;
      await delay(POLL_INTERVAL_MS);
    }
    // Still sitting on the code field means the bank rejected what we typed.
    return (await this.findOtpInput()) ? LOGIN_OUTCOMES.INVALID_PASSWORD : LOGIN_OUTCOMES.UNKNOWN;
  }

  async submitOtpForm() {
    for (const selector of otpSubmitSelectors()) {
      try {
        await clickButton(this.page, selector);
        return true;
      } catch {
        // Try the next candidate; a missing button is expected here.
      }
    }
    return false;
  }

  /** Uses the library's own fetching once the login is through. */
  async fetchAfterLogin() {
    return this.fetchData();
  }

  async finish(success) {
    await this.terminate(success === true);
  }

  /**
   * The shape of the current page, for diagnosing a login that landed
   * somewhere unexpected. Names and labels only: no field values, ever.
   */
  async describePage() {
    const url = await getCurrentUrl(this.page, true);
    const title = await this.page.title().catch(() => '');
    const inputs = await pageEvalAll(this.page, 'input', [], (elements) =>
      elements.slice(0, 25).map((element) => ({
        id: element.id || null,
        name: element.getAttribute('name'),
        type: element.getAttribute('type'),
        placeholder: element.getAttribute('placeholder'),
        label: element.getAttribute('aria-label'),
      })),
    ).catch(() => []);
    const buttons = await pageEvalAll(this.page, 'button, input[type="submit"]', [], (elements) =>
      elements.slice(0, 25).map((element) => (element.innerText || element.value || '').trim().slice(0, 40)),
    ).catch(() => []);
    return { url, title, inputs, buttons };
  }
}

module.exports = { HapoalimOtpScraper, LOGIN_OUTCOMES };
