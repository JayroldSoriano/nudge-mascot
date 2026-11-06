'use strict';
// How a Nudge hook command is written into an agent's config, per platform. Zero dependencies.
//   macOS/Linux: the script, quoted so a HOME with spaces works ("…/nudge-hook.sh" codex); a .js script runs through
//     the absolute path of the node that ran setup ("/usr/local/bin/node" "…/nudge-approve.js").
//   Windows: node "C:/Users/me/.claude-nudge/nudge-hook.js" codex. Bare `node`, forward slashes, quoted path: the one
//     form that runs the same in every shell the agents use there. Claude Code runs hooks in Git Bash, or PowerShell
//     when Git Bash is missing (code.claude.com/docs/en/hooks, `shell` field); Cursor's desktop app runs them through
//     PowerShell (cursor.com/docs/hooks); Codex documents Windows hooks without naming a shell
//     (learn.chatgpt.com/docs/hooks, `command_windows`); Gemini CLI and Grok Build don't say. A quoted exe path is only
//     a string in PowerShell (it would need `&`, which is a background job in bash), and Git Bash eats backslashes.
function hookCommand(script, args = [], platform = process.platform) {
  const tail = args.length ? ` ${args.join(' ')}` : '';
  if (platform === 'win32') return `node "${script.replace(/\\/g, '/')}"${tail}`;
  return `${script.endsWith('.js') ? `"${process.execPath}" ` : ''}"${script}"${tail}`;
}

module.exports = { hookCommand };
