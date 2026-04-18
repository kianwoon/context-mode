#!/usr/bin/env node
/**
 * PreToolUse Guard: Block raw HTML dumps from WebFetch/webReader
 *
 * Matcher: WebFetch|webReader
 * Trigger: PreToolUse
 * Latency: ~1ms (single JSON parse + string check)
 *
 * Blocks WebFetch and webReader — raw HTML floods context (5K-50K+ tokens).
 * Redirects to fetch_and_index which indexes to FTS5 instead.
 * WebSearch is allowed — returns compact snippets, not raw HTML.
 */

'use strict';

try {
  const fs = require('fs');

  const raw = fs.readFileSync('/dev/stdin', 'utf8').trim();
  if (!raw) process.exit(0);

  const input = JSON.parse(raw);
  const toolName = input.tool_name ?? '';

  const BLOCKED = ['WebFetch', 'webReader', 'mcp__web_reader__webReader'];
  if (!BLOCKED.includes(toolName)) process.exit(0);

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Use fetch_and_index instead of ${toolName}.`
    }
  }));
  process.exit(0);
} catch {
  process.exit(0);
}
