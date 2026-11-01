#!/usr/bin/env node
'use strict';
// Nudge relay: receives coding-agent hook payloads over HTTP (from hooks/nudge-hook.sh: Claude Code, Codex,
// Gemini CLI, Grok Build, Cursor, OpenCode), normalizes them per agent (relay/adapters/), and pushes the events to the Chrome extension
// over a WebSocket.
// Zero dependencies. Binds to 127.0.0.1 only.

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pairing = require('./pairing');
const focus = require('./focus'); // Jump back: which terminal each session runs in, and how to bring it forward
const stats = require('./stats'); // Waiting stats: ~/.claude-nudge/stats.jsonl
const secret = require('./secret'); // The per-install secret every client but /health must send
const { adapterFor, hostAgent, createContext, sessionKey, incompleteDecision: incomplete, DEFAULT_AGENT } = require('./adapters');

const HOST = '127.0.0.1';
const PORT = Number(process.env.CLAUDE_NUDGE_PORT || 47831);
const MAX_RECENT = 25;
const PING_INTERVAL_MS = 20000; // keeps the MV3 service worker alive (Chrome extends SW life on WS activity)

const recent = [];
const sockets = new Set(); // extension sockets that sent the secret: they get every event and decision
const lockedSockets = new Set(); // extension sockets without it: a hello saying so, nothing else
// Per-agent hook adapters (relay/adapters/<agent>.js) and the state they share: pending, lastPermission, dedupe, ids.
// questionHookInstalled: questions are answerable from the bubble or the phone only when nudge-approve.js is
// installed for PreToolUse/AskUserQuestion.
const ctx = createContext({ questionHookInstalled: pairing.questionHookInstalled });

// Optional hosted relay (phone app). Written by `npx nudge-mascot pair`; read on every use so pairing
// takes effect without a restart. Nothing here runs unless the file exists.
const CLOUD_FILE = process.env.CLAUDE_NUDGE_CLOUD || path.join(os.homedir(), '.claude-nudge', 'cloud.json');
const decisions = new Map(); // `${agent}:${session_id}:${tool_use_id}` -> decision from the bubble or the phone

function cloud() {
  try {
    const c = JSON.parse(fs.readFileSync(CLOUD_FILE, 'utf8'));
    return c && c.relay && c.laptopToken ? c : null;
  } catch (_) { return null; }
}

// ---------- local auth ----------
// 127.0.0.1 is reachable by every process and user on the machine, so everything but /health needs the per-install
// secret (relay/secret.js): the hooks and the CLI read it from ~/.claude-nudge/secret, the extension has it pasted
// into its popup. Re-read from disk whenever a request fails, so a secret minted after start works without a restart.
let SECRET = null;
try { SECRET = secret.ensure().secret; } catch (e) { console.error(`[nudge] could not create ${secret.FILE}: ${e.message}`); }
function authorized(given) {
  if (!given) return false;
  if (secret.matches(given, SECRET)) return true;
  const fresh = secret.read();
  if (!fresh || fresh === SECRET) return false;
  SECRET = fresh;
  return secret.matches(given, SECRET);
}
const fromExtension = (req) => String(req.headers.origin || '').startsWith('chrome-extension://');
const UNAUTHORIZED = { error: 'Nudge needs its connection code. Run `npx nudge-mascot status` and paste the code into the extension popup.', auth: 'secret' };
// What an extension without the secret may see of an event: that something happened, not what.
const redact = (e) => ({ id: e.id, ts: e.ts, kind: e.kind, title: e.title, agent: e.agent, message: e.message ? '(connect to see)' : '' });

// ---------- event normalization ----------
// Each agent's adapter maps its hook payload into the shared event shape (see relay/adapters/index.js).
// Returns undefined for an unknown agent, null for a payload the adapter ignores.
function normalize(hook, agent) {
  const adapter = adapterFor(agent);
  if (!adapter) return undefined;
  return adapter.normalize(hook, ctx);
}

