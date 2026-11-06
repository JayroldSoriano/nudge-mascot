'use strict';
// Phone pairing, shared by the relay (the extension popup drives it) and the CLI (`npx nudge-mascot pair`).
// Owns ~/.claude-nudge/cloud.json and the two approval hooks in ~/.claude/settings.json. The approval hooks power
// "reply from the bubble" too, so `setup` installs them as well; `pair` still does, for installs that predate that.
// Zero dependencies.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hookCommand } = require('./hookcmd');

const HOME = os.homedir();
const INSTALL_DIR = path.join(HOME, '.claude-nudge');
const CLOUD = process.env.CLAUDE_NUDGE_CLOUD || path.join(INSTALL_DIR, 'cloud.json');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const APPROVE = path.join(INSTALL_DIR, 'nudge-approve.js');
const DEFAULT_RELAY = process.env.CLAUDE_NUDGE_RELAY || 'https://relay.nudgemascot.com';
const LAST_RELAY = path.join(INSTALL_DIR, 'relay-url'); // survives unpair, so "Pair a phone" again reuses it

function lastRelay() {
  try { return fs.readFileSync(LAST_RELAY, 'utf8').trim() || null; } catch (_) { return null; }
}
const APPROVE_RE = /nudge-approve\.js"?$/;

function read() {
  try {
    const c = JSON.parse(fs.readFileSync(CLOUD, 'utf8'));
    return c && c.relay && c.laptopToken ? c : null;
  } catch (_) { return null; }
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (_) { return {}; }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

// The hook script ships next to the relay (repo: hooks/, install: ~/.claude-nudge/). Make sure the install copy exists.
function ensureApproveScript() {
  if (fs.existsSync(APPROVE)) return;
  const src = path.join(__dirname, '..', 'hooks', 'nudge-approve.js');
  if (fs.existsSync(src)) { fs.mkdirSync(INSTALL_DIR, { recursive: true }); fs.copyFileSync(src, APPROVE); }
}

// PermissionRequest (all tools) and PreToolUse on AskUserQuestion, both with Claude Code's full 600 s timeout,
// so the hook can wait for the bubble or the phone. Idempotent; stale entries pointing elsewhere are dropped.
// `backup: false` when the caller (setup) already saved the untouched settings.json. The backup is written only when
// none exists, so it keeps the settings from before Nudge touched them. Returns how many were added.
function installApprovalHooks({ backup = true } = {}) {
  ensureApproveScript();
  const settings = readSettings();
  const bak = SETTINGS + '.bak-claude-nudge';
  if (backup && fs.existsSync(SETTINGS) && !fs.existsSync(bak)) fs.copyFileSync(SETTINGS, bak);
  settings.hooks = settings.hooks || {};
  const command = hookCommand(APPROVE);
  const entry = { type: 'command', command, timeout: 600 };
  let added = 0;
  for (const [event, matcher] of [['PermissionRequest', null], ['PreToolUse', 'AskUserQuestion']]) {
    const list = (settings.hooks[event] = settings.hooks[event] || []);
    for (const g of list) if (g.hooks) g.hooks = g.hooks.filter((h) => !APPROVE_RE.test(h.command || '') || h.command === command);
    // Groups emptied by dropping a stale entry would otherwise linger as {hooks: []}.
    settings.hooks[event] = list.filter((g) => !g.hooks || g.hooks.length);
    if (!settings.hooks[event].some((g) => (g.hooks || []).some((h) => h.command === command))) {
      settings.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [entry] });
      added++;
    }
  }
  writeSettings(settings);
  return added;
}

function removeApprovalHooks() {
  const settings = readSettings();
  if (!settings.hooks) return;
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = settings.hooks[event]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !APPROVE_RE.test(h.command || '')) }))
      .filter((g) => g.hooks.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  writeSettings(settings);
}

