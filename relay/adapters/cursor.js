'use strict';
// Cursor (the editor's agent and the cursor-agent CLI). Hooks installed by `npx nudge-mascot setup --agent cursor` in
// ~/.cursor/hooks.json, running `nudge-hook.sh cursor` (POST /hook?agent=cursor).
//
// Sources, read 2026-10-31: Cursor's hook runner in the official @cursor/sdk@1.2.0 npm package, cross-checked with
// the types in @mnemonik/cursor-hooks (captured from Cursor CLI 2026.09.02). cursor.com/docs/hooks was not reachable
// from where this was written, and Cursor was NOT installed there, so no payload here has been captured from a live run.
//   common:             conversation_id, generation_id, session_id (= conversation_id when absent), hook_event_name,
//                       model, cursor_version, workspace_roots (array), user_email, transcript_path. No common cwd.
//   beforeSubmitPrompt: prompt, attachments                  -> the user typed a prompt: resolved
//   afterAgentResponse: text                                 -> remembered as the message of the next `stop`
//   stop:               status 'completed' | 'aborted' | 'error', loop_count
// Cursor has no permission, notification or question event: beforeShellExecution / preToolUse run before Cursor
// decides whether to ask, so a hook cannot tell whether a prompt is showing. So Cursor gets done nudges only (and
// resolves them when you type). A forum report says afterAgentResponse does not fire in the CLI; "done" then uses
// the fallback message.
// Cursor also runs the hooks in ~/.claude/settings.json; the relay drops those copies (see hostAgent in index.js).

function normalize(hook, ctx) {
  const { clip, pending, lastText } = ctx;
  if (!hook || typeof hook !== 'object') return null;
  const roots = Array.isArray(hook.workspace_roots) ? hook.workspace_roots : [];
  const base = ctx.base({ ...hook, session_id: hook.session_id || hook.conversation_id, cwd: hook.cwd || roots[0] }, 'cursor');
  const key = ctx.key(base);

  switch (hook.hook_event_name) {
    case 'afterAgentResponse':
      if (hook.text) lastText.set(key, String(hook.text));
      return null;

    case 'stop': {
      const text = lastText.get(key);
      lastText.delete(key);
      pending.delete(key);
      if (hook.status === 'aborted') return { ...base, kind: 'resolved', title: 'Resolved', message: '' }; // you stopped it
      if (hook.status === 'error') return { ...base, kind: 'done', title: 'Cursor stopped', message: 'The agent stopped with an error. Come take a look.' };
      return { ...base, kind: 'done', title: 'Cursor is done', message: clip(text || 'Finished working. Come take a look.', 1200) };
    }

    case 'beforeSubmitPrompt':
      pending.delete(key);
      lastText.delete(key);
      return { ...base, kind: 'resolved', title: 'Resolved', message: '' };

    default:
      return null;
  }
}

function samples(common) {
  const c = (event, extra) => ({ conversation_id: common.session_id, generation_id: `test-${Date.now()}`, session_id: common.session_id,
    hook_event_name: event, model: 'test', cursor_version: '2.6.0', workspace_roots: [common.cwd], user_email: null, transcript_path: null, ...extra });
  return {
    done: c('stop', { status: 'completed', loop_count: 0 }),
    resolved: c('beforeSubmitPrompt', { prompt: 'ok', attachments: [] }),
  };
}

module.exports = { name: 'cursor', label: 'Cursor', normalize, samples };
