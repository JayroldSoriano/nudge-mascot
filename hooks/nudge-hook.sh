#!/bin/sh
# Nudge hook: forwards the coding agent's hook payload (stdin JSON) to the local relay.
# Optional first argument: the agent (codex, gemini, grok, cursor, opencode), sent as ?agent=... so the relay picks its adapter.
# No argument means Claude Code. Fire-and-forget: 2s timeout, never fails, so the agent is never blocked
# when the relay is down.
# The X-Nudge-* headers name the terminal this agent session runs in (read from the environment the hook
# inherits, no extra processes), so "Jump to terminal" in the bubble can switch back to it.
# X-Nudge-Secret is the per-install secret `setup` minted; the relay refuses hooks without it. Read with the shell's
# own `read` (no extra process); it returns non-zero at a missing final newline, hence the `|| true`.
PORT="${CLAUDE_NUDGE_PORT:-47831}"
SECRET=""
SECRET_FILE="${HOME:-}/.claude-nudge/secret"
if [ -r "$SECRET_FILE" ]; then IFS= read -r SECRET < "$SECRET_FILE" || true; fi
QUERY=""
case "${1:-}" in
  "" | *[!a-z0-9-]*) ;;
  *) QUERY="?agent=$1" ;;
esac
curl -s -m 2 -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Nudge-Secret: ${SECRET}" \
  -H "X-Nudge-Terminal: ${TERM_PROGRAM:-}" \
  -H "X-Nudge-Terminal-Session: ${ITERM_SESSION_ID:-${TERM_SESSION_ID:-}}" \
  -H "X-Nudge-Terminal-Bundle: ${__CFBundleIdentifier:-}" \
  -H "X-Nudge-Tmux: ${TMUX:-}" \
  -H "X-Nudge-Tmux-Pane: ${TMUX_PANE:-}" \
  -H "X-Nudge-Window: ${WINDOWID:-}" \
  --data-binary @- \
  "http://127.0.0.1:${PORT}/hook${QUERY}" >/dev/null 2>&1 || true
exit 0
