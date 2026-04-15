#!/usr/bin/env node
/**
 * PreToolUse Guard: Block raw data dumps via Read
 *
 * Matcher: Read
 * Trigger: PreToolUse
 * Latency: ~2ms (single JSON parse + string check)
 *
 * Blocks Read on: .log, .csv, .xml, .sql, .json >100KB
 *
 * Non-zero exit blocks the tool call.
 * stdout JSON is shown to Claude as guidance.
 */

'use strict';

try {
  const fs = require('fs');

  // Read JSON from stdin (hook input format)
  const raw = fs.readFileSync('/dev/stdin', 'utf8').trim();
  if (!raw) process.exit(0);

  const input = JSON.parse(raw);
  const filePath = input.tool_input?.file_path ?? '';

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

  if (!isBlockedExt && !isLargeJson) process.exit(0);

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
        `\`\`\`\nexecute({\n` +
        `  language: "javascript",\n` +
        `  code: \`\n` +
        `const fs = require('fs');\n` +
        `const data = JSON.parse(fs.readFileSync('${filePath}', 'utf8'));\n` +
        `// Process, filter, aggregate — console.log() only the answer\n` +
        `\`\n` +
        `})\n\`\`\`\n` +
        `Or use batch_execute for shell commands.\n` +
        `Read tool is ONLY for files you intend to Edit.`
    }
  }));
  process.exit(0); // Exit 0 with JSON = deny
} catch {
  // Any error — allow the tool call
  process.exit(0);
}
