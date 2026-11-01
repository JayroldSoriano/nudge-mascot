'use strict';
// Agent adapters. Each one maps its agent's hook payload into the one event shape the extension and the
// phone understand:
//   { id, ts, session_id, project, cwd, hook_event, agent, kind, title, message,
//     options?, tool_name?, tool_use_id?, approvable? }
// kind is question | permission | done | idle | resolved. An adapter returns null for payloads it ignores.
// The relay adds the rest after normalizing: terminal (Jump back), test and notifyAfter (test nudges),
// decided / decision (once answered).
//
// Adapter interface: { name, label, normalize(hook, ctx), samples?(common) }
//   name       the value of ?agent= on POST /hook and of event.agent
//   label      the agent's display name ("Codex")
//   normalize  the mapping; uses only ctx for state, so tests can run it against a fresh context
//   samples    optional fake payloads by test kind (question, questions, permission, done, resolved, approve),
//              for /test. jump, jump-unknown and multi are built by the relay from these (server.js testEvents).
const path = require('path');

const adapters = {};
for (const a of [require('./claude-code'), require('./codex'), require('./gemini'), require('./grok'), require('./cursor'), require('./opencode')]) adapters[a.name] = a;
const DEFAULT_AGENT = 'claude-code';

function clip(text, max) {
  text = String(text || '').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (name === 'Bash') return input.command || '';
  if (input.file_path) return input.file_path;
  if (input.url) return input.url;
  if (input.pattern) return input.pattern;
  try { return JSON.stringify(input); } catch (_) { return ''; }
}

// Every session-keyed map is keyed by `${agent}:${session_id}`: two agents (or a test nudge) may use the same
// session_id, and one agent's PostToolUse must never resolve another's request.
const sessionKey = (agent, sessionId) => `${agent || DEFAULT_AGENT}:${sessionId || ''}`;

// The state the adapters share. The relay keeps one for its lifetime; the tests make a fresh one per case.
// `questionHookInstalled()`: whether nudge-approve.js is in Claude Code's settings for PreToolUse/AskUserQuestion (the
// relay passes pairing.questionHookInstalled); without it nothing waits for an answer, so questions are not
// answerable from the bubble.
function createContext({ questionHookInstalled = () => false } = {}) {
  // Time-based so ids stay unique across relay restarts (the hosted relay keeps events from earlier runs).
  let nextId = Date.now();
  const pending = new Map(); // session key -> kind of the nudge the agent is blocked on (question/permission)
  const lastPermission = new Map(); // session key -> ts of the last PermissionRequest event (dedupes the Notification that follows it)
  const lastDecided = new Map(); // session key -> ts the bubble or the phone last decided a request (the relay sets it)
  const lastText = new Map(); // session key -> the agent's last reply, for agents whose "done" event lacks it (Cursor)
  // Both nudge-hook.sh and nudge-approve.js post the same PreToolUse payload; emit it once.
  const seenToolUse = new Map(); // `${agent}:${tool_use_id}` -> ts
  function isDuplicate(agent, toolUseId) {
    const now = Date.now();
    for (const [k, t] of seenToolUse) if (now - t > 60000) seenToolUse.delete(k);
    const k = `${agent}:${toolUseId}`;
    if (seenToolUse.has(k)) return true;
    seenToolUse.set(k, now);
    return false;
  }
  // The fields every event starts with. Takes the next id, so call it once per payload, before deciding.
  function base(hook, agent) {
    return {
      id: nextId++,
      ts: Date.now(),
      session_id: hook.session_id || '',
      project: hook.cwd ? path.basename(hook.cwd) : '',
      cwd: hook.cwd || '',
      hook_event: hook.hook_event_name || '',
      agent,
    };
  }
  const key = (b) => sessionKey(b.agent, b.session_id);
  return { clip, toolSummary, pending, lastPermission, lastDecided, lastText, seenToolUse, isDuplicate, base, key, questionHookInstalled };
}

// Why decision `d` (from the bubble or the phone) can't answer the request event `ev`, or null when it can: a
// permission needs behavior allow|deny; a question needs an answer for every question, keyed by its text (or header,
// as older events had it), or a bare `answer` for a single question, which is how nudge-approve.js reads it. The relay
// rejects anything less, since a partial answer would take the request's one slot and leave the hook waiting.
function incompleteDecision(ev, d) {
  if (ev.kind === 'permission') return d.behavior === 'allow' || d.behavior === 'deny' ? null : 'behavior must be allow or deny';
  const qs = ev.options || [];
  if (!qs.length) return 'this question has nothing to answer';
  const answers = d.answers && typeof d.answers === 'object' && !Array.isArray(d.answers) ? d.answers : {};
  const given = (a) => (Array.isArray(a) ? a.length > 0 && a.every((x) => typeof x === 'string' && x) : typeof a === 'string' && a !== '');
  const missing = qs.filter((q) => {
    let a = answers[q.question] != null ? answers[q.question] : answers[q.header];
    if (a == null && qs.length === 1 && d.answer) a = String(d.answer);
    return !given(a);
  });
  return missing.length ? `answer every question (missing: ${missing.map((q, i) => q.header || q.question || `#${i + 1}`).join(', ')})` : null;
}

// The agent that really ran a hook, when its payload gives it away: Grok Build and Cursor also run the hooks they find
// in ~/.claude/settings.json (and Grok those in ~/.cursor/hooks.json), so Nudge's Claude Code hook fires inside them
// too. Grok's payloads carry hookEventName / workspaceRoot, Cursor's cursor_version; Claude Code, Codex, Gemini CLI
// and the OpenCode plugin send none of these. null: no telltale. The relay drops a hook whose host is another agent
// than its ?agent= (that agent's own hooks report it), and nudge-approve.js does not wait on one.
function hostAgent(hook) {
  if (!hook || typeof hook !== 'object') return null;
  if ('hookEventName' in hook || 'workspaceRoot' in hook) return 'grok';
  if ('cursor_version' in hook) return 'cursor';
  return null;
}

// Resolves ?agent= to an adapter: missing or empty means Claude Code; an unknown name returns null.
function adapterFor(agent) {
  return adapters[agent || DEFAULT_AGENT] || null;
}

module.exports = { adapters, adapterFor, hostAgent, createContext, sessionKey, incompleteDecision, clip, toolSummary, DEFAULT_AGENT };
