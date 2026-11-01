---
title: "Claude Code hooks, explained by a pixel mascot that gets annoyed when you ignore it"
published: false
description: "A worked example of Claude Code hooks: a shell hook, a local relay, and an approval hook that answers permission prompts from the browser."
tags: claudecode, ai, javascript, productivity
cover_image: https://nudge-mascot.vercel.app/assets/og.png
---

You give Claude Code a task, switch to the browser "just for a second", and ten minutes later you find it has been sitting on a permission prompt the whole time. I lost enough afternoons that way that I built [Nudge](https://github.com/JayroldSoriano/nudge-mascot): a pixel mascot that waves at you on your active Chrome tab when Claude has a question, needs permission, or is done. Leave it waiting and it gets harder to ignore. It walks to the middle of the screen, grows, taps its foot and eventually sounds an alarm.

The mascot is the fun part. Underneath it is a small, practical example of **Claude Code hooks**, and that is what this post covers: which events to listen to, what the payloads look like, and how a hook can do more than observe. It can answer Claude.

## What hooks are

Hooks are commands Claude Code runs at fixed points in its lifecycle. You list them in `~/.claude/settings.json` under an event name, optionally with a `matcher`, and Claude Code runs each one with the event's JSON on **stdin**. Some events also read the hook's **stdout**, so a hook can change what happens next.

Nudge uses these:

| Event | When it fires | What Nudge does |
| --- | --- | --- |
| `Stop` | Claude finished its turn | "Claude is done" bubble |
| `Notification` | Claude wants your attention (permission, idle, input) | permission / idle bubble |
| `PreToolUse` (matcher `AskUserQuestion`) | Claude is about to ask you a multiple-choice question | question bubble with the options |
| `PostToolUse`, `UserPromptSubmit` | you answered in the terminal | clear the bubble everywhere |
| `PermissionRequest` | a tool needs approval | Allow / Deny buttons in the bubble |

The last two rows are the point. Most hook tutorials stop at "send a notification". Knowing when the wait is *over* matters just as much, otherwise the mascot keeps waving after you've already answered.

## The hook config

This is what `npx nudge-mascot setup` merges into `settings.json` (trimmed, paths shortened):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "\"~/.claude-nudge/nudge-hook.sh\"" }] }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt|idle_prompt|agent_needs_input|agent_completed",
        "hooks": [{ "type": "command", "command": "\"~/.claude-nudge/nudge-hook.sh\"" }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [{ "type": "command", "command": "\"~/.claude-nudge/nudge-hook.sh\"" }]
      },
      {
        "matcher": "AskUserQuestion",
        "hooks": [{ "type": "command", "command": "\"node\" \"~/.claude-nudge/nudge-approve.js\"", "timeout": 600 }]
      }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "\"~/.claude-nudge/nudge-hook.sh\"" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "\"~/.claude-nudge/nudge-hook.sh\"" }] }
    ],
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "\"node\" \"~/.claude-nudge/nudge-approve.js\"", "timeout": 600 }] }
    ]
  }
}
```

A few things worth noticing:

- **Matchers do different jobs per event.** On `PreToolUse` the matcher filters by tool name (`AskUserQuestion`). On `Notification` it filters by notification type. Without a matcher, the hook runs on every occurrence.
- **Quote the command.** Earlier versions installed the path unquoted, which broke for anyone whose `$HOME` has a space in it.
- **`timeout: 600`** on the approval hook. That one deliberately blocks, so it gets Claude Code's full ten minutes. The observer hook doesn't block at all.
- **Merge, don't overwrite.** The installer reads the existing file, backs it up once (`settings.json.bak-claude-nudge`), drops stale Nudge entries, appends its own and leaves everything else alone. People already have hooks of their own, and an installer that wipes them won't be installed twice.

## Hook #1: forward everything, block nothing

The observer hook is a POSIX shell script. Claude Code pipes the event JSON in, and the script pipes it straight to a relay on localhost:

```sh
#!/bin/sh
PORT="${CLAUDE_NUDGE_PORT:-47831}"
SECRET=""
SECRET_FILE="${HOME:-}/.claude-nudge/secret"
if [ -r "$SECRET_FILE" ]; then IFS= read -r SECRET < "$SECRET_FILE" || true; fi
curl -s -m 2 -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Nudge-Secret: ${SECRET}" \
  -H "X-Nudge-Terminal: ${TERM_PROGRAM:-}" \
  -H "X-Nudge-Tmux-Pane: ${TMUX_PANE:-}" \
  --data-binary @- \
  "http://127.0.0.1:${PORT}/hook" >/dev/null 2>&1 || true
