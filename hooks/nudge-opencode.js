// Nudge plugin for OpenCode (V2). Installed by `npx nudge-mascot setup --agent opencode` as
// ~/.config/opencode/plugins/nudge.js. OpenCode has no shell-command hooks, so this subscribes to its event bus and
// pipes one small JSON payload per relevant event into `nudge-hook.sh opencode`, the same hook every other agent
// runs (it adds the terminal headers and the secret, and never blocks). relay/adapters/opencode.js maps the payload:
//   { hook_event_name: <event type>, session_id, cwd, data: <event.data>, last_assistant_message? }
// Never throws: a missing hook or relay only means no nudge.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOOK = /* nudge:hook */ join(homedir(), '.claude-nudge', 'nudge-hook.sh');
const FORWARD = new Set([
  'permission.asked', 'permission.replied',
  'form.created', 'form.replied', 'form.cancelled',
  'session.inbox.enqueued',
  'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted',
]);

function send(payload) {
  if (!existsSync(HOOK)) return;
  try {
    const child = spawn(HOOK, ['opencode'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  } catch (_) { /* no nudge */ }
}

export default {
  id: 'nudge',
  setup: async (ctx) => {
    const controller = new AbortController();
    const lastText = new Map(); // sessionID -> text of its last session.text.ended
    const fallbackCwd = (ctx.location && ctx.location.directory) || process.cwd();
    (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const data = (event && event.data) || {};
        const sessionID = data.sessionID || (data.form && data.form.sessionID) || '';
        if (event.type === 'session.text.ended') { if (sessionID && data.text) lastText.set(sessionID, String(data.text)); continue; }
        if (!FORWARD.has(event.type)) continue;
        if (event.type === 'form.created' && !(data.form && data.form.metadata && data.form.metadata.kind === 'question')) continue;
        const payload = { hook_event_name: event.type, session_id: sessionID, cwd: (event.location && event.location.directory) || fallbackCwd, data };
        if (event.type === 'session.execution.succeeded') { payload.last_assistant_message = lastText.get(sessionID) || ''; lastText.delete(sessionID); }
        send(payload);
      }
    })().catch(() => {});
    return () => controller.abort();
  },
};
