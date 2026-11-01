#!/usr/bin/env node
'use strict';
// Installs, re-installs, checks and removes each agent's hooks (bin/nudge.js) under a throwaway HOME, and runs the
// OpenCode plugin against a fake event bus with a stand-in nudge-hook.sh. Never touches the real HOME, the relay
// service or Claude Code's approval hooks. Part of `npm test`.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-install-test-'));
process.env.HOME = HOME; // before bin/nudge.js computes its paths
delete process.env.XDG_CONFIG_HOME;
const nudge = require('../bin/nudge.js');
const { adapters, createContext } = require('../relay/adapters');
const { AGENTS, installHooks, removeHooks, hookStatus } = nudge;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`); }
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };

(async () => {
  console.log('installer (temporary HOME)');
  await test('the new agents install under the temporary HOME', () => {
    assert.strictEqual(AGENTS.grok.file, path.join(HOME, '.grok', 'hooks', 'nudge.json'));
    assert.strictEqual(AGENTS.cursor.file, path.join(HOME, '.cursor', 'hooks.json'));
    assert.strictEqual(AGENTS.opencode.file, path.join(HOME, '.config', 'opencode', 'plugins', 'nudge.js'));
  });

  await test('cursor: flat version-1 entries next to the user\'s own, idempotent, backed up, removed cleanly', () => {
    const f = AGENTS.cursor.file;
    write(f, { version: 1, hooks: { stop: [{ command: './mine.sh' }], beforeShellExecution: [{ command: './audit.sh', matcher: 'rm' }] } });
    assert.deepStrictEqual(installHooks('cursor'), { added: 3 });
    const s = readJson(f);
    assert.strictEqual(s.version, 1);
    assert.deepStrictEqual(s.hooks.stop, [{ command: './mine.sh' }, { command: AGENTS.cursor.command, timeout: 10 }]);
    assert.deepStrictEqual(s.hooks.afterAgentResponse, [{ command: AGENTS.cursor.command, timeout: 10 }]);
    assert.deepStrictEqual(s.hooks.beforeSubmitPrompt, [{ command: AGENTS.cursor.command, timeout: 10 }]);
    assert.ok(fs.existsSync(f + '.bak-claude-nudge'));
    assert.deepStrictEqual(installHooks('cursor'), { added: 0 });
    assert.strictEqual(readJson(f).hooks.stop.length, 2);
    assert.deepStrictEqual(hookStatus('cursor'), { present: ['stop', 'afterAgentResponse', 'beforeSubmitPrompt'], missing: [] });
    assert.deepStrictEqual(removeHooks('cursor'), { removed: 3 });
    assert.deepStrictEqual(readJson(f), { version: 1, hooks: { stop: [{ command: './mine.sh' }], beforeShellExecution: [{ command: './audit.sh', matcher: 'rm' }] } });
  });

  await test('cursor: a stale entry from an older install path is replaced, not duplicated', () => {
    const f = AGENTS.cursor.file;
    write(f, { version: 1, hooks: { stop: [{ command: '/old/place/nudge-hook.sh cursor' }] } });
    installHooks('cursor');
    assert.deepStrictEqual(readJson(f).hooks.stop, [{ command: AGENTS.cursor.command, timeout: 10 }]);
    removeHooks('cursor');
  });

  await test('grok: its own hooks file with Claude-style groups and matchers; uninstall deletes the file', () => {
    const f = AGENTS.grok.file;
    assert.ok(!fs.existsSync(f));
    assert.deepStrictEqual(installHooks('grok'), { added: 7 });
    const s = readJson(f);
    assert.deepStrictEqual(Object.keys(s), ['hooks']);
    assert.deepStrictEqual(s.hooks.Notification, [{ matcher: 'permission_prompt|elicitation_dialog|idle_prompt', hooks: [{ type: 'command', command: AGENTS.grok.command, timeout: 10 }] }]);
    assert.deepStrictEqual(s.hooks.PreToolUse[0].matcher, 'ask_user_question');
    assert.deepStrictEqual(s.hooks.Stop, [{ hooks: [{ type: 'command', command: AGENTS.grok.command, timeout: 10 }] }]);
    assert.ok(!fs.existsSync(f + '.bak-claude-nudge'), 'nothing to back up for a new file');
    assert.deepStrictEqual(installHooks('grok'), { added: 0 });
    assert.strictEqual(hookStatus('grok').missing.length, 0);
    assert.deepStrictEqual(removeHooks('grok'), { removed: 7 });
    assert.ok(!fs.existsSync(f));
    assert.deepStrictEqual(removeHooks('grok'), { removed: 0 });
  });

  await test('opencode: the plugin is written with the hook path filled in, kept when unchanged, deleted on uninstall', () => {
    const f = AGENTS.opencode.file;
    assert.deepStrictEqual(hookStatus('opencode').present, []);
    assert.deepStrictEqual(installHooks('opencode'), { added: 1 });
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(src.includes(`const HOOK = ${JSON.stringify(nudge.HOOK)};`), 'hook path substituted');
    assert.ok(!src.includes('nudge:hook'));
    assert.deepStrictEqual(installHooks('opencode'), { added: 0 });
    assert.deepStrictEqual(hookStatus('opencode').missing, []);
    assert.deepStrictEqual(removeHooks('opencode'), { removed: 1 });
    assert.ok(!fs.existsSync(f));
  });

  await test('codex and gemini still install the way they did', () => {
    assert.strictEqual(installHooks('codex').added, 5);
    assert.deepStrictEqual(readJson(AGENTS.codex.file).hooks.PreToolUse, [{ matcher: 'request_user_input', hooks: [{ type: 'command', command: AGENTS.codex.command, timeout: 10 }] }]);
    assert.strictEqual(installHooks('gemini').added, 4);
    assert.strictEqual(removeHooks('codex').removed, 5);
    assert.strictEqual(removeHooks('gemini').removed, 4);
  });

  await test('detection: ~/.cursor, ~/.config/opencode or ~/.grok/config.toml (not a bare ~/.grok)', () => {
    const saved = process.env.PATH;
    process.env.PATH = ''; // no binaries
    try {
      fs.rmSync(path.join(HOME, '.cursor'), { recursive: true, force: true });
      fs.rmSync(path.join(HOME, '.config'), { recursive: true, force: true });
      fs.rmSync(path.join(HOME, '.grok'), { recursive: true, force: true });
      fs.mkdirSync(path.join(HOME, '.grok'));
      assert.deepStrictEqual(['grok', 'cursor', 'opencode'].map(nudge.detected), [false, false, false]);
      write(path.join(HOME, '.grok', 'config.toml'), '');
      fs.mkdirSync(path.join(HOME, '.cursor'));
      fs.mkdirSync(path.join(HOME, '.config', 'opencode'), { recursive: true });
      assert.deepStrictEqual(['grok', 'cursor', 'opencode'].map(nudge.detected), [true, true, true]);
    } finally { process.env.PATH = saved; }
  });

  console.log('opencode plugin (fake event bus, stand-in nudge-hook.sh)');
  await test('the plugin forwards the events the adapter maps, with the last reply on "done"', async () => {
    const out = path.join(HOME, 'posted');
    fs.mkdirSync(out);
    // Stand-in for ~/.claude-nudge/nudge-hook.sh: records its argument and stdin, one file per run (they run at once).
    write(nudge.HOOK, `#!/bin/sh\n{ printf '%s\\t' "$1"; cat; } > "${out}/$$.tmp" && mv "${out}/$$.tmp" "${out}/$$.json"\n`);
    fs.chmodSync(nudge.HOOK, 0o755);
    installHooks('opencode');
    const mjs = AGENTS.opencode.file.replace(/\.js$/, '.mjs'); // load it as ESM under Node, as Bun would
    fs.copyFileSync(AGENTS.opencode.file, mjs);
    const plugin = (await import(require('url').pathToFileURL(mjs).href)).default;
    assert.strictEqual(plugin.id, 'nudge');
    const events = [
      { type: 'session.inbox.enqueued', data: { sessionID: 'ses_1', inboxID: 'i', item: { type: 'user' } }, location: { directory: '/w/shop-api' } },
      { type: 'session.text.delta', data: { sessionID: 'ses_1', text: 'Mig' } },
      { type: 'session.text.ended', data: { sessionID: 'ses_1', text: 'Migrated the config.' } },
      { type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['git push'] }, location: { directory: '/w/shop-api' } },
      { type: 'form.created', data: { form: { id: 'frm_x', sessionID: 'global', metadata: { kind: 'mcp' }, fields: [] } } },
      { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' }, location: { directory: '/w/shop-api' } },
    ];
    let signal;
    const ctx = {
      location: { directory: '/w/fallback' },
      event: { subscribe: (opts) => { signal = opts.signal; return (async function* () { for (const e of events) yield e; })(); } },
    };
    const cleanup = await plugin.setup(ctx);
    assert.strictEqual(typeof cleanup, 'function');
    const deadline = Date.now() + 5000;
    const lines = () => fs.readdirSync(out).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(out, f), 'utf8'));
    while (lines().length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    cleanup();
    assert.ok(signal && signal.aborted, 'cleanup aborts the subscription');
    const posted = lines().map((l) => { const i = l.indexOf('\t'); const [arg, json] = [l.slice(0, i), l.slice(i + 1)]; assert.strictEqual(arg, 'opencode'); return JSON.parse(json); });
    assert.deepStrictEqual(posted.map((p) => p.hook_event_name).sort(), ['permission.asked', 'session.execution.succeeded', 'session.inbox.enqueued']);
    const actx = createContext();
    const byType = Object.fromEntries(posted.map((p) => [p.hook_event_name, adapters.opencode.normalize(p, actx)]));
    assert.strictEqual(byType['permission.asked'].kind, 'permission');
    assert.strictEqual(byType['permission.asked'].message, 'bash: git push');
    assert.strictEqual(byType['permission.asked'].project, 'shop-api');
    assert.strictEqual(byType['session.execution.succeeded'].message, 'Migrated the config.');
    assert.strictEqual(byType['session.inbox.enqueued'].kind, 'resolved');
    for (const e of Object.values(byType)) assert.strictEqual(e.session_id, 'ses_1');
  });

  await test('the plugin does nothing (and does not throw) when the hook is missing', async () => {
    fs.rmSync(nudge.HOOK);
    const plugin = (await import(require('url').pathToFileURL(AGENTS.opencode.file.replace(/\.js$/, '.mjs')).href)).default;
    const cleanup = await plugin.setup({ event: { subscribe: () => (async function* () { yield { type: 'session.execution.succeeded', data: { sessionID: 's' } }; })() } });
    await new Promise((r) => setTimeout(r, 100));
    cleanup();
  });

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
})();