exit 0
```

The rules I'd give any observer hook:

1. **Never fail.** `|| true` and `exit 0`. A hook that errors shows up in the user's session, and a hook that hangs stalls Claude.
2. **Bound the time.** `curl -m 2`. If the relay is down, Claude loses two seconds at worst.
3. **Spawn as little as you can.** The secret is read with the shell's built-in `read`, not `cat`. The terminal info comes from environment variables Claude Code passes down (`TERM_PROGRAM`, `TMUX_PANE`, `ITERM_SESSION_ID`), so the "Jump to terminal" button knows which window to bring forward without the hook running anything extra.
4. **Keep logic out of the hook.** The script doesn't parse anything. It just forwards bytes, and everything interesting happens in a long-running process that is easier to test.

## The relay: turning payloads into events

The relay is a zero-dependency Node server bound to `127.0.0.1`. It pushes events to the Chrome extension over a WebSocket. Its main job is mapping raw hook payloads to one event shape the extension understands. Here is the core of the Claude Code adapter:

```js
switch (hook.hook_event_name) {
  case 'Stop':
    pending.delete(key);
    return { ...base, kind: 'done', title: 'Claude is done',
      message: clip(hook.last_assistant_message || 'Finished working.', 1200) };

  // The user acted in the terminal: answered a question, approved a tool, or typed a prompt.
  case 'UserPromptSubmit':
    return resolved();
  case 'PostToolUse':
    if (hook.tool_name === 'AskUserQuestion' || pending.has(key)) return resolved();
    return null;

  case 'PreToolUse': {
    if (hook.tool_name !== 'AskUserQuestion') return null;
    const questions = (hook.tool_input && hook.tool_input.questions) || [];
    if (hook.tool_use_id && isDuplicate('claude-code', hook.tool_use_id)) return null;
    pending.set(key, 'question');
    return { ...base, kind: 'question', title: 'Claude has a question',
      message: clip(questions.map((q) => q.question).join('\n\n'), 1200),
      options: questions.map((q) => ({ question: q.question,
        choices: (q.options || []).map((o) => o.label) })) };
  }

  case 'Notification':
    if (hook.notification_type === 'permission_prompt') { /* dedupe, then emit a permission event */ }
    if (hook.notification_type === 'idle_prompt') { /* emit an idle event */ }
    return null;
}
```

Things I learned from real payloads:

- **`Stop` carries `last_assistant_message`**, so the "done" bubble can show what Claude actually said instead of a generic line.
- **Key state by session.** Every payload has `session_id`. Run three Claude sessions and three can be blocked at once, so the `pending` map is keyed by `agent:session_id`, and one session's `PostToolUse` never clears another session's nudge.
- **Expect duplicates.** Two hooks can see the same `PreToolUse` event (the observer and the approval hook below), and a `PermissionRequest` is followed a few seconds later by a `permission_prompt` notification for the same thing. The adapter dedupes on `tool_use_id`, and suppresses the notification for 10 seconds after a permission request.
- **Clip messages** before they leave the relay. Claude's last message can be long.

## Hook #2: a hook that answers Claude

This is the part I find most interesting. `PermissionRequest` and `PreToolUse` read the hook's stdout. If the hook prints the right JSON, Claude Code uses it instead of prompting in the terminal. So `nudge-approve.js` posts the request to the relay, long-polls for a decision from the bubble's Allow / Deny buttons, and prints it:

```js
const posted = await request('POST', '/hook', raw);
// No relay, or nothing that can answer: don't make Claude wait.
if (!posted || !posted.body || !posted.body.canDecide) return;

const deadline = Date.now() + WAIT_S * 1000; // 570 s, under the 600 s hook timeout
while (Date.now() < deadline) {
  const res = await request('GET', `/decision?${q}&wait=25000`);
  if (!res) return; // relay went away
  const d = res.body && res.body.decision;
  if (d && (d.behavior === 'allow' || d.behavior === 'deny')) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: d.behavior === 'allow'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: `Denied from Nudge (${d.by})` },
      },
    }));
    return;
  }
}
```

For a question it's the same loop, but the hook answers `PreToolUse` with the user's picks filled in:

```js
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    updatedInput: { questions: hook.tool_input.questions, answers },
  },
}));
```

`updatedInput` rewrites the tool call's arguments before it runs, so `AskUserQuestion` gets its answers already filled in and Claude carries on as if you'd clicked in the terminal.

Some design rules for a blocking hook:

- **Only wait when something can answer.** The relay replies with `canDecide`, which is true only if the extension is connected or a phone is paired. With Chrome closed, the hook returns at once and the normal terminal prompt appears. Nobody should pay for a feature they aren't using.
- **Printing nothing is a valid answer.** On timeout or any error the hook prints nothing and exits 0, and Claude Code falls back to its own prompt. The terminal always works.
- **Stay under the timeout.** 570 s of waiting inside a 600 s hook leaves room to exit cleanly.
- **Notice when the user answers elsewhere.** If you approve in the terminal, Claude Code kills the hook. The relay sees the long-poll socket close and clears the bubble. A Deny fires no `PostToolUse`, so this is the only signal you get.
- **Don't trust that a field exists.** One Claude Code release sent `PermissionRequest` without `tool_use_id`. The hook now mints a random one per run. Don't derive it from the request content: the same command asked twice would reuse the first answer.

## Security: localhost is not private

A relay on `127.0.0.1` is reachable by every process and every user account on the machine, and an endpoint that can approve `Bash` commands is worth protecting. So setup writes 32 random bytes to `~/.claude-nudge/secret` (mode 0600). The hooks send it as `X-Nudge-Secret`, and every endpoint except `/health` returns 401 without it. Requests with an `http(s)://` `Origin` header are refused before that check, so a web page can't reach the relay either. If your hook talks to a local server, assume something hostile can talk to that server too.

## Try it

```sh
npx nudge-mascot setup
npx nudge-mascot test approve   # a fake permission you can Allow from the bubble
```

Restart running Claude Code sessions after setup, since hooks are read at startup. The same `nudge-hook.sh` also serves Codex CLI and Gemini CLI through per-agent adapters in the relay, which is another argument for keeping the hook dumb.

What I took away from this: hooks are a tiny API with a lot of reach. Forward events from a script that can't fail, keep the logic in a process you can test, and when a hook blocks, make sure it can always step aside. The code is MIT on [GitHub](https://github.com/JayroldSoriano/nudge-mascot). Issues and mascot ideas welcome.

*Nudge is an independent project, not affiliated with or endorsed by Anthropic.*
