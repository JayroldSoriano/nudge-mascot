'use strict';
// Jump back: brings the terminal a Claude Code session runs in to the front. Zero dependencies.
//
// Hook payloads carry cwd and session_id but not the terminal, so the hooks also send what their environment says
// (nudge-hook.sh as X-Nudge-* headers, nudge-approve.js as body fields): TERM_PROGRAM, the iTerm2/Terminal session
// id, macOS's __CFBundleIdentifier of the app that launched the shell (tells VS Code from Cursor and other forks),
// tmux's socket and pane, and X11's WINDOWID. The relay keeps the latest per agent and session; POST /focus uses it.
//   macOS: osascript `tell application … to activate` (iTerm2 also selects the session), falling back to `open`.
//   Linux: wmctrl or xdotool, by window id when the terminal exported one, else by window class.
//   Windows: PowerShell's WScript.Shell AppActivate on the newest window of the terminal's process. Windows may only
//     flash its taskbar button instead: a background process can't always take the foreground.
const { execFile } = require('child_process');
const fs = require('fs');

// TERM_PROGRAM -> the macOS app. `bundle` wins over `name` when activating; `name` is what the bubble says.
const MAC_APPS = {
  'iTerm.app': { name: 'iTerm2', bundle: 'com.googlecode.iterm2' },
  Apple_Terminal: { name: 'Terminal', bundle: 'com.apple.Terminal' },
  vscode: { name: 'Visual Studio Code', bundle: 'com.microsoft.VSCode' },
  cursor: { name: 'Cursor', bundle: 'com.todesktop.230313mmzas' },
  WarpTerminal: { name: 'Warp', bundle: 'dev.warp.Warp-Stable' },
  ghostty: { name: 'Ghostty', bundle: 'com.mitchellh.ghostty' },
  WezTerm: { name: 'WezTerm', bundle: 'com.github.wez.wezterm' },
  Hyper: { name: 'Hyper', bundle: 'co.zeit.hyper' },
  Tabby: { name: 'Tabby', bundle: 'org.tabby' },
  zed: { name: 'Zed', bundle: 'dev.zed.Zed' },
  kitty: { name: 'kitty', bundle: 'net.kovidgoyal.kitty' },
};
const BUNDLE_NAMES = Object.fromEntries(Object.values(MAC_APPS).map((a) => [a.bundle, a.name]));
Object.assign(BUNDLE_NAMES, {
  'com.microsoft.VSCodeInsiders': 'VS Code Insiders', 'com.vscodium': 'VSCodium', 'com.exafunction.windsurf': 'Windsurf',
  'org.alacritty': 'Alacritty', 'com.jetbrains.intellij': 'IntelliJ IDEA', 'com.jetbrains.WebStorm': 'WebStorm',
  'com.jetbrains.pycharm': 'PyCharm', 'dev.warp.Warp-Preview': 'Warp', 'com.mitchellh.ghostty.debug': 'Ghostty',
});
// TERM_PROGRAM (or WindowsTerminal, which the hooks send when only WT_SESSION is set) -> the Windows process names to
// try, in order. VS Code, Cursor and Windsurf all say "vscode". Fixed names only: they go into a PowerShell command.
const WIN_APPS = {
  WindowsTerminal: { name: 'Windows Terminal', procs: ['WindowsTerminal'] },
  vscode: { name: 'Visual Studio Code', procs: ['Code', 'Cursor', 'Windsurf', 'Code - Insiders', 'VSCodium'] },
  cursor: { name: 'Cursor', procs: ['Cursor'] },
  mintty: { name: 'Git Bash', procs: ['mintty'] },
  WezTerm: { name: 'WezTerm', procs: ['wezterm-gui'] },
  Hyper: { name: 'Hyper', procs: ['Hyper'] },
  Tabby: { name: 'Tabby', procs: ['Tabby'] },
};
const MULTIPLEXERS = new Set(['tmux', 'screen']); // TERM_PROGRAM inside them names no app

const BUNDLE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
const NAME_RE = /^[A-Za-z0-9][\w .+-]{0,63}$/;
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const WINDOW_RE = /^(0x[0-9A-Fa-f]{1,16}|\d{1,20})$/;
const PANE_RE = /^%\d{1,6}$/;
// tmux's socket: $TMUX_TMPDIR (default /tmp, /private/tmp on macOS) + /tmux-<uid>/<name>. Nothing else is passed to -S.
const SOCKET_RE = /^(?:\/[\w.@-]+)+\/tmux-\d{1,10}\/[\w.@-]{1,100}$/;

