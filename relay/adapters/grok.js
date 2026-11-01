'use strict';
// xAI Grok Build (the `grok` CLI). Hooks installed by `npx nudge-mascot setup --agent grok` in their own file,
// ~/.grok/hooks/nudge.json (user hook files are always trusted), running `nudge-hook.sh grok` (POST /hook?agent=grok).
//
// Source, read 2026-10-31: github.com/xai-org/grok-build at 2bdd1d6a (1.0.45), the hooks user guide
// (crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md) and the payload schema (crates/codegen/xai-grok-hooks/
// src/event.rs). docs.x.ai/build/features/hooks was not reachable from where this was written, and Grok Build was
// NOT installed there, so no payload here has been captured from a live run.
//   common:           hook_event_name (PascalCase, as Claude Code), hookEventName (snake), session_id / sessionId,
//                     cwd, workspaceRoot, timestamp, transcript_path, permission_mode, promptId
//   Notification:     notificationType (camelCase only) permission_prompt | elicitation_dialog | idle_prompt |
//                     task_complete | agent_error, plus message, title, level
//   Stop:             reason ('end_turn' for a real finish; channel_closed / shutdown when the session ends),
//                     stopHookActive, lastAssistantMessage (camelCase only)
//   StopFailure:      error, errorDetails        StopCancelled: reason ('permission_rejected', ...), cancelledBy
//   UserPromptSubmit: prompt                     PostToolUse: tool_name, tool_use_id, tool_input, tool_response
//   PreToolUse:       tool_name, tool_use_id, tool_input; the question tool is ask_user_question
// Events with subagentType come from a subagent and are ignored. There is no PermissionRequest event, so the
// permission nudge comes from Notification/permission_prompt and is answered in the terminal.
// UNVERIFIED: that PreToolUse fires for ask_user_question, and its tool_input.questions shape (taken to match
// Claude Code's AskUserQuestion, which the source aliases). Without it the elicitation_dialog notification still
// raises a question nudge, only without the choices.
// Grok also runs the hooks in ~/.claude/settings.json; the relay drops those copies (see hostAgent in index.js).

const QUESTION_TOOL = 'ask_user_question';
const pick = (hook, camel, snake) => (hook[camel] != null ? hook[camel] : hook[snake]);

function normalize(hook, ctx) {
  const { clip, pending } = ctx;
  if (!hook || typeof hook !== 'object') return null;
  const base = ctx.base({ ...hook, session_id: hook.session_id || hook.sessionId, cwd: hook.cwd || hook.workspaceRoot }, 'grok');
  const key = ctx.key(base);
  if (hook.subagentType) return null;

  const resolved = () => {
    pending.delete(key);
    return { ...base, kind: 'resolved', title: 'Resolved', message: '' };
  };

  switch (hook.hook_event_name) {
    case 'Stop':
      if (hook.reason && hook.reason !== 'end_turn') return null; // the session closing, not a finished turn
      pending.delete(key);
      return { ...base, kind: 'done', title: 'Grok is done', message: clip(pick(hook, 'lastAssistantMessage', 'last_assistant_message') || 'Finished working. Come take a look.', 1200) };
    case 'StopFailure':
      pending.delete(key);
      return { ...base, kind: 'done', title: 'Grok stopped', message: clip(hook.error || 'The turn ended with an error.', 1200) };

    // The user acted in the terminal: typed a prompt, cancelled, or declined the request.
    case 'UserPromptSubmit':
    case 'StopCancelled':
      return resolved();
    case 'PostToolUse':
      if (hook.tool_name === QUESTION_TOOL || pending.has(key)) return resolved();
      return null;

    case 'PreToolUse': { // UNVERIFIED, see the header
      if (hook.tool_name !== QUESTION_TOOL) return null;
      if (hook.tool_use_id && ctx.isDuplicate('grok', hook.tool_use_id)) return null;
      const questions = (hook.tool_input && hook.tool_input.questions) || [];
      const text = questions.map((q) => q.question).filter(Boolean).join('\n\n');
      pending.set(key, 'question');
      return {
        ...base,
        kind: 'question',
        title: 'Grok has a question',
        message: clip(text || 'Grok is waiting for your answer.', 1200),
        tool_name: QUESTION_TOOL,
        tool_use_id: hook.tool_use_id || '',
        approvable: false, // answering from the bubble or the phone is Claude Code only for now
        options: questions.map((q) => ({
          header: q.header || '',
          question: q.question || '',
          multiSelect: !!q.multiSelect,
          choices: (q.options || []).map((o) => o.label).filter(Boolean),
        })),
      };
    }

    case 'Notification': {
      const type = pick(hook, 'notificationType', 'notification_type');
      if (type === 'permission_prompt') {
        pending.set(key, 'permission');
        return {
          ...base,
          kind: 'permission',
          title: 'Grok needs permission',
          message: clip(hook.message || 'Grok is waiting for your approval.', 600),
          tool_name: '',
          tool_use_id: '',
          approvable: false, // Grok has no hook that can answer a permission prompt
        };
      }
      if (type === 'elicitation_dialog') {
        if (pending.get(key) === 'question') return null; // the PreToolUse question nudge (with choices) is already up
        pending.set(key, 'question');
        return { ...base, kind: 'question', title: 'Grok has a question', message: clip(hook.message || 'Grok is waiting for your answer.', 1200), approvable: false };
      }
      if (type === 'idle_prompt') return { ...base, kind: 'idle', title: 'Grok is waiting', message: clip(hook.message || 'Grok is waiting for your input.', 600) };
      return null;
    }

    default:
      return null;
  }
}

function samples(common) {
  const g = (event, extra) => ({ ...common, hookEventName: event.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase()), hook_event_name: event,
    sessionId: common.session_id, workspaceRoot: common.cwd, timestamp: new Date().toISOString(), permission_mode: 'default', ...extra });
  return {
    question: g('PreToolUse', { tool_name: QUESTION_TOOL, tool_use_id: `test-q-${Date.now()}`,
      tool_input: { questions: [{ header: 'Approach', question: 'This is a test nudge. Which approach should I take for the auth refactor?', options: [{ label: 'Keep sessions' }, { label: 'Move to JWT' }] }] } }),
    permission: g('Notification', { notificationType: 'permission_prompt', title: 'Permission required', message: 'Grok wants to run: npm publish --access public', level: 'info' }),
    done: g('Stop', { reason: 'end_turn', stopHookActive: false, lastAssistantMessage: 'Test run finished. All 42 tests pass and the branch is ready for review.' }),
    resolved: g('UserPromptSubmit', { prompt: 'ok' }),
  };
}

module.exports = { name: 'grok', label: 'Grok', normalize, samples };
