'use strict';

const HapoalimScraper = require('israeli-bank-scrapers/lib/scrapers/hapoalim').default;
const { clickButton, waitUntilElementFound } = require('israeli-bank-scrapers/lib/helpers/elements-interactions');
const { getCurrentUrl } = require('israeli-bank-scrapers/lib/helpers/navigation');

const { loginWaitMs } = require('../config');
const logger = require('../logger');

/** Outcomes of a login phase, mapped to error codes by the caller. */
const LOGIN_OUTCOMES = {
  SUCCESS: 'success',
  OTP_REQUIRED: 'otp_required',
  INVALID_PASSWORD: 'invalid_password',
  CHANGE_PASSWORD: 'change_password',
  UNKNOWN: 'unknown',
};

const LOGIN_FIELD_IDS = ['userCode', 'password'];

/**
 * The bank's own wording on the code dialog, which is what identifies it: the
 * dialog is drawn over the login page and changes neither the URL nor the
 * title, so its text is the only thing that says it is there. The offers to
 * resend the code are part of it and are the most distinctive words on it.
 */
const OTP_TEXT_PATTERN = /קוד האימות|קוד אימות|כניסה חדשה ממחשב|הודעת SMS|שלחו קוד|קוד קולי/;

/**
 * The dialog's own button, in order of preference. The login page's own
 * "כניסה" is still on the page behind the dialog and matches the same shape,
 * so it is the last thing tried rather than the first thing found.
 */
const SUBMIT_TEXT_PATTERNS = [/^(המשך|אישור|continue|submit)$/i, /^שלח$/i, /^כניסה$/i];

const FIELD_ATTRIBUTE = 'data-scraper-otp-field';
const SUBMIT_ATTRIBUTE = 'data-scraper-otp-submit';
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
 * Decides which of a page's inputs make up the code entry, given one descriptor
 * per visible input. Bank Hapoalim splits the code across one box per digit,
 * so a row of single character inputs is the shape to look for; a single field
 * is accepted too, but only when the page also reads like a code challenge.
 *
 * Pure, so the decision can be tested without a browser.
 */
function chooseOtpFields(candidates, { textMatches = false } = {}) {
  const usable = candidates.filter(
    (candidate) => candidate.visible && !candidate.disabled && !LOGIN_FIELD_IDS.includes(candidate.id),
  );
  if (!usable.length) return null;

  const singleCharacter = usable.filter((candidate) => candidate.maxLength === 1);
  if (singleCharacter.length >= 4) {
    return { mode: 'multi', indexes: singleCharacter.map((candidate) => candidate.index) };
  }

  // Bank Hapoalim's own boxes carry no maxlength, id, name or numeric type:
  // they are anonymous text inputs that its script drives. Nothing about a
  // single one of them says "code", so what identifies them is that there is a
  // row of them, on a page whose text reads like a code challenge, and that
  // the login fields are not among them.
  const anonymous = usable.filter((candidate) => !candidate.id && !candidate.name);
  if (textMatches && anonymous.length >= 4) {
    return { mode: 'multi', indexes: anonymous.map((candidate) => candidate.index) };
  }

  const named = usable.filter((candidate) =>
    /otp|sms|code|verification|auth/i.test(`${candidate.id} ${candidate.name} ${candidate.placeholder} ${candidate.label}`),
  );
  if (named.length === 1) return { mode: 'single', indexes: [named[0].index] };

  const numeric = usable.filter((candidate) => ['tel', 'number'].includes(candidate.type));
  if (textMatches && numeric.length === 1) return { mode: 'single', indexes: [numeric[0].index] };

  return null;
}

/**
 * Drives the Bank Hapoalim login far enough to reach the code dialog and stops
 * there, keeping the page alive, so an HTTP caller can come back with the code.
 * The library's own scraper only compares the landing URL against three known
 * pages, and the dialog does not change the URL at all, so it waits for a
 * redirect that never arrives. Everything after login is still the library's.
 */
class HapoalimOtpScraper extends HapoalimScraper {
  constructor(options) {
    super(options);
    this.otpTarget = null;
  }

  async beginLogin(credentials) {
    await this.initialize();
    const options = this.getLoginOptions(credentials);

    await this.navigateTo(options.loginUrl, options.waitUntil);
    await waitUntilElementFound(this.page, options.submitButtonSelector);
    await this.fillInputs(this.page, options.fields);
    await clickButton(this.page, options.submitButtonSelector);

    return this.waitForLoginOutcome(options.possibleResults);
  }

