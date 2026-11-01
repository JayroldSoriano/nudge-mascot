<p align="center">
  <img src="extension/icons/icon128.png" width="96" height="96" alt="Nudge" style="image-rendering: pixelated">
</p>
<h1 align="center">Nudge</h1>
<p align="center">
  A pixel mascot waves at you in Chrome when Claude Code has a question, needs permission, or is done.<br>
  Ignore it and it gets annoyed. Free, open source, local only.
</p>
<p align="center">
  <a href="https://nudge-mascot.vercel.app/">Website</a> ·
  <a href="#install">Install</a> ·
  <a href="#escalation">Escalation</a> ·
  <a href="#reply-from-the-bubble">Reply</a> ·
  <a href="#jump-back">Jump back</a> ·
  <a href="#waiting-stats">Stats</a> ·
  <a href="https://nudge-mascot.vercel.app/privacy">Privacy</a> ·
  <a href="https://github.com/sponsors/JayroldSoriano">Sponsor</a>
</p>

<p align="center"><img src="docs/demo.gif" width="800" alt="Nudge escalating from a corner wave to an alarm"></p>

You start a task in Claude Code, switch to the browser "just for a second", and ten minutes later
Claude has been sitting on a permission prompt the whole time. Nudge fixes that.

```
Claude Code hook ──curl──▶ relay on 127.0.0.1 ──WebSocket──▶ extension ──▶ Nudge on your active tab
```

## Install

```sh
npx nudge-mascot setup
```

