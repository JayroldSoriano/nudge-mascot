#!/usr/bin/env node
// Nudge CLI.
//   npx nudge-mascot setup [--agent claude-code|codex|gemini|grok|cursor|opencode]
//                               install hooks (every agent found, or the ones named; for Claude Code also the
//                               approval hooks), relay, launch agent; print the extension step
//   npx nudge-mascot start      run the relay in the foreground
//   npx nudge-mascot status     relay health + hook status per agent
//   npx nudge-mascot test [kind] [--agent codex|gemini|grok|cursor|opencode]
//                               send a test nudge (question | questions | permission | approve | done | resolved |
//                               jump | jump-unknown | multi)
//   npx nudge-mascot uninstall  remove hooks (all agents, approval hooks included), launch agent, and ~/.claude-nudge
//   npx nudge-mascot pair [--relay URL]   pair a phone through the hosted relay (installs the approval hooks if missing)
//   npx nudge-mascot unpair     forget the hosted relay (the approval hooks stay for the bubble)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const PKG = path.join(__dirname, '..');
const HOME = os.homedir();
const INSTALL_DIR = path.join(HOME, '.claude-nudge');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const PORT = Number(process.env.CLAUDE_NUDGE_PORT || 47831);
const HOOK = path.join(INSTALL_DIR, 'nudge-hook.sh');
const RELAY = path.join(INSTALL_DIR, 'relay', 'server.js');
const LAUNCHD_LABEL = 'com.claude-nudge.relay';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_UNIT = path.join(HOME, '.config', 'systemd', 'user', 'claude-nudge.service');
const STORE_URL = process.env.CLAUDE_NUDGE_STORE_URL || ''; // set once the Web Store listing is live
const pairing = require('../relay/pairing'); // phone pairing: cloud.json + the approval hooks
const secret = require('../relay/secret'); // the per-install secret the relay wants from every client
const APPROVE = pairing.APPROVE;

const HOOKS = {
  Stop: null,
  Notification: 'permission_prompt|idle_prompt|agent_needs_input|agent_completed',
  PreToolUse: 'AskUserQuestion',
  PostToolUse: null,
  UserPromptSubmit: null,
};
const BACKUP_SUFFIX = '.bak-claude-nudge';