  /** Polls for whichever comes first: a known landing page or the code dialog. */
  async waitForLoginOutcome(possibleResults) {
    const deadline = Date.now() + loginWaitMs();
    while (Date.now() < deadline) {
      const current = await getCurrentUrl(this.page, true);
      if (urlMatches(current, possibleResults.SUCCESS)) return LOGIN_OUTCOMES.SUCCESS;
      if (urlMatches(current, possibleResults.INVALID_PASSWORD)) return LOGIN_OUTCOMES.INVALID_PASSWORD;
      if (urlMatches(current, possibleResults.CHANGE_PASSWORD)) return LOGIN_OUTCOMES.CHANGE_PASSWORD;
      if (await this.locateOtpTarget()) return LOGIN_OUTCOMES.OTP_REQUIRED;
      await delay(POLL_INTERVAL_MS);
    }
    return LOGIN_OUTCOMES.UNKNOWN;
  }

  /**
   * Finds the code entry in whichever frame holds it and tags the elements, so
   * they can be addressed later without guessing a selector. The dialog is
   * drawn over the login page, so this looks at every frame, not just the top.
   */
  async locateOtpTarget() {
    for (const frame of this.page.frames()) {
      const found = await this.scanFrame(frame).catch(() => null);
      if (found) {
        this.otpTarget = { frame, ...found };
        return this.otpTarget;
      }
    }
    this.otpTarget = null;
    return null;
  }

  async scanFrame(frame) {
    const survey = await frame.evaluate(
      (fieldAttribute, textPattern) => {
        const inputs = [...document.querySelectorAll('input')];
        const candidates = inputs.map((element, index) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          element.setAttribute(fieldAttribute, String(index));
          return {
            index,
            id: element.id || '',
            name: element.getAttribute('name') || '',
            type: (element.getAttribute('type') || 'text').toLowerCase(),
            placeholder: element.getAttribute('placeholder') || '',
            label: element.getAttribute('aria-label') || '',
            maxLength: element.maxLength > 0 ? element.maxLength : null,
            disabled: element.disabled,
            visible:
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              style.opacity !== '0' &&
              rect.width > 0 &&
              rect.height > 0,
          };
        });
        return {
          candidates,
          textMatches: new RegExp(textPattern).test(document.body.innerText || ''),
        };
      },
      FIELD_ATTRIBUTE,
      OTP_TEXT_PATTERN.source,
    );