// A fake hook payload of the given kind from the agent's adapter (its samples()), normalized like a real one.
// `undefined` for an unknown agent or a kind that agent has no sample for (only Claude Code has `approve` and
// `questions`). jump / jump-unknown are the agent's `done` with a message about the Jump button.
// phoneDelay=N: the paired phone raises its notification N seconds later (time to lock the screen).
// Test sessions are "test" or "test-…"; POST /decision answers them without a hook behind them.
const JUMP_MESSAGES = {
  jump: 'Test nudge for Jump back. Click "Jump to terminal" to switch to the terminal this session runs in.',
  'jump-unknown': 'Test nudge from a session whose terminal Nudge does not know. "Jump to terminal" explains why it cannot switch.',
};
function testEvent(kind, phoneDelay, { session_id = 'test', cwd = process.cwd(), agent = DEFAULT_AGENT } = {}) {
  const adapter = adapterFor(agent);
  const samples = adapter && adapter.samples ? adapter.samples({ cwd, session_id }) : {};
  const sample = samples[JUMP_MESSAGES[kind] ? 'done' : kind];
  if (!sample) return undefined;
  const event = adapter.normalize(sample, ctx);
  if (!event) return event;
  event.test = true;
  if (JUMP_MESSAGES[kind]) event.message = JUMP_MESSAGES[kind];
  // No hook behind it; POST /decision accepts session "test" anyway. Claude Code only: other agents' requests
  // can't be answered from the bubble, so their previews shouldn't offer it either.
  if (event.tool_use_id && event.agent === DEFAULT_AGENT) event.approvable = true;
  if (phoneDelay > 0) event.notifyAfter = Math.min(phoneDelay, 60);
  return event;
}

// The events a /test (or a phone's test command) emits: one, or three sessions' worth for "multi".
// `terminal` is the caller's terminal (the CLI sends its own, like the hooks do); without one, "jump" uses a
// stand-in (Terminal on macOS) so the button can be previewed from the popup.
// Each agent gets its own test sessions ("test", "test-api" for Claude Code; "test-codex", "test-codex-api" for
// Codex), so one agent's test never resolves another's. Claude Code keeps plain "test", which the hosted relay and
// the popup's Preview nudge already use.
const testSession = (agent, suffix) => ['test', agent === DEFAULT_AGENT ? '' : agent, suffix || ''].filter(Boolean).join('-');
function testEvents(kind, phoneDelay, terminal, agent = DEFAULT_AGENT) {
  if (!adapterFor(agent)) return undefined;
  const remember = (sid, fallback) => {
    const key = sessionKey(agent, sid);
    if (terminal) focus.remember(key, terminal);
    else if (fallback && !focus.get(key)) focus.remember(key, process.platform === 'darwin' ? { terminal: 'Apple_Terminal', terminal_session: '', terminal_bundle: '', tmux: '', tmux_pane: '', terminal_window: '' } : { terminal: 'gnome-terminal', terminal_session: '', terminal_bundle: '', tmux: '', tmux_pane: '', terminal_window: '' });
  };
  if (kind === 'multi') {
    // Three projects blocked at once, waiting 7 min, 3 min and 40 s: previews the session switcher.
    const now = Date.now();
    return [['question', '', 'web-app', 7 * 60e3], ['approve', 'api', 'api-server', 3 * 60e3], ['permission', 'docs', 'docs-site', 40e3]]
      .map(([k, suffix, project, ago]) => {
        const sid = testSession(agent, suffix);
        remember(sid, true);
        const event = testEvent(k, phoneDelay, { session_id: sid, cwd: path.join(os.homedir(), 'code', project), agent });
        if (event) event.ts = now - ago;
        return event;
      }).filter(Boolean);
  }
  if (kind === 'jump-unknown') {
    const sid = testSession(agent, 'unknown');
    focus.forget(sessionKey(agent, sid));
    const event = testEvent(kind, phoneDelay, { session_id: sid, agent });
    return event === undefined ? undefined : [event].filter(Boolean);
  }
  const sid = testSession(agent);
  remember(sid, kind === 'jump');
  const event = testEvent(kind, phoneDelay, { session_id: sid, agent });
  return event === undefined ? undefined : [event].filter(Boolean);
}
const isTestSession = (sid) => /^test(-|$)/.test(sid);