// The agents Nudge can hook into. All run the same nudge-hook.sh; the others pass their name so the relay picks
// their adapter (relay/adapters/). `hooks` is event -> matcher (null: every occurrence). `re` recognises our own
// entries, including stale ones from an older install path. `marker` (or `dir`) and `bin` (one name or several)
// decide detection. Config layouts:
//   default  { hooks: { Event: [{ matcher?, hooks: [{ type, command, ... }] }] } }  (Claude Code, Codex, Gemini, Grok)
//   flat     { version: 1, hooks: { event: [{ command, ... }] } }                    (Cursor)
//   ownFile  the file holds only Nudge's hooks, so uninstall deletes it               (Grok)
//   plugin   no hook config: `file` is a plugin Nudge writes from `source`            (OpenCode)
const AGENTS = {
  'claude-code': {
    label: 'Claude Code',
    file: SETTINGS,
    dir: path.join(HOME, '.claude'),
    bin: 'claude',
    hooks: HOOKS,
    // Quoted, so a HOME with spaces works. Earlier versions installed it unquoted; `re` matches both, so `setup`
    // replaces the old entry with this one.
    command: `"${HOOK}"`,
    entry: {},
    re: /nudge-hook\.sh"?$/,
    removeRe: /nudge-(hook\.sh|approve\.js)"?$/, // the approval hook's command ends in a quote
  },
  // ~/.codex/hooks.json, per the Codex hooks docs. Codex asks the user to review and trust new hooks (/hooks).
  codex: {
    label: 'Codex',
    file: path.join(HOME, '.codex', 'hooks.json'),
    dir: path.join(HOME, '.codex'),
    bin: 'codex',
    hooks: { PermissionRequest: null, PreToolUse: 'request_user_input', PostToolUse: null, UserPromptSubmit: null, Stop: null },
    command: `"${HOOK}" codex`,
    entry: { timeout: 10 }, // seconds
    re: /nudge-hook\.sh"?\s+codex$/,
    note: 'Codex runs new hooks only after you trust them: type /hooks in Codex and trust the Nudge entries.',
  },
  // ~/.gemini/settings.json, per the Gemini CLI hooks docs. ~/.gemini alone is not enough to detect Gemini CLI:
  // Antigravity and Gemini Code Assist create it too, so detection wants settings.json or the gemini binary.
  gemini: {
    label: 'Gemini CLI',
    file: path.join(HOME, '.gemini', 'settings.json'),
    marker: path.join(HOME, '.gemini', 'settings.json'),
    bin: 'gemini',
    hooks: { Notification: null, AfterAgent: null, BeforeAgent: null, AfterTool: null },
    command: `"${HOOK}" gemini`,
    entry: { name: 'nudge', timeout: 5000 }, // milliseconds
    re: /nudge-hook\.sh"?\s+gemini$/,
  },
  // ~/.grok/hooks/*.json, per the Grok Build hooks guide; user hook files are always trusted. Grok also runs the
  // Claude Code hooks in ~/.claude/settings.json, and the relay drops those copies. ~/.grok alone is not enough to
  // detect it (the community grok-cli uses ~/.grok too), so detection wants config.toml or the grok binary.
  grok: {
    label: 'Grok Build',
    file: path.join(HOME, '.grok', 'hooks', 'nudge.json'),
    marker: path.join(HOME, '.grok', 'config.toml'),
    bin: 'grok',
    hooks: {
      Notification: 'permission_prompt|elicitation_dialog|idle_prompt',
      PreToolUse: 'ask_user_question',
      PostToolUse: null,
      UserPromptSubmit: null,
      Stop: null,
      StopFailure: null,
      StopCancelled: null,
    },
    command: `"${HOOK}" grok`,
    entry: { timeout: 10 }, // seconds
    ownFile: true,
    re: /nudge-hook\.sh"?\s+grok$/,
  },
  // ~/.cursor/hooks.json (version 1, flat entries), read by the editor's agent and the cursor-agent CLI. Cursor has no
  // event for its approval prompts, so it gets done nudges only.
  cursor: {
    label: 'Cursor',
    file: path.join(HOME, '.cursor', 'hooks.json'),
    dir: path.join(HOME, '.cursor'),
    bin: ['cursor-agent', 'cursor'],
    hooks: { stop: null, afterAgentResponse: null, beforeSubmitPrompt: null },
    command: `"${HOOK}" cursor`,
    entry: { timeout: 10 }, // seconds
    flat: true,
    re: /nudge-hook\.sh"?\s+cursor$/,
  },
  // OpenCode (V2) has no shell hooks: a plugin in its global plugins directory forwards bus events to nudge-hook.sh.
  opencode: {
    label: 'OpenCode',
    file: path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'opencode', 'plugins', 'nudge.js'),
    dir: path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'opencode'),
    bin: 'opencode',
    plugin: true,
    source: path.join(PKG, 'hooks', 'nudge-opencode.js'),
    events: ['permission.asked', 'form.created (questions)', 'session.execution.*'],
    note: 'Restart OpenCode so it loads the Nudge plugin (OpenCode 2 or later).',
  },
};
const ALIASES = { claude: 'claude-code', 'gemini-cli': 'gemini', 'grok-build': 'grok', 'cursor-agent': 'cursor', 'open-code': 'opencode' };

const log = (m) => console.log(m);
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

// A missing file reads as {}. A file that exists but does not parse (Gemini allows comments, say) is reported
// instead of being overwritten with only our hooks in it.
function readJson(file) {
  if (!fs.existsSync(file)) return { data: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? { data } : { error: `${file} is not a JSON object` };
  } catch (e) { return { error: `${file} is not plain JSON (${e.message}); add the hooks by hand or fix the file` }; }
}