// Whether nudge-approve.js is installed for this event (PreToolUse: on a matcher that covers AskUserQuestion).
// Read on every call, so a manual edit of settings.json counts at once.
function approvalHookFor(event, matcherRe) {
  const s = readSettings();
  const list = s.hooks && Array.isArray(s.hooks[event]) ? s.hooks[event] : [];
  return list.some((g) => (!matcherRe || matcherRe.test(g.matcher || '')) && (g.hooks || []).some((h) => APPROVE_RE.test(h.command || '')));
}
const permissionHookInstalled = () => approvalHookFor('PermissionRequest', null);
// An empty matcher, "*" or one naming AskUserQuestion all fire the hook for questions.
const questionHookInstalled = () => approvalHookFor('PreToolUse', /^$|^\*$|(^|\|)AskUserQuestion($|\|)/);
const hooksInstalled = () => permissionHookInstalled() && questionHookInstalled();

function pairLink(code, relay) {
  return `nudge://pair?code=${encodeURIComponent(code)}&relay=${encodeURIComponent(relay)}`;
}

// Mint a pairing code on the hosted relay, remember the laptop token, install the hooks.
async function start(relayUrl) {
  const relay = String(relayUrl || (read() || {}).relay || lastRelay() || DEFAULT_RELAY).replace(/\/$/, '');
  let res;
  try { res = await fetch(`${relay}/pair/start`, { method: 'POST', signal: AbortSignal.timeout(8000) }); }
  catch (e) { throw new Error(`could not reach ${relay} (${e.message})`); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${relay} answered HTTP ${res.status}`);
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.writeFileSync(LAST_RELAY, (body.relay || relay) + '\n');
  // browserToken: what the relay uses to mirror the bubble's decisions to the hosted relay (POST /decisions).
  // Hosted relays from before it existed send none; server.js then derives it from the laptop token.
  fs.writeFileSync(CLOUD, JSON.stringify({ relay: body.relay || relay, userId: body.userId, laptopToken: body.laptopToken, ...(body.browserToken ? { browserToken: body.browserToken } : {}), pairedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  installApprovalHooks(); // already there since `setup` installs them; kept for installs that predate that
  const out = { userId: body.userId, pairCode: body.pairCode, relay: body.relay || relay, expiresInSeconds: body.expiresInSeconds || 600 };
  out.link = pairLink(out.pairCode, out.relay);
  return out;
}

function stop() {
  const was = read();
  // Tell the hosted relay to forget the phones and their push tokens. Fire-and-forget: unpairing never waits on it.
  if (was && typeof fetch === 'function') {
    fetch(`${was.relay}/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${was.laptopToken}` }, signal: AbortSignal.timeout(5000) })
      .catch(() => {});
  }
  if (fs.existsSync(CLOUD)) fs.unlinkSync(CLOUD);
  // The approval hooks stay: they also serve the bubble, and with no phone and no extension connected they
  // return at once (the relay answers canDecide: false). `npx nudge-mascot uninstall` removes them.
  return { ok: true, wasPaired: !!was };
}

// Local state plus, when paired, what the hosted relay knows (phones that claimed, devices with push).
async function status() {
  const c = read();
  const base = { paired: !!c, relay: c ? c.relay : (lastRelay() || DEFAULT_RELAY), userId: c ? c.userId : null, hooks: hooksInstalled(), phones: null, devices: null, pairCodeOpen: false };
  if (!c || typeof fetch !== 'function') return base;
  try {
    const res = await fetch(`${c.relay}/status`, { headers: { Authorization: `Bearer ${c.laptopToken}` }, signal: AbortSignal.timeout(5000) });
    if (res.ok) Object.assign(base, await res.json());
    else base.error = `relay answered HTTP ${res.status}`;
  } catch (e) { base.error = e.message; }
  return base;
}

module.exports = { read, start, stop, status, pairLink, installApprovalHooks, removeApprovalHooks, hooksInstalled, permissionHookInstalled, questionHookInstalled, CLOUD, APPROVE, DEFAULT_RELAY };