    const chosen = chooseOtpFields(survey.candidates, { textMatches: survey.textMatches });
    return chosen ? { ...chosen, textMatches: survey.textMatches } : null;
  }

  /** Types the code the way a person does, and checks that it landed. */
  async completeOtp(code, possibleResults) {
    const target = this.otpTarget || (await this.locateOtpTarget());
    if (!target) return LOGIN_OUTCOMES.UNKNOWN;

    const digits = String(code).replace(/\D/g, '');
    const { frame, mode, indexes } = target;
    const selectorFor = (position) => `[${FIELD_ATTRIBUTE}="${indexes[position]}"]`;

    if (mode === 'multi') {
      // The bank's own script moves focus from box to box as digits arrive, so
      // the code is typed as one run of keystrokes into the first box and the
      // page distributes it. Filling each box by hand instead leaves the page's
      // model empty, which is what a framework-driven dialog actually reads.
      await frame.focus(selectorFor(0));
      await frame.type(selectorFor(0), digits, { delay: 60 });

      // Focus may not travel on its own, and then everything landed in box one.
      if ((await this.countFilled(frame, indexes)) < Math.min(digits.length, indexes.length)) {
        await this.clearBoxes(frame, indexes);
        for (let position = 0; position < indexes.length && position < digits.length; position += 1) {
          await frame.focus(selectorFor(position));
          await frame.type(selectorFor(position), digits[position], { delay: 60 });
        }
      }
    } else {
      await frame.focus(selectorFor(0));
      await frame.type(selectorFor(0), digits, { delay: 60 });
    }

    const filled = await this.countFilled(frame, indexes);
    logger.info('otp_typed', { event: `filled_${filled}_of_${indexes.length}` });

    // A dialog that enables its button on the last digit needs a moment to.
    await delay(POLL_INTERVAL_MS);
    const submitted = await this.submitOtpForm(frame);
    if (!submitted) await this.page.keyboard.press('Enter');
    logger.info('otp_submitted', { reason: submitted ? 'button' : 'enter_key' });

    return this.waitForOtpVerdict(possibleResults);
  }

  /** How many code boxes hold anything. Counts only: never the characters. */
  async countFilled(frame, indexes) {
    return frame
      .evaluate(
        (fieldAttribute, positions) =>
          positions.filter((position) => {
            const element = document.querySelector(`[${fieldAttribute}="${position}"]`);
            return !!element && String(element.value || '').length > 0;
          }).length,
        FIELD_ATTRIBUTE,
        indexes,
      )
      .catch(() => 0);
  }

  async clearBoxes(frame, indexes) {
    await frame
      .evaluate(
        (fieldAttribute, positions) => {
          for (const position of positions) {
            const element = document.querySelector(`[${fieldAttribute}="${position}"]`);
            if (!element) continue;
            element.value = '';
            element.dispatchEvent(new Event('input', { bubbles: true }));
          }
        },
        FIELD_ATTRIBUTE,
        indexes,
      )
      .catch(() => {});
  }

  /** Clicks the dialog's own button, found by its label rather than its class. */
  async submitOtpForm(frame) {
    const tagged = await frame
      .evaluate(
        (submitAttribute, textPatterns) => {
          const buttons = [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')];
          const labelled = buttons.map((element) => ({
            element,
            text: (element.innerText || element.value || '').trim(),
          }));
          for (const source of textPatterns) {
            const pattern = new RegExp(source, 'i');
            const match = labelled.find((entry) => pattern.test(entry.text));
            if (match) {
              match.element.setAttribute(submitAttribute, 'true');
              return true;
            }
          }
          return false;
        },
        SUBMIT_ATTRIBUTE,
        SUBMIT_TEXT_PATTERNS.map((pattern) => pattern.source),
      )
      .catch(() => false);

    if (!tagged) return false;
    try {
      await clickButton(frame, `[${SUBMIT_ATTRIBUTE}="true"]`);
      return true;
    } catch {
      return false;
    }
  }

  async waitForOtpVerdict(possibleResults) {
    const deadline = Date.now() + loginWaitMs();
    while (Date.now() < deadline) {
      const current = await getCurrentUrl(this.page, true);
      if (urlMatches(current, possibleResults.SUCCESS)) return LOGIN_OUTCOMES.SUCCESS;
      if (urlMatches(current, possibleResults.INVALID_PASSWORD)) return LOGIN_OUTCOMES.INVALID_PASSWORD;
      await delay(POLL_INTERVAL_MS);
    }
    // The dialog still being up means the bank did not accept what we typed.
    return (await this.locateOtpTarget()) ? LOGIN_OUTCOMES.INVALID_PASSWORD : LOGIN_OUTCOMES.UNKNOWN;
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
   * somewhere unexpected. Names, types and labels only: no field values and no
   * page text, just whether the text reads like a code challenge.
   */
  async describePage() {
    const url = await getCurrentUrl(this.page, true);
    const title = await this.page.title().catch(() => '');
    const frames = [];
    for (const frame of this.page.frames()) {
      const survey = await frame
        .evaluate(
          (textPattern) => ({
            inputs: [...document.querySelectorAll('input')].slice(0, 25).map((element) => ({
              id: element.id || null,
              name: element.getAttribute('name'),
              type: element.getAttribute('type'),
              placeholder: element.getAttribute('placeholder'),
              label: element.getAttribute('aria-label'),
              maxLength: element.maxLength > 0 ? element.maxLength : null,
            })),
            buttons: [...document.querySelectorAll('button, input[type="submit"]')]
              .slice(0, 25)
              .map((element) => (element.innerText || element.value || '').trim().slice(0, 40)),
            textMatches: new RegExp(textPattern).test(document.body.innerText || ''),
          }),
          OTP_TEXT_PATTERN.source,
        )
        .catch(() => null);
      if (survey && (survey.inputs.length || survey.buttons.length)) frames.push(survey);
    }
    return { url, title, frames };
  }
}

module.exports = { HapoalimOtpScraper, LOGIN_OUTCOMES, chooseOtpFields };