function onPath(bin) {
  return (process.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}

function detected(id) {
  const a = AGENTS[id];
  return fs.existsSync(a.marker || a.dir) || [].concat(a.bin).some(onPath);
}

// The plugin file with the hook's install path written in (it falls back to ~/.claude-nudge on its own).
function pluginSource(a) {
  return fs.readFileSync(a.source, 'utf8').replace(/\/\* nudge:hook \*\/[^;]*;/, `${JSON.stringify(HOOK)};`);
}

// Our entries in one event's list: in groups ({ hooks: [...] }) or, for a flat config, the entries themselves.
const entriesOf = (a, list) => (a.flat ? list : list.flatMap((g) => g.hooks || []));

// Backs up the agent's config, then merges our hooks in. Idempotent: entries already present are kept,
// stale Nudge entries (an older install path) are replaced, everything else is left alone. The backup is written only
// when none exists, so it keeps the config from before Nudge first touched it.
function installHooks(id) {
  const a = AGENTS[id];
  if (a.plugin) {
    const body = pluginSource(a);
    const same = fs.existsSync(a.file) && fs.readFileSync(a.file, 'utf8') === body;
    if (!same) { fs.mkdirSync(path.dirname(a.file), { recursive: true }); fs.writeFileSync(a.file, body); }
    return { added: same ? 0 : 1 };
  }
  const { data: settings, error } = readJson(a.file);
  if (error) return { error };
  if (fs.existsSync(a.file) && !fs.existsSync(a.file + BACKUP_SUFFIX)) fs.copyFileSync(a.file, a.file + BACKUP_SUFFIX);
  if (a.flat && settings.version == null) settings.version = 1;
  settings.hooks = settings.hooks || {};
  let added = 0;
  for (const [event, matcher] of Object.entries(a.hooks)) {
    if (a.flat) {
      const list = (settings.hooks[event] = (settings.hooks[event] || []).filter((h) => !a.re.test((h && h.command) || '') || h.command === a.command));
      if (!list.some((h) => h && h.command === a.command)) { list.push({ command: a.command, ...a.entry }); added++; }
      continue;
    }
    // Drop stale entries (an old checkout, or the unquoted command earlier versions wrote), keep everything else.
    // A group left empty by that goes too, rather than lingering as {hooks: []}.
    const list = (settings.hooks[event] = (settings.hooks[event] || []).filter((g) => {
      if (!Array.isArray(g.hooks)) return true;
      const kept = g.hooks.filter((h) => !a.re.test(h.command || '') || h.command === a.command);
      const emptied = g.hooks.length > 0 && kept.length === 0;
      g.hooks = kept;
      return !emptied;
    }));
    if (!list.some((g) => (g.hooks || []).some((h) => h.command === a.command))) {
      list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: a.command, ...a.entry }] });
      added++;
    }
  }
  fs.mkdirSync(path.dirname(a.file), { recursive: true });
  fs.writeFileSync(a.file, JSON.stringify(settings, null, 2) + '\n');
  return { added };
}

// Removes every Nudge hook from the agent's config (for Claude Code, the approval hook too). Returns the count.
function removeHooks(id) {
  const a = AGENTS[id];
  if (a.plugin) {
    if (!fs.existsSync(a.file)) return { removed: 0 };
    fs.unlinkSync(a.file);
    return { removed: 1 };
  }
  const pattern = a.removeRe || a.re;
  const { data: settings, error } = readJson(a.file);
  if (error) return { error };
  if (!settings.hooks || typeof settings.hooks !== 'object') return { removed: 0 };
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    if (a.flat) {
      const kept = settings.hooks[event].filter((h) => !pattern.test((h && h.command) || ''));
      removed += settings.hooks[event].length - kept.length;
      settings.hooks[event] = kept;
      if (!kept.length) delete settings.hooks[event];
      continue;
    }
    settings.hooks[event] = settings.hooks[event]
      .map((g) => {
        const hooks = (g.hooks || []).filter((h) => !pattern.test(h.command || ''));
        removed += (g.hooks || []).length - hooks.length;
        return { ...g, hooks };
      })
      .filter((g) => g.hooks.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (a.ownFile && !Object.keys(settings.hooks).length && Object.keys(settings).length === 1) fs.unlinkSync(a.file);
  else if (removed) fs.writeFileSync(a.file, JSON.stringify(settings, null, 2) + '\n');
  return { removed };
}

// Which events of the agent's hook set point at nudge-hook.sh.
function hookStatus(id) {
  const a = AGENTS[id];
  if (a.plugin) {
    const ok = fs.existsSync(a.file);
    return ok ? { present: [`plugin ${a.file}`], missing: [] } : { present: [], missing: [`plugin ${a.file}`] };
  }
  const { data: s, error } = readJson(a.file);
  if (error) return { error };
  const events = Object.keys(a.hooks);
  const present = events.filter((e) => entriesOf(a, s.hooks && Array.isArray(s.hooks[e]) ? s.hooks[e] : []).some((hk) => hk && a.re.test(hk.command || '')));
  return { present, missing: events.filter((e) => !present.includes(e)) };
}

// --agent codex, --agent=gemini, --agent codex,gemini. [] when absent; exits on an unknown name, and on a bare
// `--agent` or an empty `--agent=` (rather than falling through to "every agent found").
function agentArgs() {
  const out = [];
  const argv = process.argv.slice(3);
  let given = false;
  for (let i = 0; i < argv.length; i++) {
    let v = null;
    if (argv[i] === '--agent') v = argv[++i] || '';
    else if (argv[i].startsWith('--agent=')) v = argv[i].slice('--agent='.length);
    if (v !== null) { given = true; out.push(...v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)); }
  }
  const ids = out.map((x) => ALIASES[x] || x);
  const bad = ids.filter((x) => !AGENTS[x]);
  if (bad.length || (out.length === 0 && given)) {
    log(`unknown agent: ${bad.join(', ') || '(none given)'}; use one of: ${Object.keys(AGENTS).join(', ')}`);
    process.exit(1);
  }
  return [...new Set(ids)];
}



