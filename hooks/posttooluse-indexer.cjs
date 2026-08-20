#!/usr/bin/env node
/**
 * PostToolUse hook: Universal auto-indexer for large tool output.
 *
 * Intercepts MCP tool output after execution. If output exceeds a byte threshold,
 * indexes it into the shared FTS5 knowledge base and replaces the output with
 * a compact summary + search instructions.
 *
 * NOTE: updatedMCPToolOutput only works for MCP tools (mcp__*).
 * Built-in tools (Bash, Read, Grep) are handled by PreToolUse guards instead.
 *
 * Shares the same SQLite DB as the MCP server via deterministic path.
 */

'use strict';

const THRESHOLD = parseInt(process.env.CONTEXT_MODE_THRESHOLD ?? '5120', 10);

try {
  const fs = require('fs');
  const { StringDecoder } = require('string_decoder');
  const { join, dirname } = require('path');
  const { tmpdir } = require('os');

  // Read stdin synchronously. A naive loop of buf.toString('utf8', 0, bytesRead)
  // would corrupt multi-byte UTF-8 sequences that straddle buffer boundaries,
  // replacing them with U+FFFD. StringDecoder buffers partial sequences across
  // chunk boundaries so the decoded text is byte-accurate.
  const decoder = new StringDecoder('utf8');
  let raw = '';
  const buf = Buffer.alloc(1024 * 1024); // 1MB buffer
  let bytesRead;
  while ((bytesRead = fs.readSync(0, buf, 0, buf.length, null)) > 0) {
    raw += decoder.write(buf.slice(0, bytesRead));
  }
  raw += decoder.end();
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
  // The MCP server creates context-mode-<its_pid>.db. The hook is a sibling of the
  // MCP server (both children of the Claude Code process). We need to find the MCP
  // server's PID so we write to the same DB that search() reads from.
  const hookDir = dirname(fs.realpathSync(process.argv[1] || __filename));
  const tmp = tmpdir();
  const claudePid = process.ppid;

  // Find the MCP server PID: it's a child of claudePid running context-mode/build/index.js
  let mcpPid = null;
  try {
    const { execFileSync } = require('child_process');
    // macOS-compatible: list all processes, filter by ppid + command
    const psOut = execFileSync('ps', ['-o', 'pid=,ppid=,command='], {
      timeout: 2000,
      encoding: 'utf8',
    });
    for (const line of psOut.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[0];
      const ppid = parts[1];
      const cmd = parts.slice(2).join(' ');
      if (ppid === String(claudePid) && cmd.includes('context-mode') && cmd.includes('build/index.js')) {
        mcpPid = parseInt(pid, 10);
        break;
      }
    }
  } catch { /* ps failed — no children or command not available */ }

  const dbPath = mcpPid
    ? join(tmp, `context-mode-${mcpPid}.db`)
    : join(tmp, `context-mode-${claudePid}.db`);

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
      indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      title, content, source_id UNINDEXED, content_type UNINDEXED,
      tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
      title, content, source_id UNINDEXED, content_type UNINDEXED,
      tokenize='trigram'
    );
    CREATE TABLE IF NOT EXISTS vocabulary (
      word TEXT PRIMARY KEY
    );
    CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
  `);

  // Create a descriptive source label
  const sourceLabel = `hook-${toolName.replace(/^mcp__/, '').slice(0, 40)}`;
  const deleteChunks = db.prepare(
    "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)"
  );
  const deleteChunksTrigram = db.prepare(
    "DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?)"
  );
  const deleteSources = db.prepare(
    "DELETE FROM sources WHERE label = ?"
  );
  const insertSource = db.prepare(
    "INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?, ?, 0)"
  );
  // Explicit-rowid inserts: chunks and chunks_trigram must share identical
  // rowids so a chunk_id returned by a trigram search resolves correctly in
  // the MCP server's getChunkById (which reads the porter table). Autoincrement
  // alone can let the two FTS5 tables drift apart after deletes.
  const insertChunk = db.prepare(
    "INSERT INTO chunks (rowid, title, content, source_id, content_type) VALUES (?, ?, ?, ?, 'prose')"
  );
  const insertChunkTrigram = db.prepare(
    "INSERT INTO chunks_trigram (rowid, title, content, source_id, content_type) VALUES (?, ?, ?, ?, 'prose')"
  );
  const nextPorter = db.prepare("SELECT MAX(rowid) AS m FROM chunks");
  const nextTrigram = db.prepare("SELECT MAX(rowid) AS m FROM chunks_trigram");

  const transaction = db.transaction(() => {
    deleteChunks.run(sourceLabel);
    deleteChunksTrigram.run(sourceLabel);
    deleteSources.run(sourceLabel);
    const info = insertSource.run(sourceLabel, chunks.length);
    const sourceId = Number(info.lastInsertRowid);
    let nextRowid = Math.max(
      Number(nextPorter.get().m ?? 0),
      Number(nextTrigram.get().m ?? 0),
    );
    for (const chunk of chunks) {
      nextRowid++;
      insertChunk.run(nextRowid, chunk.title, chunk.content, sourceId);
      insertChunkTrigram.run(nextRowid, chunk.title, chunk.content, sourceId);
    }
  });
  transaction();
  db.close();

  const sizeKB = (byteSize / 1024).toFixed(1);
  const footer = [
    `[Output also indexed] ${toolName}: ${sizeKB}KB → ${chunks.length} sections in FTS5.`,
    `Use search(queries: [...], source: "${sourceLabel}") to retrieve more detail.`,
  ].join('\n');

  // Preserve the tool's own curated output (execute's stdout, batch_execute's
  // inline search results, etc.) and APPEND the index pointer as a footer.
  // Replacing the output here silently swallowed content the tool already
  // returned — including batch_execute's query results — which was the bug.
  const combined = `${text}\n\n---\n${footer}`;

  // updatedMCPToolOutput only works for MCP tools (mcp__*)
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedMCPToolOutput: combined,
    },
  }));
} catch {
  // On error, pass through unchanged
  process.exit(0);
}