const sessions = new Map(); // `${agent}:${session_id}` (adapters' sessionKey) -> terminal info
const MAX_SESSIONS = 200;

const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// The terminal fields of a hook post: body fields (nudge-approve.js) or X-Nudge-* headers (nudge-hook.sh, the CLI).
function fromHook(hook, headers) {
  const h = headers || {}, b = hook || {};
  const info = {
    terminal: clean(b.terminal || h['x-nudge-terminal'], 64),
    terminal_session: clean(b.terminal_session || h['x-nudge-terminal-session']),
    terminal_bundle: clean(b.terminal_bundle || h['x-nudge-terminal-bundle'], 128),
    tmux: clean(b.tmux || h['x-nudge-tmux']),
    tmux_pane: clean(b.tmux_pane || h['x-nudge-tmux-pane'], 16),
    terminal_window: clean(b.terminal_window || h['x-nudge-window'], 24),
  };
  return Object.values(info).some(Boolean) ? info : null;
}

// Keeps the latest terminal per session. A post without terminal fields (an older hook) never erases a known one.
function remember(sessionId, info) {
  if (!sessionId || !info) return;
  sessions.delete(sessionId);
  sessions.set(sessionId, { ...info, ts: Date.now() });
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
}
const get = (sessionId) => sessions.get(sessionId) || null;
const forget = (sessionId) => sessions.delete(sessionId);

// What the bubble calls the app, e.g. "iTerm2". Empty when nothing is known.
function label(sessionId) {
  const t = get(sessionId);
  if (!t) return '';
  if (BUNDLE_NAMES[t.terminal_bundle]) return BUNDLE_NAMES[t.terminal_bundle];
  if (t.terminal_bundle && BUNDLE_RE.test(t.terminal_bundle) && !MAC_APPS[t.terminal]) return t.terminal_bundle.split('.').pop();
  if (MAC_APPS[t.terminal]) return MAC_APPS[t.terminal].name;
  if (WIN_APPS[t.terminal]) return WIN_APPS[t.terminal].name;
  return MULTIPLEXERS.has(t.terminal) ? '' : t.terminal;
}

function tmuxBinary() {
  for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux', '/bin/tmux']) if (fs.existsSync(p)) return p;
  return null;
}

// tmux: switch the client to the session's window and pane. Best effort, before activating the app around it.
function tmuxStep(t) {
  const socket = t.tmux.split(',')[0];
  const bin = tmuxBinary();
  if (!bin || !SOCKET_RE.test(socket) || socket.split('/').includes('..') || !PANE_RE.test(t.tmux_pane)) return null;
  return { cmd: bin, args: ['-S', socket, 'select-window', '-t', t.tmux_pane, ';', 'select-pane', '-t', t.tmux_pane], optional: true };
}

