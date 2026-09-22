'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { connectionsFile, dataDir } = require('./config');
const { encryptJson, decryptJson } = require('./crypto');

const FILE_VERSION = 1;

/** Serializes writes; the service runs as a single instance. */
let writeChain = Promise.resolve();

async function readFile() {
  try {
    const raw = await fs.readFile(connectionsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.connections) {
      return { version: FILE_VERSION, connections: {} };
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return { version: FILE_VERSION, connections: {} };
    throw err;
  }
}

/** Atomic write: temp file in the same directory, then rename. */
async function writeFileAtomic(data) {
  const target = connectionsFile();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}

function mutate(fn) {
  const next = writeChain.then(async () => {
    const data = await readFile();
    const result = await fn(data);
    await writeFileAtomic(data);
    return result;
  });
  writeChain = next.catch(() => {});
  return next;
}

/** Stores a new connection and returns its record (without credentials). */
async function saveConnection({ connectionId = crypto.randomUUID(), provider, credentials }) {
  const record = {
    connection_id: connectionId,
    provider,
    credentials_encrypted: encryptJson(credentials),
    created_at: new Date().toISOString(),
  };
  await mutate((data) => {
    data.version = FILE_VERSION;
    data.connections[connectionId] = record;
  });
  return { connection_id: connectionId, provider, created_at: record.created_at };
}

/** Returns { connection_id, provider, created_at } or null. */
async function getConnection(connectionId) {
  const data = await readFile();
  const record = data.connections[connectionId];
  if (!record) return null;
  return { connection_id: record.connection_id, provider: record.provider, created_at: record.created_at };
}

/** Returns decrypted credentials for a connection, or null when it is unknown. */
async function getCredentials(connectionId) {
  const data = await readFile();
  const record = data.connections[connectionId];
  if (!record) return null;
  return { provider: record.provider, credentials: decryptJson(record.credentials_encrypted) };
}

/** Deletes a connection. Returns true when something was removed. */
async function deleteConnection(connectionId) {
  return mutate((data) => {
    if (!data.connections[connectionId]) return false;
    delete data.connections[connectionId];
    return true;
  });
}

/** Verifies the data directory is writable; called on startup. */
async function ensureDataDir() {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.access(dataDir(), fs.constants.W_OK);
}

module.exports = {
  saveConnection,
  getConnection,
  getCredentials,
  deleteConnection,
  ensureDataDir,
};
