#!/usr/bin/env node
'use strict';
// Windows end-to-end check, run by CI on windows-latest (.github/workflows/test.yml): setup under a throwaway home,
// the relay started from the Run key's launcher, every hook command run through Git Bash, PowerShell and cmd (the
// shells the agents use there), the approval hook, `test`, then uninstall. It writes the real HKCU Run key, so it
// refuses to run outside CI unless given --yes.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') { console.log('windows-smoke: Windows only, skipped'); process.exit(0); }
if (process.env.GITHUB_ACTIONS !== 'true' && !process.argv.includes('--yes')) {
  console.log('windows-smoke: writes HKCU\\...\\Run and starts a relay; run it in CI, or pass --yes'); process.exit(1);
}

const PORT = '47899'; // never the default port: a real install may be using it
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge smoke ')); // a space, as in "C:\Users\Jo Ann"
const env = { ...process.env, HOME, USERPROFILE: HOME, CLAUDE_NUDGE_PORT: PORT };
const CLI = path.join(__dirname, '..', 'bin', 'nudge.js');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const GIT_BASH = ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p)) || 'bash'; // not WSL's bash.exe

function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  console.log(`$ nudge ${args.join(' ')}\n${(r.stdout + r.stderr).trim()}\n`);
  assert.strictEqual(r.status, 0, `nudge ${args.join(' ')} exited ${r.status}`);
  return r.stdout;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventsAfter(before) {
  for (let i = 0; i < 20; i++) { const h = await health(); if (h && h.events > before) return h.events; await sleep(250); }
  const h = await health();
  return h ? h.events : -1;
}

// Runs a hook command the way an agent would: through a shell, the payload on stdin.
function runIn(shell, command, payload) {
  const opts = { env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 20000 };
  if (shell === 'cmd') return spawnSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { ...opts, windowsVerbatimArguments: true });
  if (shell === 'powershell') return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], opts);
  return spawnSync(GIT_BASH, ['-c', command], opts);
}

(async () => {
  cli('setup', '--agent', 'claude-code,codex');
  const h = await health();
  assert.ok(h, 'the relay answers after setup');
  const run = spawnSync('reg', ['query', RUN_KEY, '/v', 'NudgeRelay'], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0, 'Run key value written');
  assert.ok(run.stdout.includes('wscript.exe') && run.stdout.includes('relay.vbs'), run.stdout);

  const settings = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'));
  const stop = settings.hooks.Stop[0].hooks[0].command;
  const approve = settings.hooks.PermissionRequest[0].hooks[0].command;
  const codex = JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'hooks.json'), 'utf8')).hooks.Stop[0].hooks[0].command;
  console.log(`hook commands:\n  ${stop}\n  ${approve}\n  ${codex}\n`);
  assert.match(stop, /^node "[A-Za-z]:\/[^"\\]+\/nudge-hook\.js"$/);
  assert.match(codex, /^node "[A-Za-z]:\/[^"\\]+\/nudge-hook\.js" codex$/);

  let n = (await health()).events;
  for (const shell of ['bash', 'powershell', 'cmd']) {
    for (const [label, command] of [['claude-code', stop], ['codex', codex]]) {
      const payload = { hook_event_name: 'Stop', session_id: `smoke-${shell}-${label}`, cwd: `C:\\w\\${shell}-${label}`, last_assistant_message: 'ok' };
      const r = runIn(shell, command, payload);
      assert.strictEqual(r.status, 0, `${label} hook via ${shell} exited ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.stdout.trim(), '', `${label} hook via ${shell} printed something`);
      const after = await eventsAfter(n);
      assert.ok(after > n, `${label} hook via ${shell} reached the relay`);
      console.log(`  ok    ${label} hook via ${shell}`);
      n = after;
    }
  }

  // No extension connected: the approval hook must return at once with no output, so Claude's own prompt shows.
  for (const shell of ['bash', 'powershell', 'cmd']) {
    const t = Date.now();
    const r = runIn(shell, approve, { hook_event_name: 'PermissionRequest', session_id: `smoke-approve-${shell}`, cwd: 'C:\\w\\api', tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.strictEqual(r.status, 0, `approval hook via ${shell} exited ${r.status}: ${r.stderr}`);
    assert.strictEqual(r.stdout.trim(), '');
    assert.ok(Date.now() - t < 15000, 'approval hook did not wait');
    console.log(`  ok    approval hook via ${shell}`);
  }

  cli('test');
  assert.ok((await eventsAfter(n)) > n, '`test` reached the relay');
  cli('status');

  // A re-run replaces the running relay instead of failing on the busy port.
  cli('setup', '--agent', 'claude-code');
  assert.ok(await health(), 'the relay answers after a second setup');

  cli('uninstall');
  assert.notStrictEqual(spawnSync('reg', ['query', RUN_KEY, '/v', 'NudgeRelay']).status, 0, 'Run key value removed');
  assert.ok(!fs.existsSync(path.join(HOME, '.claude-nudge')), '~/.claude-nudge removed');
  assert.ok(!(await health()), 'relay stopped');
  const left = fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8');
  assert.ok(!/nudge-(hook|approve)/.test(left), 'no Nudge hooks left in settings.json');
  console.log('\nwindows smoke: all ok');
})().catch((e) => { console.error(e); process.exit(1); });
