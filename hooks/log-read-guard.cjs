#!/usr/bin/env node
/**
 * PreToolUse Guard: Block raw data dumps via Read
 *
 * Matcher: Read
 * Trigger: PreToolUse
 * Latency: ~2ms (single JSON parse + string check)
 *
 * Blocks Read on: .log, .csv, .xml, .sql, .json >100KB
 * Guidance: one-time additionalContext, re-fires after 5 minutes.
 */

'use strict';

try {
  const fs = require('fs');

  // Read JSON from stdin (hook input format)
  const raw = fs.readFileSync('/dev/stdin', 'utf8').trim();
  if (!raw) process.exit(0);

  const input = JSON.parse(raw);
  const filePath = input.tool_input?.file_path ?? '';

  // ─── Session-scoped paths ─────────────────────────────────────
  const sessionDir = `/tmp/context-mode-guidance-${process.ppid}`;
  const guidanceMarker = `${sessionDir}/read`;

  // ─── Guidance TTL (5 minutes) ─────────────────────────────────
  const GUIDANCE_TTL_MS = 5 * 60 * 1000;

  // Extensions to block
  const BLOCKED_EXTENSIONS = ['.log', '.csv', '.xml', '.sql'];
  const ext = filePath.toLowerCase();

  const isBlockedExt = BLOCKED_EXTENSIONS.some(e => ext.endsWith(e));
  const isLargeJson = ext.endsWith('.json') && (() => {
    try {
      const stat = fs.statSync(filePath);
      return stat.size > 100 * 1024; // 100KB
    } catch { return false; }
  })();

  if (!isBlockedExt && !isLargeJson) {
    // Guidance with expiry: show once, re-fire after GUIDANCE_TTL_MS
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      let showGuidance = false;
      try {
        const stat = fs.statSync(guidanceMarker);
        if (Date.now() - stat.mtimeMs > GUIDANCE_TTL_MS) {
          fs.unlinkSync(guidanceMarker);
          showGuidance = true;
        }
      } catch {
        showGuidance = true;
      }
      if (showGuidance) {
        const fd = fs.openSync(guidanceMarker, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        fs.closeSync(fd);
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext:
              "Read is ONLY for files you intend to Edit. For analysis/exploration:\n" +
              "- execute({language: 'javascript', code: 'const data = JSON.parse(fs.readFileSync(path)); console.log(Object.keys(data))'})\n" +
              "- execute({language: 'shell', code: 'head -50 file.log | grep ERROR'})\n" +
              "- batch_execute({commands: [{label:'file', command:'cat file.csv | head -20'}], queries: ['summary']})"
          }
        }));
      }
    } catch {
      // Marker exists and not expired — already shown guidance
    }
    process.exit(0);
  }

  const fileExt = filePath.split('.').pop().toUpperCase();
  const sizeHint = isLargeJson ? ' (large JSON)' : '';

  console.error(`[log-read-guard] Blocked Read on ${fileExt}${sizeHint} file: ${filePath}`);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Do NOT use Read on ${fileExt}${sizeHint} files — raw ${fileExt} output floods context window.\n` +
        `Use execute instead:\n` +
        "```\nexecute({\n" +
        `  language: "javascript",\n` +
        "  code: `\n" +
        "const fs = require('fs');\n" +
        `const data = JSON.parse(fs.readFileSync('${filePath}', 'utf8'));\n` +
        "// Process, filter, aggregate — console.log() only the answer\n" +
        "`\n" +
        "})\n```\n" +
        "Or use batch_execute for shell commands.\n" +
        "Read tool is ONLY for files you intend to Edit."
    }
  }));
  process.exit(0); // Exit 0 with JSON = deny
} catch {
  // Any error — allow the tool call
  process.exit(0);
}
