'use strict';
// OpenCode (opencode.ai, V2). OpenCode has no shell-command hooks, only plugins, so `npx nudge-mascot setup --agent
// opencode` installs hooks/nudge-opencode.js as ~/.config/opencode/plugins/nudge.js. The plugin subscribes to
// OpenCode's event bus and pipes a small JSON payload per relevant event into `nudge-hook.sh opencode`
// (POST /hook?agent=opencode), so the terminal headers and the secret work as for every other agent:
//   { hook_event_name: <bus event type>, session_id, cwd, data: <event.data>, last_assistant_message? }
//
// Sources, read 2026-10-31: the anomalyco/opencode (was sst/opencode) source at bf544cd (v2.2.5):
// packages/plugin/src/promise/*.ts, packages/schema/src/{permission,form,question,session-event}.ts and the built-in
// notifier packages/tui/src/feature-plugins/system/notifications.ts. OpenCode was NOT installed where this was
// written, so no payload here has been captured from a live run. V1 plugins (opencode < 2) are not supported: V2
// does not load them and V1 does not load this one.
//   permission.asked              data: { id, sessionID, action, resources: string[], message?, source? }
//   permission.replied            data: { sessionID, requestID, reply: once | always | reject }
//   form.created                  data: { form: { id, sessionID, title, metadata: { kind: 'question' }, fields } }
//   form.replied / form.cancelled data: { id, sessionID, ... }
//   session.inbox.enqueued        data: { sessionID, item: { type: 'user' | ... } }
//   session.execution.succeeded | failed (error) | interrupted (reason: user | shutdown | superseded | inactivity)
// last_assistant_message is the text of the session's last session.text.ended, which the plugin remembers.
// UNVERIFIED: the form `fields` shape, so a question nudge shows its text when a field has a label but no choices.

function questionText(form) {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  return fields.map((f) => (f && (f.label || f.title || f.question || f.description)) || '').filter(Boolean).join('\n\n');
}

function normalize(hook, ctx) {
  const { clip, pending } = ctx;
  if (!hook || typeof hook !== 'object') return null;
  const data = hook.data && typeof hook.data === 'object' ? hook.data : {};
  const form = data.form && typeof data.form === 'object' ? data.form : null;
  const base = ctx.base({ ...hook, session_id: hook.session_id || data.sessionID || (form && form.sessionID) }, 'opencode');
  const key = ctx.key(base);

  const resolved = () => {
    pending.delete(key);
    return { ...base, kind: 'resolved', title: 'Resolved', message: '' };
  };

  switch (hook.hook_event_name) {
    case 'session.execution.succeeded':
      pending.delete(key);
      return { ...base, kind: 'done', title: 'OpenCode is done', message: clip(hook.last_assistant_message || 'Finished working. Come take a look.', 1200) };
    case 'session.execution.failed':
      pending.delete(key);
      return { ...base, kind: 'done', title: 'OpenCode stopped', message: clip((data.error && (data.error.message || data.error)) || 'The session stopped with an error.', 1200) };
    case 'session.execution.interrupted':
      return data.reason === 'user' ? resolved() : null;

    case 'permission.asked': {
      pending.set(key, 'permission');
      const resources = Array.isArray(data.resources) ? data.resources.join(', ') : '';
      return {
        ...base,
        kind: 'permission',
        title: 'OpenCode needs permission',
        message: clip(data.message || (data.action ? `${data.action}${resources ? `: ${resources}` : ''}` : 'OpenCode is waiting for your approval.'), 600),
        tool_name: data.action || '',
        tool_use_id: '',
        approvable: false, // answering from the bubble or the phone is Claude Code only for now
      };
    }

    case 'form.created': {
      if (!form || !form.metadata || form.metadata.kind !== 'question') return null; // other forms (MCP elicitation)
      pending.set(key, 'question');
      return { ...base, kind: 'question', title: 'OpenCode has a question', message: clip(questionText(form) || 'OpenCode is waiting for your answer.', 1200), approvable: false };
    }

    case 'permission.replied':
    case 'form.replied':
    case 'form.cancelled':
      return resolved();
    case 'session.inbox.enqueued':
      return data.item && data.item.type === 'user' ? resolved() : null;

    default:
      return null;
  }
}

function samples(common) {
  const o = (type, data, extra) => ({ hook_event_name: type, session_id: common.session_id, cwd: common.cwd, data: { sessionID: common.session_id, ...data }, ...extra });
  return {
    question: o('form.created', { form: { id: `frm_test${Date.now()}`, sessionID: common.session_id, title: 'Questions', metadata: { kind: 'question' },
      fields: [{ key: 'q0', label: 'This is a test nudge. Which approach should I take for the auth refactor?' }] } }),
    permission: o('permission.asked', { id: `per_test${Date.now()}`, action: 'bash', resources: ['npm publish --access public'] }),
    done: o('session.execution.succeeded', {}, { last_assistant_message: 'Test run finished. All 42 tests pass and the branch is ready for review.' }),
    resolved: o('session.inbox.enqueued', { inboxID: 'test', item: { type: 'user' } }),
  };
}

module.exports = { name: 'opencode', label: 'OpenCode', normalize, samples };
