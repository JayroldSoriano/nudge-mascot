#!/usr/bin/env node
// Nudge approval hook. Installed by `npx nudge-mascot setup` (and `pair`) for two events:
//   PermissionRequest            -> waits for Allow / Deny, returns a PermissionRequest decision
//   PreToolUse (AskUserQuestion) -> waits for the chosen option(s), returns updatedInput.answers
//
// Posts the request to the local relay, which shows it in the bubble and, when a phone is paired,
// forwards it to the cloud. Then waits for the decision and returns it to Claude Code.
// With no decision before the deadline it prints nothing, so the normal terminal prompt appears.
// When nothing can answer (relay down, no extension connected, no phone paired) it returns right away.
// Never fails: any error exits 0 with no output.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.CLAUDE_NUDGE_PORT || 47831);
// The per-install secret `setup` minted (relay/secret.js); the relay refuses requests without it.
const SECRET = (() => { try { return fs.readFileSync(path.join(os.homedir(), '.claude-nudge', 'secret'), 'utf8').trim(); } catch (_) { return ''; } })();
const WAIT_S = Number(process.env.CLAUDE_NUDGE_APPROVE_WAIT || 570); // hook timeout is 600
const POLL_MS = 25000;

function request(method, path, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { 'Content-Type': 'application/json', 'X-Nudge-Secret': SECRET }, timeout: POLL_MS + 5000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (body) req.write(body);
    req.end();
  });
}

// Maps every question to a chosen label: `answers` keyed by question text (or header), or a bare
// `answer` when there is a single question. Returns null until every question has an answer.
function answersFor(questions, d) {
  const out = {};
  for (const q of questions || []) {
    let a = d.answers && (d.answers[q.question] != null ? d.answers[q.question] : d.answers[q.header]);
    if (a == null && (questions || []).length === 1 && d.answer) a = d.answer;
    if (a == null) return null;
    out[q.question] = Array.isArray(a) ? a.join(', ') : String(a);
  }
  return Object.keys(out).length ? out : null;
}

(async () => {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let hook;
  try { hook = JSON.parse(raw); } catch (_) { return; }
  if (!hook.session_id) return;
  // Grok Build and Cursor also run the hooks in ~/.claude/settings.json; this hook only answers Claude Code, so never
  // hold them up (same telltales as hostAgent in relay/adapters/index.js).
  if ('hookEventName' in hook || 'workspaceRoot' in hook || 'cursor_version' in hook) return;
  // Claude Code 2.1.280 sends PermissionRequest without tool_use_id. Make up a fresh one for this invocation and send
  // it to the relay: it only ties this hook's POST /hook to its own GET /decision polls (and the phone's decision to
  // them). Never derive it from the request's content: the same command asked twice must not reuse the first answer.
  if (!hook.tool_use_id) hook.tool_use_id = 'pr-' + require('crypto').randomUUID();
  // The terminal this session runs in (same fields nudge-hook.sh sends as headers), for "Jump to terminal".
  const env = process.env;
  hook.terminal = env.TERM_PROGRAM || '';
  hook.terminal_session = env.ITERM_SESSION_ID || env.TERM_SESSION_ID || '';
  hook.terminal_bundle = env.__CFBundleIdentifier || '';
  hook.tmux = env.TMUX || '';
  hook.tmux_pane = env.TMUX_PANE || '';
  hook.terminal_window = env.WINDOWID || '';
  raw = JSON.stringify(hook);
  const isQuestion = hook.hook_event_name === 'PreToolUse' && hook.tool_name === 'AskUserQuestion';
  if (!isQuestion && hook.hook_event_name !== 'PermissionRequest') return;

  const posted = await request('POST', '/hook', raw);
  // No relay, or nothing that can answer (no phone paired, no extension connected for the bubble): don't make Claude wait.
  // `duplicate` means nudge-hook.sh already posted this question; the relay still tracks its decision.
  if (!posted || !posted.body || !(posted.body.emitted || posted.body.duplicate) || !posted.body.canDecide) return;

  const q = `session_id=${encodeURIComponent(hook.session_id)}&tool_use_id=${encodeURIComponent(hook.tool_use_id)}`;
  const deadline = Date.now() + WAIT_S * 1000;
  while (Date.now() < deadline) {
    const wait = Math.min(POLL_MS, deadline - Date.now());
    const res = await request('GET', `/decision?${q}&wait=${wait}`);
    if (!res) return; // relay went away
    const d = res.body && res.body.decision;
    if (isQuestion) {
      const answers = d && answersFor((hook.tool_input || {}).questions, d);
      if (answers) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { questions: hook.tool_input.questions, answers },
          },
        }));
        return;
      }
      if (d) await new Promise((r) => setTimeout(r, 2000)); // a partial answer: give the phone time to finish
      continue;
    }
    if (d && (d.behavior === 'allow' || d.behavior === 'deny')) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: d.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: `Denied from Nudge (${d.by || 'phone'})` },
        },
      }));
      return;
    }
  }
})().catch(() => {}).finally(() => process.exit(0));
