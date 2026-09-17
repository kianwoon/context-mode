#!/usr/bin/env node
/**
 * PreToolUse Guard: Advise on WebFetch/webReader (warn-first)
 *
 * Matcher: WebFetch|webReader
 * Trigger: PreToolUse
 * Latency: ~1ms (single JSON parse + string check)
 *
 * Previously this BLOCKED all WebFetch/webReader calls. That was too blunt:
 * WebFetch already converts HTML→markdown, so many fetches are small and
 * harmless. Now we ALLOW the call and attach one-time additionalContext
 * guidance pointing at fetch_and_index for large pages. Only URLs that clearly
 * signal a big raw document (pdf/zip/archive/video, or an explicit
 * "large-doc" host hint) are denied.
 *
 * Guidance throttle: one-time per session via a marker file (5-min TTL).
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
  const toolName = input.tool_name ?? '';
  const MATCHED = ['WebFetch', 'webReader', 'mcp__web_reader__webReader'];
  if (!MATCHED.includes(toolName)) process.exit(0);

  const url = String(input.tool_input?.url ?? '');

  // Deny only clearly-large raw documents where markdown conversion is useless.
  const LARGE_DOC_RE = /\.(pdf|zip|tar|gz|tgz|bz2|xz|7z|rar|mp4|mov|avi|mkv|iso|dmg|exe|bin)(\?|#|$)/i;
  if (LARGE_DOC_RE.test(url)) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Raw binary/large document fetch (${url}) floods context. ` +
          `Use fetch_and_index({url, queries:[...]}) to index it to FTS5 instead.`,
      },
    }));
    process.exit(0);
  }

  // Otherwise allow — attach one-time guidance.
  const sessionDir = path.join(os.tmpdir(), `context-mode-guidance-${process.ppid}`);
  const guidanceMarker = path.join(sessionDir, 'webfetch');
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
            'WebFetch returns markdown — fine for small/structured pages. ' +
            'For large docs, chunked indexes, or repeated lookups, prefer:\n' +
            '- fetch_and_index({url, queries: ["terms"]}) — indexes to FTS5, returns evidence snippets\n' +
            '- then search({queries: [...]}) / get_chunk({chunkId}) to expand only what you need',
        },
      }));
    }
  } catch {
    // Marker exists and not expired — already shown guidance.
  }
  process.exit(0);
} catch {
  // Any error — allow the tool call.
  process.exit(0);
}