// What the relay remembers about requests and sessions, beyond `recent` (which only holds the last 25 events):
const requests = new Map(); // decision key -> the approvable question/permission event (validates answers, B2's resolved)
const waitingOn = new Map(); // session key -> id of its latest question/permission event, until resolved or done
const ended = new Map(); // session key -> { id, kind, tool_use_id } of its last resolved/done event (sent in the hello)
const capped = (map, max) => { while (map.size > max) map.delete(map.keys().next().value); };

function track(event) {
  const key = sessionKey(event.agent, event.session_id);
  if (event.kind === 'question' || event.kind === 'permission') {
    waitingOn.set(key, event.id);
    if (event.tool_use_id) { requests.set(decisionKey(event), event); capped(requests, 300); }
  } else if (event.kind === 'resolved' || event.kind === 'done') {
    waitingOn.delete(key);
    ended.delete(key);
    ended.set(key, { id: event.id, kind: event.kind, ...(event.tool_use_id ? { tool_use_id: event.tool_use_id } : {}) });
    capped(ended, 300);
  }
  capped(waitingOn, 300);
}

function emit(event) {
  // Which app "Jump to terminal" would switch to, when the session's hooks reported one.
  const app = event.session_id && focus.label(sessionKey(event.agent, event.session_id));
  if (app) event.terminal = app;
  stats.observe(event);
  track(event);
  recent.push(event);
  if (recent.length > MAX_RECENT) recent.shift();
  const frame = encodeFrame(JSON.stringify({ type: 'event', event }));
  for (const s of sockets) safeWrite(s, frame);
  log(`event #${event.id} ${event.kind}${event.agent && event.agent !== DEFAULT_AGENT ? ' ' + event.agent : ''} [${event.project}] -> ${sockets.size} client(s)`);
  forward(event);
}

// Mirror the event to the hosted relay when a phone is paired. Fire-and-forget; the bubble never waits on it.
function forward(event) {
  const c = cloud();
  if (!c || typeof fetch !== 'function') return;
  fetch(`${c.relay}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.laptopToken}` },
    body: JSON.stringify({ event }),
    signal: AbortSignal.timeout(5000),
  }).then((r) => { if (!r.ok) log(`cloud rejected event #${event.id}: HTTP ${r.status}`); })
    .catch((e) => log(`cloud forward failed: ${e.message}`));
}

// ---------- hosted relay link ----------
// While paired, keep a WebSocket to the hosted relay: phones' decisions and "run a test nudge" commands arrive
// here, and the hosted relay can tell phones whether this laptop is online. Re-checked every 5 s, so pairing
// or unpairing from the popup takes effect without a restart.
let cloudWs = null, cloudWsToken = null;
function connectCloud() {
  const c = cloud();
  if (!c || typeof WebSocket === 'undefined') {
    if (cloudWs) { try { cloudWs.close(); } catch (_) {} cloudWs = null; cloudWsToken = null; }
    return;
  }
  if (cloudWs && cloudWsToken === c.laptopToken && cloudWs.readyState <= 1) return; // open or connecting
  if (cloudWs) { try { cloudWs.close(); } catch (_) {} }
  cloudWsToken = c.laptopToken;
  const ws = new WebSocket(`${c.relay.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(c.laptopToken)}`);
  cloudWs = ws;
  ws.onopen = () => log(`cloud link up (${c.relay})`);
  ws.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(String(m.data)); } catch (_) { return; }
    if (msg.type === 'decision' && msg.decision) recordDecision(msg.decision);
    if (msg.type === 'command' && msg.command === 'test') {
      const events = testEvents(msg.kind || 'approve', Number(msg.phoneDelay) || 0, null, msg.agent || DEFAULT_AGENT) || [];
      for (const event of events) emit(event);
      if (events.length) log(`test "${msg.kind}" requested from a phone`);
    }
  };
  ws.onclose = () => { if (cloudWs === ws) { cloudWs = null; log('cloud link closed'); } };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}