// The commands to run, in order: `optional` ones may fail; `alternatives` stop at the first that works.
// null when there is nothing to activate; { unsupported } on platforms without a way to do it.
function plan(t, platform = process.platform) {
  const steps = [];
  const tmux = tmuxStep(t);
  if (tmux) steps.push(tmux);
  if (platform === 'darwin') {
    const known = MAC_APPS[t.terminal];
    const bundle = BUNDLE_RE.test(t.terminal_bundle) ? t.terminal_bundle : known ? known.bundle : '';
    const name = known ? known.name : NAME_RE.test(t.terminal) && !MULTIPLEXERS.has(t.terminal) ? t.terminal.replace(/\.app$/, '') : '';
    if (!bundle && !name) return null;
    const target = bundle ? `application id "${bundle}"` : `application "${name}"`;
    // ITERM_SESSION_ID is "w0t1p0:<uuid>"; iTerm2's AppleScript knows sessions by that uuid.
    const uuid = (t.terminal_session.split(':')[1] || '');
    if (bundle === 'com.googlecode.iterm2' && UUID_RE.test(uuid)) {
      steps.push({ cmd: 'osascript', args: ['-e', [
        `tell ${target}`,
        '  activate',
        '  repeat with w in windows',
        '    repeat with t in tabs of w',
        '      repeat with s in sessions of t',
        `        if unique id of s is "${uuid}" then`,
        '          tell w to select',
        '          tell t to select',
        '          tell s to select',
        '          return "selected"',
        '        end if',
        '      end repeat',
        '    end repeat',
        '  end repeat',
        'end tell',
      ].join('\n')], optional: true, selects: true });
    }
    steps.push({ alternatives: [
      { cmd: 'osascript', args: ['-e', `tell ${target} to activate`] },
      bundle ? { cmd: 'open', args: ['-b', bundle] } : { cmd: 'open', args: ['-a', name] },
    ] });
    return { steps, app: BUNDLE_NAMES[bundle] || (known && known.name) || name || bundle };
  }
  if (platform === 'linux') {
    const win = WINDOW_RE.test(t.terminal_window) ? t.terminal_window : '';
    const cls = NAME_RE.test(t.terminal) && !MULTIPLEXERS.has(t.terminal) ? t.terminal : '';
    if (!win && !cls) return null;
    steps.push({ alternatives: win
      ? [{ cmd: 'wmctrl', args: ['-i', '-a', win] }, { cmd: 'xdotool', args: ['windowactivate', String(win.startsWith('0x') ? parseInt(win, 16) : win)] }]
      : [{ cmd: 'wmctrl', args: ['-x', '-a', cls] }, { cmd: 'xdotool', args: ['search', '--limit', '1', '--class', cls, 'windowactivate'] }] });
    return { steps, app: cls || 'terminal window' };
  }
  if (platform === 'win32') {
    const known = WIN_APPS[t.terminal];
    if (!known) return null;
    const names = known.procs.map((n) => `'${n}'`).join(',');
    // One line: a newline inside a -Command argument is not safe across PowerShell versions.
    const script = `foreach ($n in @(${names})) { `
      + '$p = Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1; '
      + 'if ($p -and (New-Object -ComObject WScript.Shell).AppActivate($p.Id)) { exit 0 } }; '
      + "[Console]::Error.WriteLine('no open window'); exit 1";
    steps.push({ alternatives: [{ cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script] }] });
    return { steps, app: known.name };
  }
  return { unsupported: true };
}

function run(step) {
  return new Promise((resolve) => {
    execFile(step.cmd, step.args, { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, missing: err.code === 'ENOENT', error: String(stderr || err.message).trim().split('\n')[0] } : { ok: true, out: String(stdout).trim() });
    });
  });
}

// Resolves { status, body } for POST /focus.
async function focus(sessionId, { dryRun = !!process.env.CLAUDE_NUDGE_FOCUS_DRY_RUN } = {}) {
  const t = get(sessionId);
  if (!t) return { status: 404, body: { error: "Nudge doesn't know this session's terminal yet. Restart Claude Code after updating Nudge, or switch to it yourself." } };
  const p = plan(t);
  if (p && p.unsupported) return { status: 501, body: { error: `Jump to terminal isn't supported on ${process.platform} yet.` } };
  if (!p) return { status: 404, body: { error: `Can't tell which app runs this session (TERM_PROGRAM is ${t.terminal ? `"${t.terminal}"` : 'not set'}). Switch to it yourself.` } };
  if (dryRun) return { status: 200, body: { ok: true, app: p.app, dryRun: true, plan: p.steps } };
  let selected = false;
  for (const step of p.steps) {
    if (step.optional) {
      const r = await run(step);
      if (r.ok && step.selects && r.out === 'selected') { selected = true; break; } // iTerm2 already activated it
      continue;
    }
    const errors = [];
    let missing = 0;
    for (const alt of step.alternatives) {
      const r = await run(alt);
      if (r.ok) { errors.length = 0; break; }
      errors.push(r.error);
      if (r.missing) missing++;
    }
    if (missing === step.alternatives.length) {
      return { status: 501, body: { error: process.platform === 'linux' ? 'Jump to terminal on Linux needs wmctrl or xdotool. Install one, then try again.' : `Couldn't run ${step.alternatives[0].cmd}.` } };
    }
    if (errors.length) return { status: 500, body: { error: `Couldn't switch to ${p.app}: ${errors[errors.length - 1]}` } };
  }
  return { status: 200, body: { ok: true, app: p.app, selected } };
}

module.exports = { fromHook, remember, get, forget, label, plan, focus, MAC_APPS, WIN_APPS };
