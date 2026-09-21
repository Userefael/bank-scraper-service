'use strict';

const crypto = require('crypto');

const { SESSION_TTL_MS } = require('./config');

/**
 * OTP sessions live in memory only, never on disk: they hold plaintext
 * credentials and the live scraper (and therefore an open browser).
 * This is why the service must run as a single instance without autoscale.
 */
const sessions = new Map();

function schedule(session) {
  const timer = setTimeout(() => {
    remove(session.session_id);
  }, SESSION_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  session.timer = timer;
}

/** Creates a session and returns its id. */
function create({ provider, credentials, scraper }) {
  const sessionId = crypto.randomUUID();
  const session = {
    session_id: sessionId,
    provider,
    credentials,
    scraper,
    otp_failures: 0,
    expires_at: Date.now() + SESSION_TTL_MS,
    timer: null,
  };
  schedule(session);
  sessions.set(sessionId, session);
  return sessionId;
}

/** Returns a live session, or null when it is unknown or expired. */
function get(sessionId) {
  if (typeof sessionId !== 'string') return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expires_at <= Date.now()) {
    remove(sessionId);
    return null;
  }
  return session;
}

/** Drops a session and closes the browser its scraper left open. */
function remove(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  if (session.timer) clearTimeout(session.timer);
  session.credentials = null;
  const closeBrowser = session.scraper && session.scraper.__closeBrowser;
  session.scraper = null;
  if (typeof closeBrowser === 'function') {
    Promise.resolve()
      .then(() => closeBrowser())
      .catch(() => {});
  }
}

function size() {
  return sessions.size;
}

/** Test/shutdown helper: drops every session. */
function clear() {
  for (const sessionId of [...sessions.keys()]) remove(sessionId);
}

module.exports = { create, get, remove, size, clear };
