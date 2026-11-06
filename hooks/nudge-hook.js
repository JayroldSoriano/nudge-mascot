#!/usr/bin/env node
// Nudge hook for Windows: the same job as nudge-hook.sh, which needs sh and curl. Forwards the coding agent's hook
// payload (stdin JSON) to the local relay. Optional first argument: the agent (codex, gemini, grok, cursor, opencode),
// sent as ?agent=... so the relay picks its adapter. No argument means Claude Code. Fire-and-forget: 2s timeout,
// never fails, never prints, so the agent is never blocked when the relay is down.
// The X-Nudge-* headers name the terminal this session runs in (from the environment, as nudge-hook.sh does), so
// "Jump to terminal" can switch back to it. Windows Terminal sets no TERM_PROGRAM, only WT_SESSION.
// Zero dependencies.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.CLAUDE_NUDGE_PORT || 47831);
const agent = process.argv[2] || '';

function secret() {
  try { return fs.readFileSync(path.join(os.homedir(), '.claude-nudge', 'secret'), 'utf8').trim(); } catch (_) { return ''; }
}

function headers() {
  const e = process.env;
  const h = {
    'Content-Type': 'application/json',
    'X-Nudge-Secret': secret(),
    'X-Nudge-Terminal': e.TERM_PROGRAM || (e.WT_SESSION ? 'WindowsTerminal' : ''),
    'X-Nudge-Terminal-Session': e.ITERM_SESSION_ID || e.TERM_SESSION_ID || e.WT_SESSION || '',
    'X-Nudge-Terminal-Bundle': e.__CFBundleIdentifier || '',
    'X-Nudge-Tmux': e.TMUX || '',
    'X-Nudge-Tmux-Pane': e.TMUX_PANE || '',
    'X-Nudge-Window': e.WINDOWID || '',
  };
  // Header values must be plain ASCII or http.request throws.
  for (const k of Object.keys(h)) if (/[^\x20-\x7e]/.test(h[k])) h[k] = '';
  return h;
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  const query = /^[a-z0-9-]+$/.test(agent) ? `?agent=${agent}` : '';
  const req = http.request({ host: '127.0.0.1', port: PORT, path: `/hook${query}`, method: 'POST', headers: headers(), timeout: 2000 }, (res) => {
    res.resume();
    res.on('end', () => process.exit(0));
  });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(Buffer.concat(chunks));
});
setTimeout(() => process.exit(0), 3000).unref(); // a stdin that never closes still never blocks the agent