function installService() {
  const node = process.execPath;
  fs.mkdirSync(path.join(INSTALL_DIR, 'logs'), { recursive: true });
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${RELAY}</string></array>
  <key>EnvironmentVariables</key><dict><key>CLAUDE_NUDGE_PORT</key><string>${PORT}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${path.join(INSTALL_DIR, 'logs', 'relay.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(INSTALL_DIR, 'logs', 'relay.err')}</string>
</dict></plist>
`);
    try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch (_) {}
    execFileSync('launchctl', ['load', PLIST], { stdio: 'ignore' });
    return 'launchd agent';
  }
  if (process.platform === 'linux') {
    try {
      fs.mkdirSync(path.dirname(SYSTEMD_UNIT), { recursive: true });
      fs.writeFileSync(SYSTEMD_UNIT, `[Unit]
Description=Nudge relay

[Service]
ExecStart=${node} ${RELAY}
Environment=CLAUDE_NUDGE_PORT=${PORT}
Restart=always

[Install]
WantedBy=default.target
`);
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      execFileSync('systemctl', ['--user', 'enable', '--now', 'claude-nudge.service'], { stdio: 'ignore' });
      return 'systemd user service';
    } catch (_) { /* fall through */ }
  }
  // Fallback: detached background process for this session only.
  const child = spawn(node, [RELAY], { detached: true, stdio: 'ignore', env: { ...process.env, CLAUDE_NUDGE_PORT: String(PORT) } });
  child.unref();
  return 'background process (re-run `npx nudge-mascot start` after a reboot)';
}

function removeService() {
  if (process.platform === 'darwin' && fs.existsSync(PLIST)) {
    try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch (_) {}
    fs.unlinkSync(PLIST);
  }
  if (process.platform === 'linux' && fs.existsSync(SYSTEMD_UNIT)) {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'claude-nudge.service'], { stdio: 'ignore' }); } catch (_) {}
    fs.unlinkSync(SYSTEMD_UNIT);
  }
}

function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1500 }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function waitForHealth(tries = 20) {
  return new Promise((resolve) => {
    const tick = async () => {
      const h = await health();
      if (h || tries-- <= 0) return resolve(h);
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function setup() {
  let agents = agentArgs();
  log('\nNudge · setup\n');
  if (!agents.length) {
    agents = Object.keys(AGENTS).filter(detected);
    if (!agents.length) agents = ['claude-code']; // nothing found: the original Claude Code-only install
    log(`  · agents found: ${agents.map((id) => AGENTS[id].label).join(', ')} (pick with --agent ${Object.keys(AGENTS).join('|')})`);
  }
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  copyDir(path.join(PKG, 'relay'), path.join(INSTALL_DIR, 'relay'));
  copyDir(path.join(PKG, 'extension'), path.join(INSTALL_DIR, 'extension'));
  fs.copyFileSync(path.join(PKG, 'hooks', 'nudge-hook.sh'), HOOK);
  fs.chmodSync(HOOK, 0o755);
  fs.copyFileSync(path.join(PKG, 'hooks', 'nudge-approve.js'), APPROVE);
  ok(`files installed in ${INSTALL_DIR}`);
  // Before the relay (re)starts, so it reads the secret at start. Kept across re-runs: the extension has it stored.
  const { secret: code, created } = secret.ensure();
  ok(`${created ? 'connection code created' : 'connection code kept'} in ${secret.FILE} (only you can read it)`);

  const notes = [];
  for (const id of agents) {
    const a = AGENTS[id];
    const r = installHooks(id);
    if (r.error) { warn(`${a.label}: hooks not installed: ${r.error}`); continue; }
    if (a.plugin) ok(`${a.label}: ${r.added ? 'plugin written to' : 'plugin already up to date in'} ${a.file}`);
    else ok(`${a.label}: ${r.added ? `${r.added} hook(s) added to ${a.file}${a.ownFile ? '' : ' (backup saved next to it)'}` : `hooks already present in ${a.file}`}`);
    if (a.note) notes.push(a.note);
    if (id === 'claude-code') {
      // The approval hooks power "reply from the bubble" (and the phone, once paired). installHooks() saved the backup.
      const approval = pairing.installApprovalHooks({ backup: false });
      ok(approval ? 'approval hooks added (PermissionRequest, PreToolUse/AskUserQuestion; they only wait while Chrome or a phone can answer)' : 'approval hooks already present');
    }
  }

  const how = installService();
  const h = await waitForHealth();
  if (h) ok(`relay running on 127.0.0.1:${h.port} (${how})`);
  else warn(`relay did not answer on port ${PORT}; try: npx nudge-mascot start`);

  log('\nLast step: install the extension.');
  if (STORE_URL) log(`  ${STORE_URL}`);
  else {
    log('  1. Open chrome://extensions and turn on Developer mode.');
    log(`  2. Click "Load unpacked" and pick: ${path.join(INSTALL_DIR, 'extension')}`);
  }
  log('  Then click the Nudge toolbar icon, choose Connect, and paste this code (`npx nudge-mascot status` prints it again):');
  log(`\n      ${code}\n`);
  const names = agents.map((id) => AGENTS[id].label).join(' / ');
  log(`\nThen restart any running ${names} session and run: npx nudge-mascot test`);
  for (const n of notes) log(n);
  log('');
}

async function status() {
  const h = await health();
  if (h) ok(`relay up on 127.0.0.1:${h.port}, ${h.clients} extension connection(s), ${h.events} recent event(s)`);
  else warn(`relay not reachable on 127.0.0.1:${PORT}`);
  for (const id of Object.keys(AGENTS)) {
    const a = AGENTS[id];
    const s = hookStatus(id);
    if (s.error) warn(`${a.label}: ${s.error}`);
    else if (!s.missing.length) ok(`${a.label}: hooks installed (${s.present.join(', ')})`);
    else if (s.present.length || detected(id)) warn(`${a.label}: hooks missing: ${s.missing.join(', ')}; run: npx nudge-mascot setup --agent ${id}`);
    else log(`  · ${a.label}: not detected`);
    if (id === 'claude-code' && !s.error) {
      if (pairing.hooksInstalled()) ok('approval hooks installed (PermissionRequest, PreToolUse/AskUserQuestion): reply from the bubble is on');
      else warn('approval hooks missing, so the bubble cannot answer Claude; run: npx nudge-mascot setup --agent claude-code');
    }
  }
  if (h && h.clients === 0) warn('no extension connected: load it from chrome://extensions and click its Reload icon, then paste the code below into its popup (Connect)');
  const code = secret.read();
  if (code) ok(`connection code (paste into the extension popup if it asks): ${code}`);
  else warn(`no connection code in ${secret.FILE}; run: npx nudge-mascot setup`);
  const cloud = pairing.read();
  if (cloud) {
    ok(`phone pairing on ${cloud.relay} (user ${cloud.userId})`);
  } else {
    log('  · no phone paired (optional): npx nudge-mascot pair, or "Pair a phone" in the extension popup');
  }
}

async function pair() {
  const i = process.argv.indexOf('--relay');
  const relay = i > 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
  log(`\nNudge · pair a phone via ${relay || pairing.DEFAULT_RELAY}\n`);
  let r;
  try { r = await pairing.start(relay); } catch (e) { warn(`could not reach the relay: ${e.message}`); return; }
  ok(`laptop token saved to ${pairing.CLOUD}`);
  ok('approval hooks in place for permissions and questions (wait up to 10 minutes for the phone)');
  log(`\n  In the Nudge app, scan this from the extension popup or enter it within ${Math.round(r.expiresInSeconds / 60)} minutes:\n`);
  log(`      ${r.pairCode}      relay: ${r.relay}\n`);
  log('Restart any running Claude Code session so the approval hooks load. Test with: npx nudge-mascot test approve\n');
}

function unpair() {
  const r = pairing.stop();
  if (r.wasPaired) ok('hosted relay forgotten'); else log('  · nothing was paired');
  log('  · approval hooks kept: the bubble still answers Claude (npx nudge-mascot uninstall removes everything)');
}

// The terminal this command runs in, in the same headers nudge-hook.sh sends, so a test nudge's
// "Jump to terminal" button switches back here.
function terminalHeaders() {
  const e = process.env;
  const h = {
    'X-Nudge-Terminal': e.TERM_PROGRAM || '',
    'X-Nudge-Terminal-Session': e.ITERM_SESSION_ID || e.TERM_SESSION_ID || '',
    'X-Nudge-Terminal-Bundle': e.__CFBundleIdentifier || '',
    'X-Nudge-Tmux': e.TMUX || '',
    'X-Nudge-Tmux-Pane': e.TMUX_PANE || '',
    'X-Nudge-Window': e.WINDOWID || '',
  };
  for (const k of Object.keys(h)) if (!h[k] || /[^\x20-\x7e]/.test(h[k])) delete h[k];
  return h;
}

function test(kind = 'question', agent = '') {
  const q = `kind=${encodeURIComponent(kind)}${agent ? `&agent=${encodeURIComponent(agent)}` : ''}`;
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: `/test?${q}`, method: 'POST', headers: { ...terminalHeaders(), 'X-Nudge-Secret': secret.read() || '' } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { log(res.statusCode === 200 ? `  ✓ sent a "${kind}" nudge${agent ? ` as ${AGENTS[agent].label}` : ''}` : `  ! ${b}`); resolve(); });
    });
    req.on('error', () => { warn(`relay not reachable on port ${PORT}; run: npx nudge-mascot setup`); resolve(); });
    req.end();
  });
}

function uninstall() {
  for (const id of Object.keys(AGENTS)) {
    const a = AGENTS[id];
    const r = removeHooks(id);
    if (r.error) warn(`${a.label}: ${r.error}; remove the nudge-hook.sh entries by hand`);
    else if (r.removed) ok(`${a.label}: ${r.removed} hook(s) removed from ${a.file}`);
    else if (id === 'claude-code') ok('hooks removed from settings.json');
  }
  removeService(); ok('relay service removed');
  fs.rmSync(INSTALL_DIR, { recursive: true, force: true }); ok(`${INSTALL_DIR} deleted`);
  log('Remove the extension from chrome://extensions to finish.');
}

function start() {
  const relay = fs.existsSync(RELAY) ? RELAY : path.join(PKG, 'relay', 'server.js');
  require(relay);
}

// Required (by scripts/install-test.js) rather than run: export the hook installers, run nothing.
if (require.main !== module) {
  module.exports = { AGENTS, ALIASES, HOOK, installHooks, removeHooks, hookStatus, detected, pluginSource };
  return;
}

const cmd = process.argv[2] || 'help';
({
  setup, start, status, uninstall, pair, unpair,
  test: () => {
    const agent = agentArgs()[0] || '';
    const kind = process.argv.slice(3).find((x, i, all) => !x.startsWith('--') && all[i - 1] !== '--agent');
    return test(kind, agent);
  },
  help: () => log(`Nudge

  npx nudge-mascot setup        install hooks + relay for every agent found, then load the extension
                                (--agent claude-code|codex|gemini|grok|cursor|opencode to pick; comma-separate several)
  npx nudge-mascot start        run the relay in the foreground
  npx nudge-mascot status       relay health and hook status per agent
  npx nudge-mascot test [kind]  question | questions | permission | approve | done | resolved
                                jump (Jump to terminal, back to this one) | jump-unknown | multi (three sessions)
                                --agent codex|gemini|grok|cursor|opencode: that agent's question | permission | done | resolved
  npx nudge-mascot pair         pair the Nudge phone app (optional; --relay URL to override)
  npx nudge-mascot unpair       forget the phone pairing
  npx nudge-mascot uninstall    remove everything this tool installed`),
}[cmd] || (() => { log(`unknown command: ${cmd}`); process.exit(1); }))();
