'use strict';
// The per-install secret that proves a request comes from this user's hooks, CLI or extension, not from any other
// process or user on the machine (127.0.0.1 is reachable by all of them). Zero dependencies.
//
// ~/.claude-nudge/secret, 32 random bytes as hex, mode 0600 (Windows ignores the mode; the file stays private there
// because %USERPROFILE% is readable only by its user, administrators and SYSTEM). `setup` mints it (and the relay does
// at start when it is missing, so a checkout run with `npm start` works too). Sent as the X-Nudge-Secret header
// (hooks, CLI, extension fetches) or ?secret= (the extension's WebSocket). The extension stores it after the user pastes it into the popup.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.claude-nudge', 'secret');
const HEADER = 'x-nudge-secret';

function read() {
  try { return fs.readFileSync(FILE, 'utf8').trim() || null; } catch (_) { return null; }
}

// Returns { secret, created }. Never replaces an existing secret (the extension has it stored).
function ensure() {
  const existing = read();
  if (existing) {
    try { fs.chmodSync(FILE, 0o600); } catch (_) { /* not ours to fix */ }
    return { secret: existing, created: false };
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(FILE, secret + '\n', { mode: 0o600, flag: 'wx' });
    return { secret, created: true };
  } catch (e) {
    if (e.code === 'EEXIST') return { secret: read(), created: false }; // minted by setup or the relay meanwhile
    throw e;
  }
}

// Constant-time comparison (both sides hashed, so lengths never leak or throw).
function matches(given, secret) {
  if (!given || !secret) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { FILE, HEADER, read, ensure, matches };
