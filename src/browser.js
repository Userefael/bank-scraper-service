'use strict';

const fs = require('fs/promises');
const path = require('path');
const puppeteer = require('puppeteer');

const { CHROMIUM_ARGS, dataDir } = require('./config');

/**
 * Chromium is launched here rather than by the library so each connection can
 * keep its own profile directory on the volume. Banks that challenge an
 * unrecognised device with an SMS code stop challenging once the profile
 * carries the cookie they set after the first successful login.
 */
function profileDirFor(connectionId) {
  return path.join(dataDir(), 'profiles', connectionId);
}

/** Swappable so tests can exercise the routes without a real Chromium. */
let launcher = null;

function setLauncher(fn) {
  launcher = fn;
}

async function launch({ profileDir } = {}) {
  if (profileDir) await fs.mkdir(profileDir, { recursive: true });
  if (launcher) return launcher({ profileDir });
  return puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: CHROMIUM_ARGS,
    userDataDir: profileDir || undefined,
  });
}

/** Drops a connection's profile; it holds the bank's cookies for that login. */
async function removeProfile(connectionId) {
  await fs.rm(profileDirFor(connectionId), { recursive: true, force: true });
}

module.exports = { launch, profileDirFor, removeProfile, setLauncher };
