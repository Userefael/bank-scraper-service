'use strict';

/** In-memory locks, one per connection_id, guarding concurrent syncs. */
const locked = new Set();

function acquire(key) {
  if (locked.has(key)) return false;
  locked.add(key);
  return true;
}

function release(key) {
  locked.delete(key);
}

function isLocked(key) {
  return locked.has(key);
}

module.exports = { acquire, release, isLocked };
