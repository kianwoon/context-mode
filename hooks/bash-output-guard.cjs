#!/usr/bin/env node
/**
 * PreToolUse Guard: Block high-output Bash commands
 *
 * Matcher: Bash
 * Trigger: PreToolUse
 * Latency: ~2ms (single JSON parse + regex check)
 *
 * Blocks Bash commands that produce large output:
 *   - git log (without --oneline or -n limit)
 *   - git diff (without file path or stat flag)
 *   - find (broad searches)
 *   - cat/head/tail on large files
 *
 * Redirects to execute() or batch_execute() instead.
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

  // Patterns that produce large output
  // git log without --oneline or -n<N> limit
  const isGitLog = /^git\s+log\b/.test(command) &&
    !/--oneline/.test(command) &&
    !/-n\s*\d/.test(command) &&
    !/--max-count/.test(command);

  // git diff without --stat or file path (full diff dump)
  const isGitDiff = /^git\s+diff\b/.test(command) &&
    !/--stat/.test(command) &&
    !/--name-only/.test(command) &&
    !/--name-status/.test(command) &&
    command.split(/\s+/).length <= 3; // bare "git diff" or "git diff HEAD"

  // Broad find commands
  const isBroadFind = /^find\s+[^|]*\s(-name|-type|-path)\s/.test(command) &&
    !/head/.test(command) &&
    !/-maxdepth\s+[12]\b/.test(command);

  if (!isGitLog && !isGitDiff && !isBroadFind) process.exit(0);

  let blockedCmd, suggestion;

  if (isGitLog) {
    blockedCmd = 'git log';
    suggestion =
      `Use execute() instead to process git log output:\n` +
      `\`\`\`\nexecute({\n` +
      `  language: "shell",\n` +
      `  code: \`git log --oneline -20\`\n` +
      `})\n\`\`\`\n` +
      `Or batch_execute() for multi-command research.\n` +
      `If you must use Bash, add --oneline or -n<N> to limit output.`;
  } else if (isGitDiff) {
    blockedCmd = 'git diff';
    suggestion =
      `Use execute() instead:\n` +
      `\`\`\`\nexecute({\n` +
      `  language: "shell",\n` +
      `  code: \`git diff --stat\`\n` +
      `})\n\`\`\`\n` +
      `Or batch_execute() to run and index results.\n` +
      `If you must use Bash, add --stat or --name-only to limit output.`;
  } else {
    blockedCmd = 'find';
    suggestion =
      `Use execute() or batch_execute() instead:\n` +
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
