#!/usr/bin/env node
/**
 * db-loader — Shared SQLite loader + schema for context-mode hooks.
 *
 * Mirrors the runtime driver fallback chain in src/db-base.ts:
 *   Bun runtime        → bun:sqlite
 *   Node w/ node:sqlite → node:sqlite (built-in, Node >= 22.5)
 *   otherwise          → better-sqlite3 (native addon)
 *
 * Previously the PostToolUse indexer required better-sqlite3 unconditionally
 * (lines 114-117) and duplicated the FTS5 schema inline. Both now live here,
 * so a Bun- or node:sqlite-only install no longer breaks the indexer, and the
 * schema has one definition matching ContentStore.#initSchema().
 */

'use strict';

const path = require('path');

/**
 * Load the active SQLite driver.
 * Returns a constructor: new Database(path, opts) → db instance.
 */
function loadDriver() {
  // Bun
  if (typeof globalThis.Bun !== 'undefined') {
    try {
      // Array.join prevents bundlers from resolving this specifier.
      const { Database } = require(['bun', 'sqlite'].join(':'));
      return function BunDatabaseFactory(p, opts) {
        return new Database(p, { create: true, readonly: opts && opts.readonly });
      };
    } catch {
      /* fall through */
    }
  }

  // Node built-in node:sqlite (Node >= 22.5). DatabaseSync lacks
  // .pragma()/.transaction(), so wrap it like src/db-base.ts NodeSQLiteAdapter.
  try {
    const { DatabaseSync } = require('node:sqlite');
    return function NodeDatabaseFactory(p) {
      const raw = new DatabaseSync(p);
      return {
        pragma(source) {
          const rows = raw.prepare(`PRAGMA ${source}`).all();
          if (!rows || rows.length === 0) return undefined;
          if (rows.length > 1) return rows;
          const vals = Object.values(rows[0]);
          return vals.length === 1 ? vals[0] : rows[0];
        },
        exec(sql) { raw.exec(sql); return this; },
        prepare(sql) {
          const stmt = raw.prepare(sql);
          return {
            run: (...a) => stmt.run(...a),
            get: (...a) => { const r = stmt.get(...a); return r === null ? undefined : r; },
            all: (...a) => stmt.all(...a),
          };
        },
        transaction(fn) {
          return (...args) => {
            raw.exec('BEGIN');
            try { const r = fn(...args); raw.exec('COMMIT'); return r; }
            catch (e) { raw.exec('ROLLBACK'); throw e; }
          };
        },
        close() { raw.close(); },
      };
    };
  } catch {
    /* fall through */
  }

  // better-sqlite3 — local install first, then bare specifier
  try {
    return require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  } catch {
    return require('better-sqlite3');
  }
}

// ── Schema (must match ContentStore.#initSchema in src/store.ts) ──
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  code_chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  title,
  content,
  source_id UNINDEXED,
  content_type UNINDEXED,
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
  title,
  content,
  source_id UNINDEXED,
  content_type UNINDEXED,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS vocabulary (
  word TEXT PRIMARY KEY
);

CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
`;

/** Create the FTS5 schema on an open DB. Idempotent. */
function ensureSchema(db) {
  db.exec(SCHEMA);
}

/**
 * Open the shared DB at dbPath and ensure the schema exists.
 * Applies the same WAL pragmas as src/db-base.ts applyWALPragmas().
 *
 * @param {string} dbPath
 * @param {{ timeoutMs?: number, Database?: Function }} [opts]
 * @returns {any} open DB handle (caller must close)
 */
function loadDatabase(dbPath, opts) {
  opts = opts || {};
  const Database = opts.Database || loadDriver();
  const db = new Database(dbPath, opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined);
  try { db.pragma('journal_mode = WAL'); } catch { /* in-memory / unsupported */ }
  try { db.pragma('synchronous = NORMAL'); } catch { /* ignore */ }
  ensureSchema(db);
  return db;
}

module.exports = { loadDriver, ensureSchema, loadDatabase, SCHEMA };
