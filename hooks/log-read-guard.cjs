#!/usr/bin/env node
/**
 * PreToolUse Guard: Advise / block raw data dumps via Read
 *
 * Matcher: Read
 * Trigger: PreToolUse
 * Latency: ~2ms (single JSON parse + stat + string check)
 *
 * Native Read now supports offset/limit range reads, so a ranged read of a
 * huge file is safe. This guard is limit-aware:
 *   - .log/.csv/.xml/.sql  → allow when the file is <50KB OR the call supplies
 *                            limit/offset; deny only when >50KB with no range.
 *   - .json                → same rule at a 100KB threshold.
 * Other reads are allowed (with one-time guidance, re-fires after 5 minutes).
 */

'use strict';

try {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  // Read stdin from fd 0 (Windows-safe; not /dev/stdin).
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw) process.exit(0);

  const input = JSON.parse(raw);
  const filePath = input.tool_input?.file_path ?? '';
  const toolInput = input.tool_input ?? {};

  // A ranged read (limit/offset supplied) is bounded → always safe.
  // Use loose != null so both undefined (absent) and null are treated as
  // "no range"; a strict !== null check would be true for undefined.
  const hasRange = toolInput.limit != null || toolInput.offset != null;

  const DATA_EXTENSIONS = ['.log', '.csv', '.xml', '.sql'];
  const DATA_THRESHOLD = 50 * 1024;   // 50KB
  const JSON_THRESHOLD = 100 * 1024;  // 100KB

  const lower = filePath.toLowerCase();
  const isDataExt = DATA_EXTENSIONS.some(e => lower.endsWith(e));
  const isJson = lower.endsWith('.json');

  let size = null;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    size = null; // unreadable/absent — never hard-block on stat failure
  }

  const threshold = isJson ? JSON_THRESHOLD : DATA_THRESHOLD;
  const overThreshold = size !== null && size > threshold;

  // Deny only: data-ish file, over threshold, and no bounded range requested.
  const shouldDeny = (isDataExt || isJson) && overThreshold && !hasRange;

  if (!shouldDeny) {
    // Allowed — one-time guidance (same throttle as before).
    const sessionDir = path.join(os.tmpdir(), `context-mode-guidance-${process.ppid}`);
    const guidanceMarker = path.join(sessionDir, 'read');
    const GUIDANCE_TTL_MS = 5 * 60 * 1000;
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
            hookEventName: 'PreToolUse',
            additionalContext:
              'Read is best for files you intend to Edit, or bounded ranges (offset/limit). For analysis/exploration:\n' +
              "- execute({language: 'javascript', code: 'const data = JSON.parse(fs.readFileSync(path)); console.log(Object.keys(data))'})\n" +
              "- execute({language: 'shell', code: 'head -50 file.log | grep ERROR'})\n" +
              "- batch_execute({commands: [{label:'file', command:'cat file.csv | head -20'}], queries: ['summary']})",
          },
        }));
      }
    } catch {
      // Marker exists and not expired — already shown guidance.
    }
    process.exit(0);
  }

  const fileExt = filePath.split('.').pop().toUpperCase();
  const sizeKB = (size / 1024).toFixed(0);
  console.error(`[log-read-guard] Blocked Read on ${sizeKB}KB ${fileExt} file: ${filePath}`);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Do NOT Read the whole ${fileExt} file (${sizeKB}KB) — it floods the context window.\n` +
        `Either add a bounded range (offset/limit), or use execute:\n` +
        '```\nexecute({\n' +
        '  language: "javascript",\n' +
        '  code: `\n' +
        "const fs = require('fs');\n" +
        `const data = fs.readFileSync('${filePath}', 'utf8').split('\\n').slice(0, 100);\n` +
        '// Process, filter, aggregate — console.log() only the answer\n' +
        '`\n' +
        '})\n```\n' +
        'Or use batch_execute for shell commands.',
    },
  }));
  process.exit(0); // Exit 0 with JSON = deny
} catch {
  // Any error — allow the tool call.
  process.exit(0);
}
