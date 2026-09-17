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
  const { tmpdir } = require('os');
  const { resolveDbPath } = require('./db-path.cjs');
  const { loadDatabase } = require('./db-loader.cjs');

  // Read stdin synchronously from fd 0 (Windows-safe; not /dev/stdin).
  // readFileSync with 'utf8' decodes the whole buffer in one pass, so
  // multi-byte UTF-8 sequences straddling the 1MB read boundary cannot be
  // corrupted into U+FFFD (the bug a manual readSync loop hit).
  const raw = fs.readFileSync(0, 'utf8').trim();
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

  // Above threshold — index into FTS5 via direct SQLite access.
  // The MCP server and this hook share one DB, resolved deterministically by
  // hooks/db-path.cjs (CONTEXT_MODE_DB → live session DB → tmp fallback).
  const tmp = tmpdir();
  const dbPath = resolveDbPath(process.env, tmp, process.pid);

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

  // Open the shared DB (driver fallback chain + schema live in db-loader.cjs).
  const db = loadDatabase(dbPath, { timeoutMs: 5000 });

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
