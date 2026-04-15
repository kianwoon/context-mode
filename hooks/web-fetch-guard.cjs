#!/usr/bin/env node
/**
 * PreToolUse Guard: Block WebFetch/webReader raw HTML dumps
 *
 * Matcher: WebFetch|webReader
 * Trigger: PreToolUse
 * Latency: ~1ms (single JSON parse + string check)
 *
 * Blocks WebFetch and webReader (MCP) tool calls.
 * Redirects to fetch_and_index which indexes to FTS5.
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

  // Extract URL from tool input
  const url = input.tool_input?.url ?? input.tool_input?.input?.url ?? '';

  console.error(`[web-fetch-guard] Blocked ${toolName} on: ${url || '(no url)'}`);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Do NOT use ${toolName} — raw HTML floods context window (5K-50K+ tokens).\n` +
        `Use fetch_and_index instead:\n` +
        `\`\`\`\nfetch_and_index({\n` +
        `  url: "${url}",\n` +
        `  queries: ["your search queries"]\n` +
        `})\n\`\`\`\n` +
        `fetch_and_index fetches the URL, converts HTML to markdown, indexes into FTS5, ` +
        `and returns a structured summary. Follow-up queries via search().`
    }
  }));
  process.exit(0);
} catch {
  process.exit(0);
}
