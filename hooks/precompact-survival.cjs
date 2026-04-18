#!/usr/bin/env node
/**
 * PreCompact Hook: Re-inject context-mode routing rules after compaction.
 *
 * Matcher: (none — fires on every compaction)
 * Trigger: PreCompact
 * Latency: ~1ms (static string output)
 *
 * After context compaction, Claude often forgets tool routing patterns.
 * This hook injects the core rules so they survive compaction.
 */

'use strict';

try {
  const survival = [
    '## context-mode — Context Window Conservation (active)',
    '',
    'This session has context-mode hooks installed. They auto-enforce these rules:',
    '',
    '- Bash = git/mkdir/rm/mv/short commands only. For research or data: use execute() or batch_execute().',
    '- Read = ONLY for files you intend to Edit. For analysis: use execute(language, code).',
    '- WebFetch/webReader = blocked. Use fetch_and_index() instead.',
    '- Large MCP tool output is auto-indexed to FTS5. Use search() to query it.',
  ].join('\n');

  process.stdout.write(JSON.stringify({ systemMessage: survival }) + '\n');
} catch {
  process.exit(0);
}
