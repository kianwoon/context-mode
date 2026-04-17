#!/usr/bin/env node
/**
 * PreToolUse Guard: Block high-output Bash commands
 *
 * Matcher: Bash
 * Trigger: PreToolUse
 * Latency: ~2ms (single JSON parse + regex check)
 *
 * Blocks Bash commands that produce large/unbounded output:
 *   - git log (without --oneline or -n limit)
 *   - git diff (without --stat or file path)
 *   - git show (without --stat or --name-only)
 *   - git blame (always — line-by-line annotation)
 *   - git reflog (always — unbounded history)
 *   - git stash list (always — can grow indefinitely)
 *   - git branch -a (all branches)
 *   - find (broad searches without head or maxdepth)
 *
 * Redirects to execute() or batch_execute() with bounded alternatives.
 */

'use strict';

try {
  const fs = require('fs');

  const raw = fs.readFileSync('/dev/stdin', 'utf8').trim();
  if (!raw) process.exit(0);

  const input = JSON.parse(raw);
  const toolName = input.tool_name ?? '';
  if (toolName !== 'Bash') process.exit(0);

  const command = (input.tool_input?.command ?? '').trim();

  // ─── Git Commands ───────────────────────────────────────────────

  // git log without --oneline or -n<N> limit
  const isGitLog = /^git\s+log\b/.test(command) &&
    !/--oneline/.test(command) &&
    !/-n\s*\d/.test(command) &&
    !/--max-count/.test(command);

  // git diff without --stat, --name-only, or --name-status
  const isGitDiff = /^git\s+diff\b/.test(command) &&
    !/--stat/.test(command) &&
    !/--name-only/.test(command) &&
    !/--name-status/.test(command);

  // git show without --stat or --name-only (full diff dump)
  const isGitShow = /^git\s+show\b/.test(command) &&
    !/--stat/.test(command) &&
    !/--name-only/.test(command) &&
    !/--name-status/.test(command);

  // git blame — line-by-line annotation, always dangerous
  const isGitBlame = /^git\s+blame\b/.test(command);

  // git reflog — unbounded history, always dangerous
  const isGitReflog = /^git\s+reflog\b/.test(command);

  // git stash list — can grow indefinitely with many stashes
  const isGitStash = /^git\s+stash\s+(list|show|pop|apply)\b/.test(command) &&
    !/-n\s*\d/.test(command) &&
    !/--max-count/.test(command);

  // git branch -a (all remotes + locals) — can be very long
  const isGitBranchAll = /^git\s+branch\b/.test(command) &&
    /-a\b/.test(command);

  // ─── Shell Commands ────────────────────────────────────────────────

  // Broad find without head or maxdepth 1-2
  const isBroadFind = /^find\s+[^|]*\s(-name|-type|-path)\s/.test(command) &&
    !/head/.test(command) &&
    !/-maxdepth\s+[12]\b/.test(command);

  const isBlocked =
    isGitLog || isGitDiff || isGitShow || isGitBlame ||
    isGitReflog || isGitStash || isGitBranchAll || isBroadFind;

  if (!isBlocked) process.exit(0);

  // ─── Suggestions ───────────────────────────────────────────────────
  let blockedCmd, suggestion;

  if (isGitLog) {
    blockedCmd = 'git log';
    suggestion =
      `Use execute() instead:\n` +
      `\`\`\`\nexecute({\n` +
      `  language: "shell",\n` +
      `  code: \`git log --oneline -20\`\n` +
      `})\n\`\`\`\n` +
      `Or batch_execute() for multi-command research.`;
  } else if (isGitDiff) {
    blockedCmd = 'git diff';
    suggestion =
      `Use execute() instead:\n` +
      `\`\`\`\nexecute({\n` +
      `  language: "shell",\n` +
      `  code: \`git diff --stat\`\n` +
      `})\n\`\`\`\n` +
      `Or batch_execute() to run and index results.`;
  } else if (isGitShow) {
    blockedCmd = 'git show';
    suggestion =
      `Use execute() instead:\n` +
      `\`\`\`\nexecute({\n` +
      `  language: "shell",\n` +
      `  code: \`git show --stat <SHA>\`\n` +
      `})\n\`\`\`\n` +
      `Add --stat or --name-only to limit output.`;
  } else if (isGitBlame) {
    blockedCmd = 'git blame';
    suggestion =
      `Use execute() instead with a scoped file:\n` +
      `\`\`\`\nexecute({\n` +
      `  language: "shell",\n` +
      `  code: \`git blame --count src/utils.js\`\n` +
      `})\n\`\`\`\n` +
      `Or process the file directly with execute() and parse it there.`;
  } else if (isGitReflog) {
    blockedCmd = 'git reflog';
    suggestion =
      `Use execute() instead with a limit:\n` +
      `\`\`\`\nexecute({\n` +
      `  language: "shell",\n` +
      `  code: \`git reflog -20\`\n` +
      `})\n\`\`\`\n` +
      `Reflog is unbounded — always use -n<N> to limit entries.`;
  } else if (isGitStash) {
    blockedCmd = 'git stash list';
    suggestion =
      `Use execute() instead:\n` +
      `\`\`\`\nexecute({\n` +
      `  language: "shell",\n` +
      `  code: \`git stash list | head -20\`\n` +
      `})\n\`\`\`\n` +
      `Or pipe through head to bound output.`;
  } else if (isGitBranchAll) {
    blockedCmd = 'git branch -a';
    suggestion =
      `Use execute() instead:\n` +
      `\`\`\`\nexecute({\n` +
      `  language: "shell",\n` +
      `  code: \`git branch -a | head -30\`\n` +
      `})\n\`\`\`\n` +
      `Or use batch_execute() to run and index results.`;
  } else {
    blockedCmd = 'find';
    suggestion =
      `Use execute() instead:\n` +
      `\`\`\`\nexecute({\n` +
      `  language: "shell",\n` +
      `  code: \`find . -name "*.js" | head -20\`\n` +
      `})\n\`\`\`\n` +
      `Or use the Glob tool for file pattern matching.`;
  }

  console.error(`[bash-output-guard] Blocked ${blockedCmd}: ${command.slice(0, 80)}`);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Do NOT run bare \`${blockedCmd}\` in Bash — raw output floods context window.\n` +
        suggestion
    }
  }));
  process.exit(0);
} catch {
  process.exit(0);
}