That copies the relay and hooks into `~/.claude-nudge/`, adds the hooks to `~/.claude/settings.json`
(backup saved next to it; Codex, Gemini CLI, Grok Build, Cursor and OpenCode too when found, see [Other agents](#other-agents)), including
the two approval hooks that let you [reply from the bubble](#reply-from-the-bubble), starts the relay and keeps
it running at login (launchd on macOS, systemd user service on Linux), and prints where to load the extension
and a **connection code** (see [Privacy](#privacy)). Running it again is safe: hooks already present are left
alone, the backup keeps your settings from before the first run, and the code stays the same.

Then load the extension: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**,
and pick `~/.claude-nudge/extension` (Chrome Web Store listing coming). Click the Nudge toolbar icon, and paste
the connection code into **Connect** (the welcome page that opens on install has the same field;
`npx nudge-mascot status` prints the code again). Restart any running Claude Code session and run:

```sh
npx nudge-mascot test            # a question
npx nudge-mascot test done       # done / permission / approve / questions / resolved
npx nudge-mascot test jump       # a nudge whose "Jump to terminal" switches back to this terminal
npx nudge-mascot test multi      # three sessions waiting at once (the session switcher)
npx nudge-mascot status          # relay health, hook check (approval hooks included), the connection code
npx nudge-mascot uninstall       # removes everything it installed, approval hooks and stats included
```

Requires Node 18+ and Chrome 116+.

## Other agents

Nudge also waits on OpenAI's Codex CLI, Google's Gemini CLI, xAI's Grok Build, Cursor and OpenCode. `setup` with no
flags installs hooks for every agent it finds (`~/.claude`; `~/.codex` or a `codex` binary; `~/.gemini/settings.json`
or a `gemini` binary, since Antigravity and Gemini Code Assist create `~/.gemini` too; `~/.grok/config.toml` or a
`grok` binary, since the community grok-cli uses `~/.grok` too; `~/.cursor` or a `cursor-agent` / `cursor` binary;
`~/.config/opencode` or an `opencode` binary) and prints what it did. Pick agents explicitly with `--agent`:

```sh
npx nudge-mascot setup --agent codex          # hooks in ~/.codex/hooks.json
npx nudge-mascot setup --agent gemini         # hooks in ~/.gemini/settings.json
npx nudge-mascot setup --agent grok           # hooks in their own file, ~/.grok/hooks/nudge.json
npx nudge-mascot setup --agent cursor         # hooks in ~/.cursor/hooks.json
npx nudge-mascot setup --agent opencode       # a plugin, ~/.config/opencode/plugins/nudge.js
npx nudge-mascot setup --agent claude-code,codex
npx nudge-mascot test permission --agent codex  # a fake Codex nudge
npx nudge-mascot status                       # hook status per agent
npx nudge-mascot uninstall                    # removes the hooks from every agent's config
```

Every agent runs the same `~/.claude-nudge/nudge-hook.sh`; the others pass their name (`nudge-hook.sh codex`),
which the hook sends as `POST /hook?agent=codex`. OpenCode has no shell hooks, so its plugin pipes each relevant
event into `nudge-hook.sh opencode` itself. In every case the relay's adapter for that agent (`relay/adapters/`) turns
the payload into the same event. The first write backs up the config next to it (`.bak-claude-nudge`; later runs
keep that backup), merges, and is safe to re-run. A config that isn't plain JSON (comments, say) is left alone with a warning. Bubbles from other
agents name the agent ("Codex is done", "Gemini needs permission") and show an agent badge next to the project.

| Agent | Hooks | Nudges | Status |
| --- | --- | --- | --- |
| Claude Code | `Stop`, `Notification`, `PreToolUse` (AskUserQuestion), `PostToolUse`, `UserPromptSubmit`, plus the approval hooks (`PermissionRequest`, `PreToolUse` on AskUserQuestion) | question, permission, done, idle | Verified in daily use. Allow / Deny and answers from the bubble (approval hooks installed by `setup`) or the phone (`npx nudge-mascot pair`). |
| Codex CLI | `PermissionRequest`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `PreToolUse` (request_user_input) | permission, done (question unverified) | **Unverified on a live Codex.** Built from the official [hooks reference](https://developers.openai.com/codex/hooks); Codex wasn't installed where this was written. The `request_user_input` question payload is a guess. Codex only runs hooks you have trusted: type `/hooks` in Codex after setup. No idle nudges (Codex has no such event). |
| Gemini CLI | `Notification` (ToolPermission), `AfterAgent`, `BeforeAgent`, `AfterTool` | permission, done | **Unverified on a live Gemini CLI.** Built from the [hooks reference](https://geminicli.com/docs/hooks/reference/) and the v0.66.0 source (the permission `details` shape). Upstream bug [#27712](https://github.com/google-gemini/gemini-cli/issues/27712): `AfterAgent` does not fire on some versions (reported for 0.45 to 0.55.1), so "done" may be missing there. No question or idle nudges. |
| Grok Build | `Notification` (permission_prompt, elicitation_dialog, idle_prompt), `PreToolUse` (ask_user_question), `PostToolUse`, `UserPromptSubmit`, `Stop`, `StopFailure`, `StopCancelled` | permission, question, done, idle | **Unverified on a live Grok Build.** Built from the [xai-org/grok-build](https://github.com/xai-org/grok-build) source at 1.0.45 (hooks guide and `xai-grok-hooks/src/event.rs`). No `PermissionRequest` event, so permissions are answered in the terminal. The `ask_user_question` choices are a guess (without them the question still shows, without choices). |
| Cursor | `stop`, `afterAgentResponse`, `beforeSubmitPrompt` | done | **Unverified on a live Cursor.** Built from the hook runner in `@cursor/sdk` 1.2.0 ([docs](https://cursor.com/docs/hooks)). Cursor has no hook for its approval prompts or questions (the `before*` hooks run before it decides to ask), so there are no permission or question nudges. `afterAgentResponse` reportedly doesn't fire in the CLI; "done" then has the generic message. |
| OpenCode | plugin on the event bus: `permission.asked` / `.replied`, `form.created` (question tool) / `.replied` / `.cancelled`, `session.inbox.enqueued`, `session.execution.*` | permission, question, done | **Unverified on a live OpenCode.** Built from the OpenCode 2 source (v2.2.5); OpenCode 1 plugins are a different API and aren't supported. A subagent's session finishing may show its own "done". Restart OpenCode after setup. |

Grok Build and Cursor also run the hooks in `~/.claude/settings.json`, so Nudge's Claude Code hook fires inside them
too. The relay recognises those payloads (Grok's carry `hookEventName` / `workspaceRoot`, Cursor's `cursor_version`)
and drops them, and the approval hook returns at once for them, so a Grok or Cursor turn never shows as "Claude is
done" or waits on the bubble; their own hooks report it.

Answering from the bubble or the phone (Allow / Deny, picking an answer) stays Claude Code only for now; for
the other agents the bubble shows the request and you answer in the terminal. Jump to terminal and the waiting
stats work for every agent, since they all run the same hook. Codex's `PermissionRequest` hook can decide too (it prints
`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`, the same shape as
Claude Code), so `nudge-approve.js` could serve it, but it would need: an `?agent=codex` post, a `tool_use_id`
(Codex's payload documents none, so make up a fresh one per hook run, as the Claude hook already does for Claude
Code 2.1.280; never derive it from the request, or a repeated command reuses the first answer), a `timeout` of 600
on the hook entry, the adapter marking
those events `approvable`, and testing against a real Codex to confirm the decision is honoured. Gemini's
`Notification` hook is observe-only and cannot approve; that would need its `BeforeTool` hook instead.

## What gets shown

| Event | Trigger | Bubble | Auto-dismiss |
| --- | --- | --- | --- |
| question | `AskUserQuestion` tool call, `agent_needs_input` | Question text plus the option labels | Never |
| permission | `permission_prompt` notification | Permission message | Never |
| done | `Stop` hook, `agent_completed` | Claude's last message (expandable) | After 20s (configurable) |
| idle | `idle_prompt` notification (60s of waiting) | Waiting message | After 20s; off by default |

Nudge appears on the active tab and follows you: switch tabs or windows and it re-appears there with
the same countdown. Dismissing it in one tab clears it everywhere. Answering in the terminal (which fires
`PostToolUse` or `UserPromptSubmit`, or, for a permission or question the approval hook was waiting on, ends that
hook: a Deny fires no `PostToolUse`, so the relay watches for the hook going away) resolves it everywhere, also
in a browser that was disconnected at the time (the relay tells it on reconnect). If a tab can't run content scripts
(`chrome://` pages, the Web Store), a system notification is used instead. Press Esc, click **Got it**,
or click Nudge to dismiss.

## Escalation

For questions and permissions, Claude is blocked until you act, so Nudge gets progressively harder to
ignore. The clock only runs while Chrome is the focused app; time in the terminal doesn't count.

| Level | After (default) | Nudge |
| --- | --- | --- |
| 0 | 0s | Corner wave, green antenna light |
| 1 | 15s | Walks to bottom-center, waves harder, hint shows how long you've kept Claude waiting |
| 2 | 30s | Grows 1.8x, annoyed face, foot tapping, red light, bubble turns red and shakes once |
| 3 | 60s | Short alarm (at most once a minute), hops and roams along the bottom edge |

Modes: **Off**, **Gentle** (levels 1 and 2), **Full chaos** (adds level 3). From level 1 the bubble
has a **Snooze** button (5 minutes by default). "Done" nudges never escalate. A "done" from another
session never replaces a blocking question; it becomes a system notification.

Nudge never blocks the page: only the bubble and the mascot catch clicks. Sound needs you to have
interacted with the page since it loaded (Chrome's autoplay policy); the visual tiers don't depend on it.

## Multi-session view

Run several Claude Code sessions and more than one can be blocked at once. Each session keeps its own nudge
with its own escalation clock, snooze and dismiss. When two or more are waiting, the bubble gets a row of
pills above the message: project name, a dot for the kind (gold question, amber permission) and how long
Claude has waited there. Tap a pill to see that session's nudge and answer it; the pill turns red once that
session reaches level 2. The mascot's level follows the most urgent session, so switching pills never calms
it down. Answering, dismissing or snoozing one session's nudge brings up the next; with a single session there
are no pills. Preview: `npx nudge-mascot test multi`, or **3 sessions** in the popup.

## Reply from the bubble

`npx nudge-mascot setup` installs the approval hooks (`PermissionRequest`, and `PreToolUse` on
`AskUserQuestion`, both with Claude Code's 600 s hook timeout), so you can answer Claude without going back
to the terminal. Installs from before this change get them on the next `setup`, or from `npx nudge-mascot pair`.

A permission shows **Allow** and **Deny**; a question shows its choices as buttons, grouped under each
question. One question answers on tap; several questions, or a multi-select one, take your picks and a **Send answers** button. The bubble says "Sent to Claude" and
goes away everywhere, and a paired phone marks it answered too. Answer on the phone instead and the bubble
says "Answered on your phone". The terminal prompt still works either way; answer there and the bubble goes away,
or, if you tap it in the same moment, it says "Answered in the terminal". With several questions, the relay
only accepts an answer for every one of them. Without the approval hook, permissions show "Answer in the
terminal"; without its `PreToolUse` half, questions show their choices as labels only and the hook doesn't wait. Try it with **Preview nudge** or the popup's test buttons
(`npx nudge-mascot test approve`, `test question`, `test questions`).

The approval hook only waits when something can answer: the relay tells it whether the extension is
connected or a phone is paired. With Chrome closed (or the extension off, or the relay down) and no phone,
it returns at once and the terminal prompt appears immediately, exactly as without Nudge. `npx nudge-mascot
unpair` keeps the approval hooks for the bubble; `uninstall` removes them.

## Jump back

Every nudge has a **Jump to terminal** button that brings the app running that Claude Code session to the
front. The hooks read where they run from the environment Claude Code passes them (no extra processes, so
they stay instant): `TERM_PROGRAM`, `ITERM_SESSION_ID` / `TERM_SESSION_ID`, macOS's `__CFBundleIdentifier`
(tells VS Code from Cursor and other forks), `TMUX` / `TMUX_PANE` and X11's `WINDOWID`. The relay keeps the
latest per session in memory.

- **macOS**: `osascript -e 'tell application id "…" to activate'`, falling back to `open -b`. iTerm2 also
  selects the exact window, tab and split by its session id. Terminal, VS Code, Cursor, Warp, Ghostty,
  WezTerm, kitty, Hyper, Tabby and Zed are known by name; anything else is activated by the app that
  launched the shell, or by `TERM_PROGRAM`. Inside tmux, Nudge also switches tmux to the session's pane.
  The first jump may ask you to let Node control the app (System Settings > Privacy & Security >
  Automation); activating still works without it.
- **Linux**: `wmctrl` or `xdotool`, by window id when the terminal exports `WINDOWID`, else by window class.
  Without either tool the bubble says to install one.
- A session whose terminal Nudge can't tell (started before you updated, or in a bare tmux with no app
  around it) gets a message in the bubble instead.

For a "done" nudge the bubble goes away once you jump; a question or permission stays until you answer it.
Restart running Claude Code sessions after updating so their hooks report the terminal. Preview:
`npx nudge-mascot test jump` (switches back to the terminal you ran it in), `test jump-unknown`, or
**Jump back** in the popup (uses Terminal unless a CLI test told it otherwise).

## Waiting stats

The relay times every question and permission from the moment it's shown until it's answered in the terminal,
the bubble or the phone, or dismissed, and appends one line per wait to `~/.claude-nudge/stats.jsonl`
(start, end, kind, project, agent, how it was answered; rotated to `stats.1.jsonl` at 5 MB). Test and preview
nudges don't count. The popup's **This week** card reads it: "Claude waited on you 47 min across 23 nudges",
the three projects that kept it waiting longest, and the change from the week before. **Share as image**
draws a 1200×630 PNG (the mascot, the number, the week's dates) in the popup and saves it to Downloads;
project names stay off it. Stats never leave your machine.

## Settings (extension popup)

Which event kinds to show, sound on/off, auto-dismiss seconds, corner position, relay port,
escalation mode, level timings, level-3 sound, snooze length, and **Connect** (shown when the relay asks for
the connection code). Change the port with
`CLAUDE_NUDGE_PORT=...` before `setup` and match it in the popup.

## Privacy

Everything stays on your machine. The relay binds to `127.0.0.1`, which every program and every user account on
the computer can reach, so it also wants a per-install secret: `setup` writes 32 random bytes to
`~/.claude-nudge/secret` (mode 0600, readable by you alone) and prints it as the connection code. The hooks and
the CLI read it from that file; the extension keeps the copy you paste in `chrome.storage.local` (this browser
profile only, not synced) and sends it as an `X-Nudge-Secret` header (on the WebSocket, as `?secret=`). Every
endpoint but `/health` requires it: without it the relay answers 401, so nothing else can read your Claude
messages, answer a permission, fake a nudge or switch apps through Jump back. An extension without the code
only learns that it needs one (a locked socket, and `/events` with the messages replaced by "(connect to see)").
The relay re-reads the file when a request fails, so a new code works without a restart; delete the file and
re-run `setup` to change it. Requests from web pages (`http(s)://` origins) are refused before that check. The
content script renders inside a closed shadow root and never reads the page. Messages are clipped to 1200 characters before leaving the relay. Waiting stats and the terminal
each session runs in stay on your machine (the stats in `~/.claude-nudge/stats.jsonl`, the terminal in the
relay's memory). No accounts, no analytics.
Full policy: [privacy.html](https://nudge-mascot.vercel.app/privacy).

## Project layout

| Path | What it is |
| --- | --- |
| `bin/nudge.js` | The CLI: `setup`, `start`, `status`, `test`, `uninstall`. |
| `hooks/nudge-hook.sh` | The hook every agent runs. Forwards the hook's JSON to the relay with curl (optional first argument: the agent, sent as `?agent=`), plus the terminal it runs in as `X-Nudge-*` headers. Fire-and-forget, 2s timeout, never blocks the agent. |
| `relay/server.js` | Zero-dependency Node relay with its own minimal WebSocket server. Picks the agent's adapter (`?agent=` on `/hook` and `/test`); holds decisions from the bubble or the phone for the approval hook. Endpoints for the extension: `/decision`, `/focus`, `/dismissed`, `/stats`, `/test`, `/pair/*`. |
| `hooks/nudge-opencode.js` | The OpenCode plugin `setup --agent opencode` installs: forwards OpenCode's bus events to `nudge-hook.sh opencode`. |
| `relay/adapters/` | One adapter per agent (`claude-code.js`, `codex.js`, `gemini.js`, `grok.js`, `cursor.js`, `opencode.js`) mapping its hook payloads to the shared event; `index.js` holds the shared state and helpers; `test.js` is part of `npm test`. |
| `scripts/install-test.js` | The rest of `npm test`: installs and removes each agent's hooks under a throwaway HOME, and runs the OpenCode plugin against a fake event bus. |
| `relay/focus.js` | Jump back: the terminal each session runs in, and the `osascript` / `open` / `wmctrl` / `xdotool` call that brings it forward. |
| `relay/stats.js` | Waiting stats: opens and closes waits, appends `stats.jsonl`, sums a week for `GET /stats`. |
| `relay/pairing.js` | Phone pairing (`cloud.json`) and the approval hooks in `settings.json`, shared by the relay and the CLI. |
| `relay/secret.js` | The per-install secret (`~/.claude-nudge/secret`) every client sends; minted by `setup`. |
| `hooks/nudge-approve.js` | Approval hook (installed by `setup`). Waits on the relay for Allow / Deny or the chosen answers and hands them to Claude Code; returns at once when nothing can answer. |
| `extension/` | Chrome extension (Manifest V3): service worker holds the WebSocket and one nudge per session (keyed by agent and session) with its escalation clock; content script draws the mascot, the bubble (with an agent badge for Codex / Gemini) and the session pills in a closed shadow root; popup has Connect (the code), settings, the week's stats and the share image. |
| `docs/` | Landing page and privacy policy (GitHub Pages). |
| `scripts/make-assets.js` | Renders the demo GIF/MP4, Web Store screenshots, and promo tile with headless Chrome and ffmpeg. |
| `scripts/pack-extension.sh` | Zips the extension for Web Store upload into `dist/`. |

## Development

```sh
git clone https://github.com/JayroldSoriano/nudge-mascot && cd nudge-mascot
node bin/nudge.js setup            # same as npx, from the checkout
npm test                           # agent adapter tests (no dependencies)
npm run icons                      # regenerate extension/icons
npm run assets                     # demo.gif, mp4s, store screenshots (needs Chrome + ffmpeg)
npm run pack                       # dist/nudge-<version>.zip
curl -s http://127.0.0.1:47831/health                                                # no code needed
curl -s -H "X-Nudge-Secret: $(cat ~/.claude-nudge/secret)" http://127.0.0.1:47831/events  # everything else
```

After editing the extension, click its **Reload** icon on `chrome://extensions`; a page reload is not enough.

## Roadmap

- Mascot and sound packs.
- Desktop apps reusing the same relay protocol. Firefox port.

## License

MIT. Independent project, not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code"
are trademarks of Anthropic.