setInterval(connectCloud, 5000).unref();
setInterval(() => { if (cloudWs && cloudWs.readyState === 1) { try { cloudWs.send(JSON.stringify({ type: 'ping' })); } catch (_) {} } }, PING_INTERVAL_MS).unref();
connectCloud();

// ---------- decisions ----------
// A decision for the approval hook: from the bubble (POST /decision) or, when paired, from the phone via the cloud.
// Keys carry the agent (a decision without one is Claude Code's, the only agent the bubble and phone answer).
const waiters = new Map(); // key -> Set of wake functions, one per open GET /decision long poll
const lastPoll = new Map(); // key -> ts a long poll last ended with nothing (the hook re-polls right away)
const hookGone = new Map(); // key -> ts the approval hook hung up mid-poll without a decision (answered in the terminal)
const decisionKey = (d) => `${sessionKey(d.agent, d.session_id)}:${d.tool_use_id}`;

// The short label the phone shows on a decided card: "allow", "Yes", or "A, B" for several answers.
function decisionLabel(d) {
  if (d.behavior) return d.behavior;
  const labels = d.answers ? Object.values(d.answers).flat().filter(Boolean) : [];
  return labels.length ? labels.join(', ') : String(d.answer || '');
}

// Stores a decision once (the cloud echoes the bubble's own decision back), marks its event in `recent` so a
// reconnecting extension sees it answered, wakes the waiting hook and tells every extension socket.
// An incomplete one (see incomplete()) is dropped, so it never takes the slot or settles anyone's bubble.
function recordDecision(d) {
  if (!d || !d.session_id || !d.tool_use_id) return false;
  const key = decisionKey(d);
  if (decisions.has(key)) return false;
  const req = requests.get(key);
  const bad = req && incomplete(req, d);
  if (bad) { log(`ignored a decision by ${d.by || '?'} for ${d.tool_use_id}: ${bad}`); return false; }
  decisions.set(key, d);
  const skey = sessionKey(d.agent, d.session_id);
  ctx.lastDecided.set(skey, Date.now()); // the terminal's permission_prompt may still arrive: the adapter skips it
  capped(ctx.lastDecided, 300);
  stats.finish(skey, d.by === 'phone' ? 'phone' : 'bubble');
  capped(decisions, 200);
  lastPoll.delete(key);
  const ev = recent.find((e) => e.tool_use_id && decisionKey(e) === key);
  if (ev) { ev.decided = decisionLabel(d); ev.decision = d; }
  for (const wake of waiters.get(key) || []) wake(d);
  const frame = encodeFrame(JSON.stringify({ type: 'decision', decision: d }));
  for (const s of sockets) safeWrite(s, frame);
  log(`decision ${decisionLabel(d)} by ${d.by || '?'} for ${d.tool_use_id} -> ${sockets.size} client(s)`);
  return true;
}

// True while the approval hook is long-polling this key (between two polls counts too).
function hookWaiting(key) {
  return waiters.has(key) || Date.now() - (lastPoll.get(key) || 0) < 5000;
}

// The approval hook hung up mid-poll with no decision: Claude Code killed it because the question or permission was
// answered in the terminal (a Deny there fires no PostToolUse, so nothing else would tell us). Unless it re-polls,
// emit a `resolved` for its session, which takes the nudge away and closes the wait in the stats as "terminal".
// Skipped when the session has moved on to a newer request since.
function onHookGone(key) {
  if (decisions.has(key) || hookWaiting(key)) return;
  hookGone.set(key, Date.now());
  capped(hookGone, 200);
  const ev = requests.get(key);
  if (!ev) return;
  const skey = sessionKey(ev.agent, ev.session_id);
  if (waitingOn.get(skey) !== ev.id) return;
  ctx.pending.delete(skey);
  log(`approval hook for ${ev.tool_use_id} went away: answered in the terminal`);
  emit({ ...ctx.base({ session_id: ev.session_id, cwd: ev.cwd, hook_event_name: 'ApprovalHookGone' }, ev.agent), kind: 'resolved', title: 'Resolved', message: '', tool_use_id: ev.tool_use_id });
}

