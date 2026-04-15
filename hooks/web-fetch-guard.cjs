#!/usr/bin/env node
/**
 * PreToolUse Guard: Block WebFetch/webReader/WebSearch
 *
 * Matcher: WebFetch|webReader|WebSearch
 * Trigger: PreToolUse
 * Latency: ~1ms (single JSON parse + string check)
 *
 * Blocks WebFetch, webReader (MCP), and WebSearch tool calls.
 * WebFetch/webReader redirect to fetch_and_index.
 * WebSearch redirects to execute with curl/ddg for reliable results.
 */

'use strict';

try {
  const fs = require('fs');

  const raw = fs.readFileSync('/dev/stdin', 'utf8').trim();
  if (!raw) process.exit(0);

  const input = JSON.parse(raw);
  const toolName = input.tool_name ?? '';

  const BLOCKED = ['WebFetch', 'webReader', 'mcp__web_reader__webReader', 'WebSearch'];
  if (!BLOCKED.includes(toolName)) process.exit(0);

  const isWebSearch = toolName === 'WebSearch';

  if (isWebSearch) {
    const query = input.tool_input?.query ?? input.tool_input?.args?.query ?? '';
    console.error(`[web-fetch-guard] Blocked WebSearch for: ${query || '(no query)'}`);
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Do NOT use WebSearch — it's US-only and unreliable (often returns 0 results).\n` +
          `Use execute with curl/ddg instead:\n` +
          `\`\`\`\nexecute({\n` +
          `  language: "javascript",\n` +
          `  code: \`\n` +
          `const res = await fetch('https://api.duckduckgo.com/?q=${encodeURIComponent('${query}')}&format=json');\n` +
          `const data = await res.json();\n` +
          `// Process data — console.log() only the answer\n` +
          `\`\n` +
          `})\n\`\`\`\n` +
          `Or use batch_execute with curl/lynx for search results.`
      }
    }));
    process.exit(0);
  }

  // WebFetch/webReader handling
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
