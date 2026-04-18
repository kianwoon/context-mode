#!/usr/bin/env node
/**
 * PostToolUse hook: Universal auto-indexer for large tool output.
 *
 * Intercepts ALL tool output after execution. If output exceeds a byte threshold,
 * indexes it into the shared FTS5 knowledge base and replaces the output with
 * a compact summary + search instructions.
 *
 * This replaces PreToolUse guards for Bash/Read — instead of guessing which
 * commands/files produce large output, we check the ACTUAL output size.
 *
 * Uses updatedMCPToolOutput to replace what Claude sees in context.
 * Shares the same SQLite DB as the MCP server via deterministic path.
 */

'use strict';

const THRESHOLD = parseInt(process.env.CONTEXT_MODE_THRESHOLD ?? '5120', 10);

try {
  const fs = require('fs');
  const { join, dirname } = require('path');
  const { tmpdir } = require('os');

  // Read stdin synchronously
  let raw = '';
  const buf = Buffer.alloc(1024 * 1024); // 1MB buffer
  let bytesRead;
  while ((bytesRead = fs.readSync(0, buf, 0, buf.length, null)) > 0) {
    raw += buf.toString('utf8', 0, bytesRead);
  }
  raw = raw.trim();
  if (!raw) process.exit(0);

  const input = JSON.parse(raw);
  const toolName = input.tool_name ?? '';
  const toolResponse = input.tool_response;

  // Extract text from tool response
  let text;
  if (typeof toolResponse === 'string') {
    text = toolResponse;
  } else if (toolResponse && typeof toolResponse === 'object') {
    if (Array.isArray(toolResponse.content)) {
      text = toolResponse.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    } else if (typeof toolResponse.text === 'string') {
      text = toolResponse.text;
    } else {
      text = JSON.stringify(toolResponse, null, 2);
    }
  } else {
    text = String(toolResponse ?? '');
  }

  const byteSize = Buffer.byteLength(text, 'utf-8');

  // Below threshold — pass through unchanged
  if (byteSize < THRESHOLD) process.exit(0);

  // Above threshold — index into FTS5 via direct SQLite access
  const parentPid = process.ppid;
  const hookDir = dirname(fs.realpathSync(process.argv[1] || __filename));
  const dbPath = join(tmpdir(), `context-mode-${parentPid}.db`);

  // Simple line-based chunking
  const lines = text.split('\n');
  const linesPerChunk = 50;
  const overlap = 5;
  const step = Math.max(linesPerChunk - overlap, 1);
  const chunks = [];
  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + linesPerChunk);
    if (slice.length === 0) break;
    const firstLine = (slice[0] || '').trim().slice(0, 80);
    chunks.push({
      title: firstLine || `Lines ${i + 1}-${i + slice.length}`,
      content: slice.join('\n'),
    });
  }

  // Open DB and index
  let Database;
  try {
    Database = require(`${hookDir}/../node_modules/better-sqlite3`);
  } catch {
    Database = require('better-sqlite3');
  }

  const db = new Database(dbPath, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Ensure schema exists (same as ContentStore)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      code_chunk_count INTEGER NOT NULL DEFAULT 0,
      content_type TEXT NOT NULL DEFAULT 'text',
      indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      title, content, source_id UNINDEXED,
      tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
      title, content, source_id UNINDEXED,
      tokenize='trigram'
    );
    CREATE TABLE IF NOT EXISTS vocabulary (
      word TEXT PRIMARY KEY
    );
  `);

  // Create a descriptive source label
  const sourceLabel = `hook-${toolName.replace(/^mcp__/, '').slice(0, 40)}`;
  const insertSource = db.prepare(
    "INSERT INTO sources (label, chunk_count) VALUES (?, ?)"
  );
  const insertChunk = db.prepare(
    "INSERT INTO chunks (title, content, source_id) VALUES (?, ?, ?)"
  );
  const insertChunkTrigram = db.prepare(
    "INSERT INTO chunks_trigram (title, content, source_id) VALUES (?, ?, ?)"
  );

  const transaction = db.transaction(() => {
    const info = insertSource.run(sourceLabel, chunks.length);
    const sourceId = Number(info.lastInsertRowid);
    for (const chunk of chunks) {
      insertChunk.run(chunk.title, chunk.content, sourceId);
      insertChunkTrigram.run(chunk.title, chunk.content, sourceId);
    }
  });
  transaction();
  db.close();

  const sizeKB = (byteSize / 1024).toFixed(1);
  const summary = [
    `[Output indexed] ${toolName}: ${sizeKB}KB → ${chunks.length} sections in FTS5.`,
    `Use search(queries: [...], source: "${sourceLabel}") to retrieve details.`,
  ].join('\n');

  // updatedMCPToolOutput only works for MCP tools (mcp__*)
  // For built-in tools (Bash, Read, WebSearch), we just index silently
  const isMCPTool = toolName.startsWith('mcp__');

  if (isMCPTool) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedMCPToolOutput: summary,
      },
    }));
  } else {
    // For built-in tools, just exit 0 — original output passes through unchanged
    // Output is indexed but still goes into context (can't replace built-in tool output)
    process.exit(0);
  }
} catch {
  // On error, pass through unchanged
  process.exit(0);
}