// Resolves with the decision, or null after waitMs. `cancel()` ends it early (the hook went away).
function awaitDecision(key, sessionId, toolUseId, waitMs) {
  if (decisions.has(key)) return { promise: Promise.resolve(decisions.get(key)), cancel() {} };
  const ac = new AbortController();
  let finish;
  const promise = new Promise((resolve) => {
    let done = false;
    const set = waiters.get(key) || new Set();
    finish = (d, timedOut, gone) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ac.abort();
      set.delete(finish);
      if (!set.size) waiters.delete(key);
      if (timedOut) {
        lastPoll.set(key, Date.now());
        for (const [k, t] of lastPoll) if (Date.now() - t > 60000) lastPoll.delete(k);
      }
      if (gone && !d) {
        lastPoll.delete(key); // it is not between two polls: it is gone, unless it polls again within the grace
        setTimeout(() => onHookGone(key), 1500);
      }
      resolve(d || null);
    };
    set.add(finish);
    waiters.set(key, set);
    const timer = setTimeout(() => finish(null, true), waitMs);
    // An incomplete phone answer is not recorded; this waiter then just runs to its timeout.
    pollCloud(sessionId, toolUseId, ac.signal).then((d) => { if (d && (recordDecision(d) || decisions.has(key))) finish(decisions.get(key)); });
  });
  return { promise, cancel: () => finish(null, false, true) };
}

