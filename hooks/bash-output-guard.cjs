#!/usr/bin/env node
/**
 * PreToolUse Guard: Block high-output Bash commands
 *
 * Matcher: Bash
 * Trigger: PreToolUse
 * Latency: ~2ms (single JSON parse + regex check)
 *
 * Strategy: warn-first, block-second
 *   - 1st violation: additionalContext (soft warning, tool still executes)
 *   - 2nd+ violation: permissionDecision "deny" (hard block)
 *
 * Blocks:
 *   - git log (without --oneline or -n limit or | head)
 *   - git diff (without --stat or file path)
 *   - git show (without --stat or --name-only)
 *   - git blame (always — line-by-line annotation)
 *   - git reflog (always — unbounded history)
 *   - git stash list (always — can grow indefinitely)
 *   - git branch -a (all branches)
 *   - find (broad searches without head or maxdepth)
 *
 * Guidance throttle: one-time additionalContext shown once per session,
 * re-fires after 5 minutes (GUIDANCE_TTL_MS).
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

  // ─── Session-scoped paths ─────────────────────────────────────
  const sessionDir = '/tmp/context-mode-guidance-' + process.ppid;
  const strikesFile = sessionDir + '/bash-strikes';
  const guidanceMarker = sessionDir + '/bash';

  // ─── Guidance TTL (5 minutes) ─────────────────────────────────
  var GUIDANCE_TTL_MS = 5 * 60 * 1000;

  // ─── Git Commands ─────────────────────────────────────────────

  // Commands piped to head are bounded — allow them
  var isPipedToHead = /\|\s*head\b/.test(command);

  // git log without --oneline or -n<N> limit or | head
  var isGitLog = /^git\s+log\b/.test(command) &&
    !/--oneline/.test(command) &&
    !/-n\s*\d/.test(command) &&
    !/--max-count/.test(command) &&
    !isPipedToHead;

  // git diff without --stat, --name-only, or --name-status
  var isGitDiff = /^git\s+diff\b/.test(command) &&
    !/--stat/.test(command) &&
    !/--name-only/.test(command) &&
    !/--name-status/.test(command);

  // git show without --stat or --name-only (full diff dump)
  var isGitShow = /^git\s+show\b/.test(command) &&
    !/--stat/.test(command) &&
    !/--name-only/.test(command) &&
    !/--name-status/.test(command);

  // git blame — line-by-line annotation, always dangerous
  var isGitBlame = /^git\s+blame\b/.test(command);

  // git reflog — unbounded history
  var isGitReflog = /^git\s+reflog\b/.test(command);

  // git stash list — can grow indefinitely
  var isGitStash = /^git\s+stash\s+list\b/.test(command);

  // git branch -a — all branches
  var isGitBranchAll = /^git\s+branch\b/.test(command) && /-a\b/.test(command);

  // find without head or maxdepth — broad file searches
  var isFind = /^(find|gfind)\s/.test(command) &&
    !/\|\s*head\b/.test(command) &&
    !/-maxdepth\b/.test(command);

  // ─── Check if any pattern matches ────────────────────────────
  var isBlocked = isGitLog || isGitDiff || isGitShow || isGitBlame ||
    isGitReflog || isGitStash || isGitBranchAll || isFind;

  if (!isBlocked) {
    // One-time guidance with expiry
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      var showGuidance = false;
      try {
        var stat = fs.statSync(guidanceMarker);
        if (Date.now() - stat.mtimeMs > GUIDANCE_TTL_MS) {
          fs.unlinkSync(guidanceMarker);
          showGuidance = true;
        }
      } catch (e) {
        showGuidance = true;
      }
      if (showGuidance) {
        var fd = fs.openSync(guidanceMarker, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        fs.closeSync(fd);
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext:
              "Bash is for git/mkdir/rm/mv/short commands only. For everything else:\n" +
              "- Research: batch_execute({commands: [{label, command}], queries: ['search terms']})\n" +
              "- Data: execute({language: 'shell', code: 'git log --oneline -20'}) or execute({language: 'javascript', code: '...'})\n" +
              "- Web: fetch_and_index({url, queries: ['terms']}) instead of WebFetch"
          }
        }));
      }
    } catch (e) {
      // Marker exists and not expired — already shown guidance
    }
    process.exit(0);
  }

  // ─── Build suggestion message ─────────────────────────────────
  var BT = '\x60'; // backtick character
  var blockedCmd, suggestion;

  if (isGitLog) {
    blockedCmd = 'git log';
    suggestion =
      "Use execute() instead:\n" +
      "```\nexecute({\n" +
      "  language: \"shell\",\n" +
      "  code: " + BT + "git log --oneline -20" + BT + "\n" +
      "})\n```\n" +
      "Or batch_execute() for multi-command research.";
  } else if (isGitDiff) {
    blockedCmd = 'git diff';
    suggestion =
      "Use execute() instead:\n" +
      "```\nexecute({\n" +
      "  language: \"shell\",\n" +
      "  code: " + BT + "git diff --stat" + BT + "\n" +
      "})\n```\n" +
      "Or batch_execute() to run and index results.";
  } else if (isGitShow) {
    blockedCmd = 'git show';
    suggestion =
      "Use execute() instead:\n" +
      "```\nexecute({\n" +
      "  language: \"shell\",\n" +
      "  code: " + BT + "git show --stat <SHA>" + BT + "\n" +
      "})\n```\n" +
      "Add --stat or --name-only to limit output.";
  } else if (isGitBlame) {
    blockedCmd = 'git blame';
    suggestion =
      "Use execute() instead with a scoped file:\n" +
      "```\nexecute({\n" +
      "  language: \"shell\",\n" +
      "  code: " + BT + "git blame --count src/utils.js" + BT + "\n" +
      "})\n```\n" +
      "Or process the file directly with execute() and parse it there.";
  } else if (isGitReflog) {
    blockedCmd = 'git reflog';
    suggestion =
      "Use execute() instead with a limit:\n" +
      "```\nexecute({\n" +
      "  language: \"shell\",\n" +
      "  code: " + BT + "git reflog -20" + BT + "\n" +
      "})\n```\n" +
      "Reflog is unbounded — always use -n<N> to limit entries.";
  } else if (isGitStash) {
    blockedCmd = 'git stash list';
    suggestion =
      "Use execute() instead:\n" +
      "```\nexecute({\n" +
      "  language: \"shell\",\n" +
      "  code: " + BT + "git stash list | head -20" + BT + "\n" +
      "})\n```\n" +
      "Or pipe through head to bound output.";
  } else if (isGitBranchAll) {
    blockedCmd = 'git branch -a';
    suggestion =
      "Use execute() instead:\n" +
      "```\nexecute({\n" +
      "  language: \"shell\",\n" +
      "  code: " + BT + "git branch -a | head -30" + BT + "\n" +
      "})\n```\n" +
      "Or use batch_execute() to run and index results.";
  } else {
    blockedCmd = 'find';
    suggestion =
      "Use execute() instead:\n" +
      "```\nexecute({\n" +
      "  language: \"shell\",\n" +
      "  code: " + BT + "find . -name \"*.js\" | head -20" + BT + "\n" +
      "})\n```\n" +
      "Or use the Glob tool for file pattern matching.";
  }

  // ─── Strike counter: warn first, block second ─────────────────
  fs.mkdirSync(sessionDir, { recursive: true });
  var strikes = 0;
  try {
    strikes = parseInt(fs.readFileSync(strikesFile, 'utf8'), 10) || 0;
  } catch (e) {}

  strikes++;
  fs.writeFileSync(strikesFile, String(strikes));

  if (strikes <= 1) {
    // First offense: soft warning — tool still executes
    console.error('[bash-output-guard] Strike ' + strikes + ' (warning): ' + blockedCmd + ': ' + command.slice(0, 80));
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "Do NOT run bare " + BT + blockedCmd + BT + " in Bash — raw output floods context window.\n" +
          suggestion +
          "\n\nThis is a WARNING. Next violation will be BLOCKED."
      }
    }));
    process.exit(0); // allow through this time
  }

  // Second+ offense: hard block
  console.error('[bash-output-guard] Strike ' + strikes + ' (blocked): ' + blockedCmd + ': ' + command.slice(0, 80));
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "Do NOT run bare " + BT + blockedCmd + BT + " in Bash — raw output floods context window.\n" +
        suggestion
    }
  }));
  process.exit(0);
} catch (e) {
  process.exit(0);
}
