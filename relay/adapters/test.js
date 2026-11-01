#!/usr/bin/env node
'use strict';
// Feeds sample hook payloads for each agent through its adapter and checks the events. No framework:
//   node relay/adapters/test.js   (or npm test)
const assert = require('assert');
const { adapters, adapterFor, hostAgent, createContext, sessionKey, incompleteDecision } = require('.');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`); }
}

const CWD = '/Users/dev/work/shop-api';
const SHAPE = ['id', 'ts', 'session_id', 'project', 'cwd', 'hook_event', 'agent', 'kind', 'title', 'message'];

// Runs payloads in order through one agent's adapter with a shared context (so pending/dedupe carry over).
// The question approval hook counts as installed unless a test says otherwise (runWith).
function runWith(opts, agent, ...hooks) {
  const ctx = createContext(opts);
  return hooks.map((h) => adapters[agent].normalize({ session_id: 's1', cwd: CWD, ...h }, ctx));
}
const run = (agent, ...hooks) => runWith({ questionHookInstalled: () => true }, agent, ...hooks);
function expectEvent(e, agent, kind, title) {
  assert.ok(e, `expected a ${kind} event, got ${e}`);
  for (const k of SHAPE) assert.ok(k in e, `event lacks "${k}"`);
  assert.strictEqual(e.agent, agent);
  assert.strictEqual(e.kind, kind);
  if (title) assert.strictEqual(e.title, title);
  assert.strictEqual(e.project, 'shop-api');
  assert.strictEqual(e.session_id, 's1');
}

// For events from a shared ctx, whose session_id varies per test.
function expectAgentKind(e, agent, kind) {
  assert.ok(e, `expected a ${agent} ${kind} event, got ${e}`);
  assert.strictEqual(e.agent, agent);
  assert.strictEqual(e.kind, kind);
}

console.log('registry');
test('no ?agent= means Claude Code', () => assert.strictEqual(adapterFor(undefined).name, 'claude-code'));
test('empty ?agent= means Claude Code', () => assert.strictEqual(adapterFor('').name, 'claude-code'));
test('codex, gemini, grok, cursor and opencode resolve', () => {
  for (const name of ['codex', 'gemini', 'grok', 'cursor', 'opencode']) assert.strictEqual(adapterFor(name).name, name);
});
test('unknown agent is null', () => assert.strictEqual(adapterFor('windsurf'), null));
test('every adapter has a name, a label, normalize and samples', () => {
  for (const [name, a] of Object.entries(adapters)) {
    assert.strictEqual(a.name, name);
    assert.ok(a.label && typeof a.normalize === 'function' && typeof a.samples === 'function', name);
  }
});
test('ids increase across events', () => {
  const [a, b] = run('claude-code', { hook_event_name: 'Stop' }, { hook_event_name: 'Stop' });
  assert.ok(b.id > a.id);
});
test('non-object payloads are ignored', () => {
  for (const name of Object.keys(adapters)) assert.strictEqual(adapters[name].normalize(null, createContext()), null);
});

console.log('claude-code');
test('Stop -> done "Claude is done" with the last message', () => {
  const [e] = run('claude-code', { hook_event_name: 'Stop', last_assistant_message: 'All tests pass.' });
  expectEvent(e, 'claude-code', 'done', 'Claude is done');
  assert.strictEqual(e.message, 'All tests pass.');
  assert.strictEqual(e.hook_event, 'Stop');
});
test('Stop without a message uses the fallback', () => {
  const [e] = run('claude-code', { hook_event_name: 'Stop' });
  assert.strictEqual(e.message, 'Finished working. Come take a look.');
});
test('Notification types map to permission / idle / question / done', () => {
  const [p, i, q, d, x] = run('claude-code',
    { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' },
    { hook_event_name: 'Notification', notification_type: 'idle_prompt' },
    { hook_event_name: 'Notification', notification_type: 'agent_needs_input' },
    { hook_event_name: 'Notification', notification_type: 'agent_completed' },
    { hook_event_name: 'Notification', notification_type: 'auth_success' });
  expectEvent(p, 'claude-code', 'permission', 'Claude needs permission');
  assert.strictEqual(p.message, 'Claude needs your permission to use Bash');
  expectEvent(i, 'claude-code', 'idle', 'Claude is waiting');
  assert.strictEqual(i.message, 'Claude is waiting for your input.');
  expectEvent(q, 'claude-code', 'question', 'Claude needs input');
  expectEvent(d, 'claude-code', 'done', 'Claude is done');
  assert.strictEqual(d.message, 'Finished working.');
  assert.strictEqual(x, null);
});
test('AskUserQuestion -> question with options; the same tool_use_id twice emits once', () => {
  const ask = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'tu1',
    tool_input: { questions: [{ header: 'DB', question: 'Which database?', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } };
  const [e, dup] = run('claude-code', ask, ask);
  expectEvent(e, 'claude-code', 'question', 'Claude has a question');
  assert.strictEqual(e.message, 'Which database?');
  assert.strictEqual(e.approvable, true);
  assert.deepStrictEqual(e.options, [{ header: 'DB', question: 'Which database?', multiSelect: false, choices: ['Postgres', 'SQLite'] }]);
  assert.strictEqual(dup, null);
});
test('AskUserQuestion is answerable only while the question approval hook is installed, and needs a tool_use_id', () => {
  const ask = (id) => ({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', ...(id ? { tool_use_id: id } : {}),
    tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } });
  assert.strictEqual(runWith({ questionHookInstalled: () => false }, 'claude-code', ask('tu2'))[0].approvable, false);
  assert.strictEqual(runWith({}, 'claude-code', ask('tu3'))[0].approvable, false);
  assert.strictEqual(run('claude-code', ask(''))[0].approvable, false);
});
test('several questions keep their headers and multiSelect', () => {
  const [e] = run('claude-code', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'tu4',
    tool_input: { questions: [{ header: 'DB', question: 'Which database?', options: [{ label: 'Postgres' }] }, { header: 'Extras', question: 'Which extras?', multiSelect: true, options: [{ label: 'Seed' }, { label: 'Backups' }] }] } });
  assert.strictEqual(e.message, 'Which database?\n\nWhich extras?');
  assert.deepStrictEqual(e.options.map((o) => [o.header, o.multiSelect, o.choices.length]), [['DB', false, 1], ['Extras', true, 2]]);
});
test('PreToolUse for other tools is ignored', () => {
  assert.strictEqual(run('claude-code', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })[0], null);
});
test('PermissionRequest -> approvable permission; the terminal permission_prompt after it is deduped', () => {
  const [e, n] = run('claude-code',
    { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'pr-1', tool_input: { command: 'npm publish' } },
    { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  expectEvent(e, 'claude-code', 'permission', 'Claude needs permission');
  assert.strictEqual(e.message, 'Bash: npm publish');
  assert.strictEqual(e.approvable, true);
  assert.strictEqual(e.tool_use_id, 'pr-1');
  assert.strictEqual(n, null);
});
test('PostToolUse resolves only while something is pending; UserPromptSubmit always resolves', () => {
  const [none, , res, prompt] = run('claude-code',
    { hook_event_name: 'PostToolUse', tool_name: 'Bash' },
    { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash' },
    { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  assert.strictEqual(none, null);
  expectEvent(res, 'claude-code', 'resolved', 'Resolved');
  expectEvent(prompt, 'claude-code', 'resolved', 'Resolved');
});
test('the terminal permission_prompt is skipped within 10 s of the request even after a fast answer cleared pending', () => {
  const [e, done, n] = run('claude-code',
    { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'pr-2', tool_input: { command: 'ls' } },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash' },
    { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  expectEvent(e, 'claude-code', 'permission');
  expectEvent(done, 'claude-code', 'resolved');
  assert.strictEqual(n, null);
});
test('the terminal permission_prompt is skipped within 10 s of a bubble/phone decision', () => {
  const ctx = createContext();
  ctx.lastPermission.set(sessionKey('claude-code', 's1'), Date.now() - 60000);
  ctx.lastDecided.set(sessionKey('claude-code', 's1'), Date.now());
  const n = adapters['claude-code'].normalize({ session_id: 's1', cwd: CWD, hook_event_name: 'Notification', notification_type: 'permission_prompt' }, ctx);
  assert.strictEqual(n, null);
  const other = adapters['claude-code'].normalize({ session_id: 's2', cwd: CWD, hook_event_name: 'Notification', notification_type: 'permission_prompt' }, ctx);
  assert.strictEqual(other.kind, 'permission');
});
test('long messages are clipped to 1200 characters', () => {
  const [e] = run('claude-code', { hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(5000) });
  assert.strictEqual(e.message.length, 1200);
  assert.ok(e.message.endsWith('…'));
});

console.log('codex');
test('PermissionRequest (Bash) -> "Codex needs permission", not approvable', () => {
  const [e] = run('codex', { hook_event_name: 'PermissionRequest', turn_id: 't1', model: 'gpt-5-codex', permission_mode: 'default',
    tool_name: 'Bash', tool_input: { command: 'npm install left-pad', description: 'Needs network access' } });
  expectEvent(e, 'codex', 'permission', 'Codex needs permission');
  assert.strictEqual(e.message, 'Bash: npm install left-pad\nNeeds network access');
  assert.strictEqual(e.approvable, false);
  assert.strictEqual(e.tool_name, 'Bash');
});
test('PermissionRequest (apply_patch) names the files in the patch', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** Add File: src/b.js\n+z\n*** End Patch';
  const [e] = run('codex', { hook_event_name: 'PermissionRequest', tool_name: 'apply_patch', tool_input: { command: patch } });
  assert.strictEqual(e.message, 'apply_patch: src/a.js, src/b.js');
});
test('PostToolUse resolves the pending permission, and only then', () => {
  const [none, , res] = run('codex',
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command: 'ls' }, tool_response: {} },
    { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'c2', tool_input: { command: 'rm -rf dist' }, tool_response: {} });
  assert.strictEqual(none, null);
  expectEvent(res, 'codex', 'resolved', 'Resolved');
});
test('Stop -> "Codex is done"; a null last_assistant_message uses the fallback', () => {
  const [e, f] = run('codex',
    { hook_event_name: 'Stop', turn_id: 't1', stop_hook_active: false, last_assistant_message: 'Refactor done.' },
    { hook_event_name: 'Stop', turn_id: 't2', stop_hook_active: false, last_assistant_message: null });
  expectEvent(e, 'codex', 'done', 'Codex is done');
  assert.strictEqual(e.message, 'Refactor done.');
  assert.strictEqual(f.message, 'Finished working. Come take a look.');
});
test('UserPromptSubmit -> resolved', () => {
  expectEvent(run('codex', { hook_event_name: 'UserPromptSubmit', prompt: 'next' })[0], 'codex', 'resolved', 'Resolved');
});
test('PreToolUse request_user_input -> "Codex has a question" (unverified payload)', () => {
  const [e] = run('codex', { hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_use_id: 'q1',
    tool_input: { questions: [{ header: 'Scope', question: 'Touch the tests too?', options: [{ label: 'Yes' }, { label: 'No' }] }] } });
  expectEvent(e, 'codex', 'question', 'Codex has a question');
  assert.deepStrictEqual(e.options[0].choices, ['Yes', 'No']);
  assert.strictEqual(e.approvable, false);
});
test('other events are ignored', () => {
  const out = run('codex',
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    { hook_event_name: 'SessionStart', source: 'startup' },
    { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  assert.deepStrictEqual(out, [null, null, null]);
});

console.log('gemini');
test('Notification ToolPermission (exec) -> "Gemini needs permission" with the command', () => {
  const [e] = run('gemini', { hook_event_name: 'Notification', timestamp: '2026-10-31T10:00:00Z', notification_type: 'ToolPermission',
    message: 'Tool Confirm Shell Command requires execution', details: { type: 'exec', title: 'Confirm Shell Command', command: 'npm test', rootCommand: 'npm' } });
  expectEvent(e, 'gemini', 'permission', 'Gemini needs permission');
  assert.strictEqual(e.message, 'Shell: npm test');
  assert.strictEqual(e.approvable, false);
});
test('ToolPermission edit / mcp / info / unknown details', () => {
  const n = (details, message) => ({ hook_event_name: 'Notification', notification_type: 'ToolPermission', message, details });
  const [edit, mcp, info, bare] = run('gemini',
    n({ type: 'edit', title: 'Confirm Edit', fileName: 'app.ts', filePath: '/w/app.ts' }),
    n({ type: 'mcp', title: 'Confirm MCP', serverName: 'github', toolName: 'create_issue', toolDisplayName: 'Create issue' }),
    n({ type: 'info', title: 'Confirm Web Fetch', prompt: 'summarize', urls: ['https://example.com'] }),
    n(undefined, 'Tool requires confirmation'));
  assert.strictEqual(edit.message, 'Edit: /w/app.ts');
  assert.strictEqual(mcp.message, 'github: Create issue');
  assert.strictEqual(mcp.tool_name, 'create_issue');
  assert.strictEqual(info.message, 'Fetch: https://example.com');
  assert.strictEqual(bare.message, 'Tool requires confirmation');
});
test('AfterTool resolves the pending permission, and only then', () => {
  const [none, , res] = run('gemini',
    { hook_event_name: 'AfterTool', tool_name: 'read_file', tool_input: {}, tool_response: {} },
    { hook_event_name: 'Notification', notification_type: 'ToolPermission', details: { type: 'exec', command: 'make' } },
    { hook_event_name: 'AfterTool', tool_name: 'run_shell_command', tool_input: { command: 'make' }, tool_response: {} });
  assert.strictEqual(none, null);
  expectEvent(res, 'gemini', 'resolved', 'Resolved');
});
test('AfterAgent -> "Gemini is done" with prompt_response; BeforeAgent -> resolved', () => {
  const [d, r] = run('gemini',
    { hook_event_name: 'AfterAgent', prompt: 'fix it', prompt_response: 'Fixed the flaky test.', stop_hook_active: false },
    { hook_event_name: 'BeforeAgent', prompt: 'thanks' });
  expectEvent(d, 'gemini', 'done', 'Gemini is done');
  assert.strictEqual(d.message, 'Fixed the flaky test.');
  expectEvent(r, 'gemini', 'resolved', 'Resolved');
});
test('other events are ignored', () => {
  const out = run('gemini',
    { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'ls' } },
    { hook_event_name: 'SessionStart', source: 'startup' },
    { hook_event_name: 'Stop' });
  assert.deepStrictEqual(out, [null, null, null]);
});

console.log('grok');
// Grok sends both spellings of the common fields; the event-specific ones are camelCase (see grok.js).
const grok = (event, extra) => ({ hook_event_name: event, hookEventName: event.toLowerCase(), sessionId: 's1', workspaceRoot: CWD, timestamp: '2026-10-31T10:00:00Z', ...extra });
test('Notification permission_prompt -> "Grok needs permission", not approvable', () => {
  const [e] = run('grok', grok('Notification', { notificationType: 'permission_prompt', title: 'Permission required', message: 'Run: npm publish' }));
  expectEvent(e, 'grok', 'permission', 'Grok needs permission');
  assert.strictEqual(e.message, 'Run: npm publish');
  assert.strictEqual(e.approvable, false);
});
test('session and project come from sessionId / workspaceRoot when the snake_case copies are missing', () => {
  const ctx = createContext();
  const e = adapters.grok.normalize(grok('Notification', { notificationType: 'permission_prompt', message: 'x' }), ctx);
  assert.strictEqual(e.session_id, 's1');
  assert.strictEqual(e.cwd, CWD);
  assert.strictEqual(e.project, 'shop-api');
});
test('Stop end_turn -> "Grok is done" with lastAssistantMessage; session-closing Stops are ignored', () => {
  const [d, f, closed] = run('grok',
    grok('Stop', { reason: 'end_turn', stopHookActive: false, lastAssistantMessage: 'Shipped it.' }),
    grok('Stop', { reason: 'end_turn' }),
    grok('Stop', { reason: 'channel_closed', lastAssistantMessage: 'bye' }));
  expectEvent(d, 'grok', 'done', 'Grok is done');
  assert.strictEqual(d.message, 'Shipped it.');
  assert.strictEqual(f.message, 'Finished working. Come take a look.');
  assert.strictEqual(closed, null);
});
test('StopFailure -> done "Grok stopped" with the error', () => {
  const [e] = run('grok', grok('StopFailure', { error: 'rate limited' }));
  expectEvent(e, 'grok', 'done', 'Grok stopped');
  assert.strictEqual(e.message, 'rate limited');
});
test('UserPromptSubmit and StopCancelled resolve; PostToolUse only while something is pending', () => {
  const [none, , res, prompt, cancelled] = run('grok',
    grok('PostToolUse', { tool_name: 'run_terminal_command', tool_use_id: 't0' }),
    grok('Notification', { notificationType: 'permission_prompt', message: 'x' }),
    grok('PostToolUse', { tool_name: 'run_terminal_command', tool_use_id: 't1' }),
    grok('UserPromptSubmit', { prompt: 'go' }),
    grok('StopCancelled', { reason: 'permission_rejected' }));
  assert.strictEqual(none, null);
  expectEvent(res, 'grok', 'resolved', 'Resolved');
  expectEvent(prompt, 'grok', 'resolved');
  expectEvent(cancelled, 'grok', 'resolved');
});
test('PreToolUse ask_user_question -> question with choices; the elicitation_dialog after it is not a second nudge', () => {
  const [q, n] = run('grok',
    grok('PreToolUse', { tool_name: 'ask_user_question', tool_use_id: 'g1', tool_input: { questions: [{ header: 'DB', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } }),
    grok('Notification', { notificationType: 'elicitation_dialog', message: 'User question requested' }));
  expectEvent(q, 'grok', 'question', 'Grok has a question');
  assert.deepStrictEqual(q.options, [{ header: 'DB', question: 'Which database?', multiSelect: false, choices: ['Postgres', 'SQLite'] }]);
  assert.strictEqual(q.approvable, false);
  assert.strictEqual(n, null);
});
test('elicitation_dialog alone -> question; idle_prompt -> idle; other notifications are ignored', () => {
  const [q, i, t] = run('grok',
    grok('Notification', { notificationType: 'elicitation_dialog', message: 'User question requested' }),
    grok('Notification', { notificationType: 'idle_prompt', message: 'Waiting for input' }),
    grok('Notification', { notificationType: 'task_complete', message: 'Background task finished' }));
  expectEvent(q, 'grok', 'question', 'Grok has a question');
  assert.strictEqual(q.message, 'User question requested');
  expectEvent(i, 'grok', 'idle', 'Grok is waiting');
  assert.strictEqual(t, null);
});
test('subagent events and other tools are ignored', () => {
  const out = run('grok',
    grok('Stop', { reason: 'end_turn', subagentType: 'explore', lastAssistantMessage: 'sub' }),
    grok('PreToolUse', { tool_name: 'run_terminal_command', tool_input: { command: 'ls' } }),
    grok('SessionStart', {}));
  assert.deepStrictEqual(out, [null, null, null]);
});

console.log('cursor');
const cursor = (event, extra) => ({ conversation_id: 's1', generation_id: 'g1', hook_event_name: event, model: 'auto', cursor_version: '2.6.0', workspace_roots: [CWD], user_email: null, transcript_path: null, ...extra });
const runCursor = (...hooks) => { const ctx = createContext(); return hooks.map((h) => adapters.cursor.normalize(h, ctx)); };
test('stop completed -> "Cursor is done" with the text of the afterAgentResponse before it', () => {
  const [r, d] = runCursor(cursor('afterAgentResponse', { text: 'Renamed the module and fixed imports.' }), cursor('stop', { status: 'completed', loop_count: 0 }));
  assert.strictEqual(r, null);
  expectEvent(d, 'cursor', 'done', 'Cursor is done');
  assert.strictEqual(d.message, 'Renamed the module and fixed imports.');
  assert.strictEqual(d.cwd, CWD);
});
test('session_id falls back to conversation_id; an explicit session_id wins', () => {
  const [a, b] = runCursor(cursor('stop', { status: 'completed' }), cursor('stop', { status: 'completed', session_id: 'sess-9' }));
  assert.strictEqual(a.session_id, 's1');
  assert.strictEqual(b.session_id, 'sess-9');
});
test('stop without a response uses the fallback; the text does not leak into the next turn', () => {
  const [, d1, d2] = runCursor(cursor('afterAgentResponse', { text: 'first' }), cursor('stop', { status: 'completed' }), cursor('stop', { status: 'completed' }));
  assert.strictEqual(d1.message, 'first');
  assert.strictEqual(d2.message, 'Finished working. Come take a look.');
});
test('stop aborted -> resolved; stop error -> done "Cursor stopped"', () => {
  const [a, e] = runCursor(cursor('stop', { status: 'aborted' }), cursor('stop', { status: 'error' }));
  expectEvent(a, 'cursor', 'resolved', 'Resolved');
  expectEvent(e, 'cursor', 'done', 'Cursor stopped');
});
test('beforeSubmitPrompt -> resolved', () => {
  expectEvent(runCursor(cursor('beforeSubmitPrompt', { prompt: 'next', attachments: [] }))[0], 'cursor', 'resolved', 'Resolved');
});
test('other events are ignored', () => {
  const out = runCursor(
    cursor('beforeShellExecution', { command: 'npm test', cwd: CWD, tool_use_id: 'x' }),
    cursor('preToolUse', { tool_name: 'Shell', tool_input: { command: 'ls' }, tool_use_id: 'y', cwd: CWD }),
    cursor('subagentStop', { status: 'completed' }),
    cursor('Stop', {}));
  assert.deepStrictEqual(out, [null, null, null, null]);
});

console.log('opencode');
// What hooks/nudge-opencode.js pipes into nudge-hook.sh: the bus event's type and data, plus session, cwd and text.
const oc = (type, data, extra) => ({ hook_event_name: type, session_id: 's1', cwd: CWD, data: { sessionID: 's1', ...data }, ...extra });
test('permission.asked -> "OpenCode needs permission" with the action and resources', () => {
  const [e, m] = run('opencode',
    oc('permission.asked', { id: 'per_1', action: 'bash', resources: ['git push', 'git push --tags'] }),
    oc('permission.asked', { id: 'per_2', action: 'edit', resources: ['src/a.ts'], message: 'Edit src/a.ts?' }));
  expectEvent(e, 'opencode', 'permission', 'OpenCode needs permission');
  assert.strictEqual(e.message, 'bash: git push, git push --tags');
  assert.strictEqual(e.tool_name, 'bash');
  assert.strictEqual(e.approvable, false);
  assert.strictEqual(m.message, 'Edit src/a.ts?');
});
test('permission.replied resolves', () => {
  const [, r] = run('opencode', oc('permission.asked', { id: 'per_1', action: 'bash', resources: [] }), oc('permission.replied', { requestID: 'per_1', reply: 'once' }));
  expectEvent(r, 'opencode', 'resolved', 'Resolved');
});
test('form.created for the question tool -> question; other forms are ignored; form.replied resolves', () => {
  const form = (kind) => ({ form: { id: 'frm_1', sessionID: 's1', title: 'Questions', metadata: { kind }, fields: [{ key: 'q0', label: 'Touch the tests too?' }] } });
  const [q, other, r] = run('opencode', oc('form.created', form('question')), oc('form.created', form('mcp')), oc('form.replied', { id: 'frm_1', answer: { q0: 'Yes' } }));
  expectEvent(q, 'opencode', 'question', 'OpenCode has a question');
  assert.strictEqual(q.message, 'Touch the tests too?');
  assert.strictEqual(other, null);
  expectEvent(r, 'opencode', 'resolved');
});
test('the session id can come from data.form.sessionID alone', () => {
  const ctx = createContext();
  const e = adapters.opencode.normalize({ hook_event_name: 'form.created', cwd: CWD, data: { form: { sessionID: 's1', metadata: { kind: 'question' }, fields: [] } } }, ctx);
  assert.strictEqual(e.session_id, 's1');
  assert.strictEqual(e.message, 'OpenCode is waiting for your answer.');
});
test('session.execution.succeeded -> "OpenCode is done"; failed -> "OpenCode stopped"', () => {
  const [d, f, e] = run('opencode',
    oc('session.execution.succeeded', {}, { last_assistant_message: 'Migrated the config.' }),
    oc('session.execution.succeeded', {}),
    oc('session.execution.failed', { error: { message: 'provider error' } }));
  expectEvent(d, 'opencode', 'done', 'OpenCode is done');
  assert.strictEqual(d.message, 'Migrated the config.');
  assert.strictEqual(f.message, 'Finished working. Come take a look.');
  expectEvent(e, 'opencode', 'done', 'OpenCode stopped');
  assert.strictEqual(e.message, 'provider error');
});
test('a user prompt or a user interrupt resolves; other inbox items and interrupts do not', () => {
  const out = run('opencode',
    oc('session.inbox.enqueued', { inboxID: 'i1', item: { type: 'user' } }),
    oc('session.inbox.enqueued', { inboxID: 'i2', item: { type: 'synthetic' } }),
    oc('session.execution.interrupted', { reason: 'user' }),
    oc('session.execution.interrupted', { reason: 'shutdown' }),
    oc('session.text.ended', { text: 'hi' }));
  expectEvent(out[0], 'opencode', 'resolved');
  assert.strictEqual(out[1], null);
  expectEvent(out[2], 'opencode', 'resolved');
  assert.deepStrictEqual(out.slice(3), [null, null]);
});

console.log('hooks that another agent ran (Grok and Cursor also run ~/.claude/settings.json)');
test('hostAgent names Grok and Cursor payloads and nothing else', () => {
  assert.strictEqual(hostAgent(grok('Stop', { reason: 'end_turn' })), 'grok');
  assert.strictEqual(hostAgent({ hook_event_name: 'Stop', session_id: 's', workspaceRoot: CWD }), 'grok');
  assert.strictEqual(hostAgent(cursor('stop', { status: 'completed' })), 'cursor');
  assert.strictEqual(hostAgent({ hook_event_name: 'Stop', session_id: 's', cwd: CWD, last_assistant_message: 'x' }), null); // Claude Code
  assert.strictEqual(hostAgent({ hook_event_name: 'PermissionRequest', turn_id: 't', tool_name: 'Bash' }), null); // Codex
  assert.strictEqual(hostAgent({ hook_event_name: 'AfterAgent', timestamp: 'x' }), null); // Gemini CLI
  assert.strictEqual(hostAgent(oc('session.execution.succeeded', {})), null); // OpenCode plugin
  assert.strictEqual(hostAgent(null), null);
});
test("every sample's host is its own agent (or none), so the relay never drops a test nudge", () => {
  for (const [name, a] of Object.entries(adapters)) {
    for (const [kind, payload] of Object.entries(a.samples({ cwd: CWD, session_id: 'test' }))) {
      const host = hostAgent(payload);
      assert.ok(host === null || host === name, `${name} ${kind} sample looks like ${host}`);
    }
  }
});

console.log('test samples (/test?agent=...)');
for (const [name, adapter] of Object.entries(adapters)) {
  test(`${name}: every sample normalizes to its kind`, () => {
    const ctx = createContext({ questionHookInstalled: () => true });
    const samples = adapter.samples({ cwd: CWD, session_id: 'test' });
    for (const [kind, payload] of Object.entries(samples)) {
      const e = adapter.normalize(payload, ctx);
      assert.ok(e, `${kind} sample was ignored`);
      assert.strictEqual(e.kind, { approve: 'permission', questions: 'question' }[kind] || kind, `${kind} sample`);
      assert.strictEqual(e.agent, name);
    }
  });
}

console.log('one event shape for every agent');
test('every event from every sample has exactly the shared fields, and only known optional ones', () => {
  const OPTIONAL = ['options', 'tool_name', 'tool_use_id', 'approvable'];
  const KINDS = ['question', 'permission', 'done', 'idle', 'resolved'];
  for (const [name, a] of Object.entries(adapters)) {
    const ctx = createContext({ questionHookInstalled: () => true });
    for (const [kind, payload] of Object.entries(a.samples({ cwd: CWD, session_id: 'test' }))) {
      const e = a.normalize(payload, ctx);
      for (const k of SHAPE) assert.ok(k in e, `${name} ${kind}: lacks "${k}"`);
      for (const k of Object.keys(e)) assert.ok(SHAPE.includes(k) || OPTIONAL.includes(k), `${name} ${kind}: unexpected field "${k}"`);
      assert.ok(KINDS.includes(e.kind), `${name} ${kind}: kind ${e.kind}`);
      assert.strictEqual(typeof e.id, 'number');
      assert.strictEqual(typeof e.message, 'string');
      assert.strictEqual(e.session_id, 'test', `${name} ${kind}: session_id`);
      assert.strictEqual(e.project, 'shop-api', `${name} ${kind}: project`);
      if (e.options) for (const o of e.options) assert.deepStrictEqual(Object.keys(o), ['header', 'question', 'multiSelect', 'choices']);
    }
  }
});

console.log('shared context across agents (the relay keeps one ctx for all of them)');
test('a Claude PostToolUse does not resolve a Codex request with the same session_id', () => {
  const ctx = createContext({ questionHookInstalled: () => true });
  const p = adapters.codex.normalize({ session_id: 'X', cwd: CWD, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, ctx);
  expectAgentKind(p, 'codex', 'permission');
  assert.strictEqual(adapters['claude-code'].normalize({ session_id: 'X', cwd: CWD, hook_event_name: 'PostToolUse', tool_name: 'Bash' }, ctx), null);
  assert.strictEqual(ctx.pending.get(sessionKey('codex', 'X')), 'permission');
  // Codex's own PostToolUse still resolves it.
  expectAgentKind(adapters.codex.normalize({ session_id: 'X', cwd: CWD, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'c9' }, ctx), 'codex', 'resolved');
});
test('a Gemini AfterTool does not resolve a Claude permission with the same session_id', () => {
  const ctx = createContext();
  adapters['claude-code'].normalize({ session_id: 'Y', cwd: CWD, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'pr-y', tool_input: { command: 'ls' } }, ctx);
  assert.strictEqual(adapters.gemini.normalize({ session_id: 'Y', cwd: CWD, hook_event_name: 'AfterTool', tool_name: 'x' }, ctx), null);
  assert.strictEqual(ctx.pending.get(sessionKey('claude-code', 'Y')), 'permission');
});
test("one agent's PermissionRequest does not dedupe another agent's permission_prompt", () => {
  const ctx = createContext();
  adapters.codex.normalize({ session_id: 'Z', cwd: CWD, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, ctx);
  const n = adapters['claude-code'].normalize({ session_id: 'Z', cwd: CWD, hook_event_name: 'Notification', notification_type: 'permission_prompt' }, ctx);
  expectAgentKind(n, 'claude-code', 'permission');
});
test('a Grok PostToolUse does not resolve a Cursor or OpenCode nudge with the same session_id', () => {
  const ctx = createContext();
  ctx.pending.set(sessionKey('cursor', 'V'), 'permission');
  expectAgentKind(adapters.opencode.normalize({ hook_event_name: 'permission.asked', session_id: 'V', cwd: CWD, data: { action: 'bash', resources: [] } }, ctx), 'opencode', 'permission');
  assert.strictEqual(adapters.grok.normalize({ hook_event_name: 'PostToolUse', hookEventName: 'post_tool_use', session_id: 'V', cwd: CWD, tool_name: 'x' }, ctx), null);
  assert.strictEqual(ctx.pending.get(sessionKey('opencode', 'V')), 'permission');
  assert.strictEqual(ctx.pending.get(sessionKey('cursor', 'V')), 'permission');
});
test('the same tool_use_id from two agents is not a duplicate', () => {
  const ctx = createContext({ questionHookInstalled: () => true });
  const q = (tool) => ({ session_id: 'W', cwd: CWD, hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: 'same', tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] } });
  expectAgentKind(adapters['claude-code'].normalize(q('AskUserQuestion'), ctx), 'claude-code', 'question');
  expectAgentKind(adapters.codex.normalize(q('request_user_input'), ctx), 'codex', 'question');
  assert.strictEqual(adapters['claude-code'].normalize(q('AskUserQuestion'), ctx), null); // its own repeat still is
});
test('test samples of every agent through one ctx keep their kinds', () => {
  const ctx = createContext({ questionHookInstalled: () => true });
  for (const [name, adapter] of Object.entries(adapters)) {
    for (const [kind, payload] of Object.entries(adapter.samples({ cwd: CWD, session_id: 'test' }))) {
      const e = adapter.normalize(payload, ctx);
      assert.ok(e, `${name} ${kind} sample was ignored`);
      assert.strictEqual(e.agent, name);
    }
  }
});

console.log('decision completeness (POST /decision and phone decisions)');
const qEvent = (options) => ({ kind: 'question', options });
const single = qEvent([{ header: 'DB', question: 'Which database?', multiSelect: false, choices: ['Postgres', 'SQLite'] }]);
const several = qEvent([
  { header: 'DB', question: 'Which database?', multiSelect: false, choices: ['Postgres', 'SQLite'] },
  { header: 'Extras', question: 'Which extras?', multiSelect: true, choices: ['Seed', 'Backups'] },
]);
test('a permission needs allow or deny', () => {
  assert.strictEqual(incompleteDecision({ kind: 'permission' }, { behavior: 'allow' }), null);
  assert.strictEqual(incompleteDecision({ kind: 'permission' }, { behavior: 'deny' }), null);
  assert.ok(incompleteDecision({ kind: 'permission' }, { answer: 'Yes' }));
});
test('one question: by text, by header, or a bare answer', () => {
  assert.strictEqual(incompleteDecision(single, { answers: { 'Which database?': 'Postgres' } }), null);
  assert.strictEqual(incompleteDecision(single, { answers: { DB: 'SQLite' } }), null);
  assert.strictEqual(incompleteDecision(single, { answer: 'Postgres' }), null);
  assert.ok(incompleteDecision(single, { answers: {} }));
  assert.ok(incompleteDecision(single, { answers: { 'Which database?': '' } }));
  assert.ok(incompleteDecision(single, { behavior: 'allow' }));
});
test('several questions: every one answered, multi-select as a non-empty array', () => {
  assert.strictEqual(incompleteDecision(several, { answers: { 'Which database?': 'Postgres', 'Which extras?': ['Seed'] } }), null);
  assert.strictEqual(incompleteDecision(several, { answers: { DB: 'Postgres', Extras: ['Seed', 'Backups'] } }), null);
  assert.match(incompleteDecision(several, { answers: { 'Which database?': 'Postgres' } }), /missing: Extras/);
  assert.match(incompleteDecision(several, { answers: { 'Which database?': 'Postgres', 'Which extras?': [] } }), /missing: Extras/);
  assert.ok(incompleteDecision(several, { answer: 'Postgres' }), 'a bare answer only counts for a single question');
  assert.ok(incompleteDecision(several, { answers: ['Postgres', 'Seed'] }), 'answers must be an object');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