// When paired, also long-poll the hosted relay: catches a phone decision made while the cloud socket was down.
async function pollCloud(sessionId, toolUseId, signal) {
  const c = cloud();
  if (!c || typeof fetch !== 'function') return null;
  while (!signal.aborted) {
    try {
      const r = await fetch(`${c.relay}/decisions?session_id=${encodeURIComponent(sessionId)}&tool_use_id=${encodeURIComponent(toolUseId)}&wait=25000`, {
        headers: { Authorization: `Bearer ${c.laptopToken}` },
        signal,
      });
      if (r.status === 200) {
        const d = (await r.json()).decision;
        if (d) return d;
      } else if (r.status !== 204) {
        await new Promise((res) => setTimeout(res, 2000));
      }
    } catch (e) {
      if (signal.aborted) return null;
      log(`cloud poll failed: ${e.message}`);
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
  return null;
}

// ---------- minimal WebSocket server ----------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function safeWrite(socket, buf) {
  try {
    if (!socket.destroyed) socket.write(buf);
  } catch (_) {
    dropSocket(socket);
  }
}
const dropSocket = (socket) => { sockets.delete(socket); lockedSockets.delete(socket); };

// Parses complete client frames from socket._buf; returns when more data is needed.
function handleFrames(socket) {
  for (;;) {
    const buf = socket._buf;
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return;
    const mask = masked ? buf.subarray(offset, offset + 4) : null;
    const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    socket._buf = buf.subarray(offset + maskLen + len);

    if (opcode === 0x8) { // close
      safeWrite(socket, encodeFrame(payload, 0x8));
      socket.end();
      dropSocket(socket);
      return;
    }
    if (opcode === 0x9) { // ping -> pong
      safeWrite(socket, encodeFrame(payload, 0xa));
    } else if (opcode === 0x1) {
      let msg = null;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (_) {}
      if (msg && msg.type === 'ping') safeWrite(socket, encodeFrame(JSON.stringify({ type: 'pong' })));
    }
  }
}

// A second layer under the secret: web pages (http(s):// origins) are refused before anything else.
function isTrustedOrigin(req) {
  // The extension sends chrome-extension://... ; curl sends none. Any web page would send http(s)://...
  const origin = req.headers.origin;
  return !origin || origin.startsWith('chrome-extension://');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (!isTrustedOrigin(req)) return json(403, { error: 'forbidden origin' });

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(200, { ok: true, clients: sockets.size, events: recent.length, port: PORT, cloud: !!cloud() });
  }
  // Everything below needs the secret. The extension without it may still see that events happen (redacted), so the
  // popup can say what is missing.
  const authed = authorized(req.headers[secret.HEADER]);
  if (req.method === 'GET' && url.pathname === '/events') {
    if (authed) return json(200, { events: recent });
    if (fromExtension(req)) return json(200, { events: recent.map(redact), locked: true });
    return json(401, UNAUTHORIZED);
  }
  if (!authed) return json(401, UNAUTHORIZED);
  if (req.method === 'POST' && (url.pathname === '/hook' || url.pathname === '/test')) {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      if (url.pathname === '/test') {
        const kind = url.searchParams.get('kind') || 'question';
        const agent = url.searchParams.get('agent') || DEFAULT_AGENT;
        const events = testEvents(kind, Number(url.searchParams.get('phoneDelay') || 0), focus.fromHook(null, req.headers), agent);
        if (events === undefined) return json(400, { error: adapterFor(agent) ? `unknown kind for ${agent}` : 'unknown agent' });
        for (const event of events) emit(event);
        return json(200, { ok: true, emitted: events.length > 0, count: events.length });
      }
      let hook;
      try { hook = JSON.parse(body); } catch (_) { return json(400, { error: 'invalid json' }); }
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return json(400, { error: 'expected a JSON object' });
      // ?agent=codex|gemini|grok|cursor|opencode comes from `nudge-hook.sh <agent>`; Claude Code's hooks send none.
      const agent = url.searchParams.get('agent') || DEFAULT_AGENT;
      if (!adapterFor(agent)) { log(`ignored hook from unknown agent "${agent}"`); return json(400, { error: 'unknown agent' }); }
      // Grok Build and Cursor also run the hooks in ~/.claude/settings.json: drop those copies, so a Grok or Cursor turn
      // never shows up as "Claude is done". The agent's own hooks (?agent=grok, ?agent=cursor) report it.
      const host = hostAgent(hook);
      if (host && host !== agent) { log(`ignored ${agent} hook run by ${host}`); return json(200, { ok: true, emitted: false, duplicate: false, canDecide: false }); }
      // Remember the terminal before normalizing, so the event already names it.
      if (hook.session_id) focus.remember(sessionKey(agent, hook.session_id), focus.fromHook(hook, req.headers));
      const event = normalize(hook, agent);
      if (event) emit(event);
      else log(`ignored ${agent === DEFAULT_AGENT ? '' : agent + ' '}${hook.hook_event_name || '?'}${hook.notification_type ? '/' + hook.notification_type : ''}${hook.tool_name ? '/' + hook.tool_name : ''}`);
      // canDecide tells the approval hook whether anything can answer (a paired phone, or the bubble while an
      // extension with the secret is connected); otherwise it won't wait. A question also needs the question hook
      // installed: without it the bubble shows no choices (approvable is false), so waiting would only delay Claude.
      const isQuestion = agent === DEFAULT_AGENT && hook.hook_event_name === 'PreToolUse' && hook.tool_name === 'AskUserQuestion';
      const duplicate = !event && !!hook.tool_use_id && ctx.seenToolUse.has(`${agent}:${hook.tool_use_id}`);
      const canDecide = (!!cloud() || sockets.size > 0) && (!isQuestion || pairing.questionHookInstalled());
      return json(200, { ok: true, emitted: !!event, duplicate, canDecide });
    });
    return;
  }
  // Long poll used by hooks/nudge-approve.js. 200 with the decision, or 204 when `wait` ms pass without one.
  if (req.method === 'GET' && url.pathname === '/decision') {
    const sid = url.searchParams.get('session_id') || '', tid = url.searchParams.get('tool_use_id') || '';
    if (!sid || !tid) return json(400, { error: 'session_id and tool_use_id required' });
    const wait = Math.min(Number(url.searchParams.get('wait') || 0), 30000);
    const key = decisionKey({ agent: url.searchParams.get('agent'), session_id: sid, tool_use_id: tid });
    const poll = awaitDecision(key, sid, tid, wait);
    res.on('close', poll.cancel); // the hook was killed (answered in the terminal): see onHookGone()
    poll.promise.then((d) => {
      if (res.writableEnded || res.destroyed) return;
      if (d) return json(200, { decision: d });
      res.writeHead(204); res.end();
    });
    return;
  }
  // A decision made in the bubble (the extension, holding the secret). Mirrored to the cloud so phones dismiss it.
  if (req.method === 'POST' && url.pathname === '/decision') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let d;
      try { d = JSON.parse(body); } catch (_) { return json(400, { error: 'invalid json' }); }
      const hasAnswers = d && d.answers && typeof d.answers === 'object' && !Array.isArray(d.answers);
      if (!d || typeof d !== 'object' || !d.session_id || !d.tool_use_id || !(d.behavior === 'allow' || d.behavior === 'deny' || d.answer || hasAnswers)) return json(400, { error: 'session_id, tool_use_id and behavior|answer|answers required' });
      const agent = d.agent && d.agent !== DEFAULT_AGENT ? String(d.agent) : '';
      const key = decisionKey({ agent, session_id: d.session_id, tool_use_id: d.tool_use_id });
      if (decisions.has(key)) {
        const by = decisions.get(key).by;
        return json(409, { error: by === 'phone' ? 'Already answered on your phone' : 'Already answered', by, decided: decisionLabel(decisions.get(key)) });
      }
      const asked = requests.get(key);
      const bad = asked && incomplete(asked, d);
      if (bad) return json(400, { error: bad[0].toUpperCase() + bad.slice(1) });
      // Test and preview nudges have no hook behind them; everything else needs nudge-approve.js still waiting.
      // When it isn't, the bubble settles (by: 'terminal') instead of offering buttons that can no longer work.
      if (!isTestSession(d.session_id) && !hookWaiting(key)) {
        return json(409, { error: hookGone.has(key) ? 'Answered in the terminal' : 'Claude stopped waiting here. Answer in the terminal.', by: 'terminal' });
      }
      const decision = {
        eventId: Number(d.eventId) || 0, session_id: String(d.session_id), tool_use_id: String(d.tool_use_id), ...(agent ? { agent } : {}),
        ...(d.behavior ? { behavior: d.behavior } : {}), ...(d.answer ? { answer: String(d.answer) } : {}), ...(hasAnswers ? { answers: d.answers } : {}),
        by: 'browser', ts: Date.now(),
      };
      recordDecision(decision);
      const c = cloud();
      if (c && typeof fetch === 'function') {
        // cloud.json's browserToken (hosted relays hand it out with the pair code); derived from the laptop token for
        // cloud.json files written before that.
        const token = c.browserToken || c.laptopToken.replace(/^([a-z2-7]+)\.l/, '$1.b');
        fetch(`${c.relay}/decisions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(decision),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
      return json(200, { ok: true });
    });
    return;
  }
  // Jump back: bring the terminal running this session to the front. 404 when its terminal is unknown,
  // 501 when this platform (or Linux without wmctrl/xdotool) can't do it.
  if (req.method === 'POST' && url.pathname === '/focus') {
    readJson(req, 1e4, (d) => {
      if (!d || !d.session_id) return json(400, { error: 'session_id required' });
      focus.focus(sessionKey(d.agent && String(d.agent), String(d.session_id))).then((r) => {
        log(`focus ${d.session_id}: ${r.status}${r.body.app ? ` (${r.body.app})` : ''}${r.body.error ? ` ${r.body.error}` : ''}`);
        json(r.status, r.body);
      });
    }, () => json(400, { error: 'invalid json' }));
    return;
  }
  // The user dismissed a waiting nudge (Got it, Esc, the mascot): closes its wait in the stats.
  if (req.method === 'POST' && url.pathname === '/dismissed') {
    readJson(req, 1e4, (d) => {
      if (!d || !d.session_id) return json(400, { error: 'session_id required' });
      const row = stats.finish(sessionKey(d.agent && String(d.agent), String(d.session_id)), 'dismissed', { eventId: Number(d.id) || undefined });
      json(200, { ok: true, closed: !!row });
    }, () => json(400, { error: 'invalid json' }));
    return;
  }
  // Waiting stats for the popup's "This week" card. Read from the local file only.
  if (req.method === 'GET' && url.pathname === '/stats') {
    stats.summary(url.searchParams.get('range') || 'week')
      .then((s) => json(200, s), (e) => json(500, { error: e.message }));
    return;
  }
  // Phone pairing, driven from the extension popup. The relay owns cloud.json and the approval hooks.
  if (req.method === 'POST' && url.pathname === '/pair/start') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let relay;
      try { relay = body ? JSON.parse(body).relay : undefined; } catch (_) { /* default relay */ }
      pairing.start(relay)
        .then((r) => { log(`pairing started on ${r.relay} (user ${r.userId})`); json(200, r); })
        .catch((e) => json(502, { error: e.message }));
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/pair/stop') {
    const r = pairing.stop();
    log('pairing removed');
    return json(200, r);
  }
  if (req.method === 'GET' && url.pathname === '/pair/status') {
    pairing.status().then((s) => json(200, s));
    return;
  }
  json(404, { error: 'not found' });
});

// Reads a small JSON body; `bad` on invalid JSON.
function readJson(req, max, ok, bad) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > max) req.destroy(); });
  req.on('end', () => {
    let d;
    try { d = JSON.parse(body || '{}'); } catch (_) { return bad(); }
    ok(d);
  });
}

// The extension's socket: ws://127.0.0.1:PORT/ws?secret=… . Without the secret, an extension still gets a socket, but
// only a hello with `locked: true` (the popup then asks for the code) and never an event; anything else gets a 401.
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== '/ws' || !key || !isTrustedOrigin(req)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const authed = authorized(url.searchParams.get('secret') || req.headers[secret.HEADER]);
  if (!authed && !fromExtension(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket._buf = Buffer.alloc(0);
  socket.setNoDelay(true);
  (authed ? sockets : lockedSockets).add(socket);
  socket.on('data', (chunk) => {
    socket._buf = Buffer.concat([socket._buf, chunk]);
    handleFrames(socket);
  });
  socket.on('close', () => dropSocket(socket));
  socket.on('error', () => dropSocket(socket));
  if (!authed) {
    safeWrite(socket, encodeFrame(JSON.stringify({ type: 'hello', locked: true, recent: [] })));
    log('extension connected without the secret: locked until the code is pasted into its popup');
    return;
  }
  // `ended` and `decided` let a reconnecting extension drop nudges answered while it was away (in the terminal, the
  // bubble of another profile, or the phone), even when their events have left `recent`.
  safeWrite(socket, encodeFrame(JSON.stringify({
    type: 'hello',
    recent: recent.slice(-5),
    ended: [...ended].map(([k, v]) => ({ key: k, ...v })),
    decided: [...decisions.keys()],
  })));
  log(`extension connected (${sockets.size} client(s))`);
});

setInterval(() => {
  const frame = encodeFrame(JSON.stringify({ type: 'ping', ts: Date.now() }));
  for (const s of [...sockets, ...lockedSockets]) safeWrite(s, frame);
}, PING_INTERVAL_MS).unref();

function log(msg) {
  console.log(`[nudge ${new Date().toLocaleTimeString()}] ${msg}`);
}

server.listen(PORT, HOST, () => {
  log(`relay listening on http://${HOST}:${PORT}  (ws://${HOST}:${PORT}/ws)`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // If another nudge relay already owns the port, exit cleanly so a service manager doesn't restart-loop us.
    http.get({ host: HOST, port: PORT, path: '/health', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let ours = false;
        try { ours = JSON.parse(body).ok === true; } catch (_) {}
        if (ours) { log(`another relay is already running on port ${PORT}; exiting`); process.exit(0); }
        console.error(`[nudge] port ${PORT} is in use by something else. Set CLAUDE_NUDGE_PORT to change it.`);
        process.exit(1);
      });
    }).on('error', () => { console.error(`[nudge] port ${PORT} is in use. Set CLAUDE_NUDGE_PORT to change it.`); process.exit(1); });
    return;
  }
  throw err;
});
