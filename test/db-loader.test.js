import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { loadDatabase, ensureSchema, SCHEMA } = require("../hooks/db-loader.cjs");

test("db-loader: loadDatabase creates the shared FTS5 schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "dbloader-"));
  const p = join(dir, "shared.db");
  const db = loadDatabase(p, { timeoutMs: 1000 });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all()
      .map((r) => r.name);
    for (const t of ["sources", "chunks", "chunks_trigram", "vocabulary"]) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
    // Insert/read round-trip through the FTS5 table.
    db.prepare("INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?,1,0)").run("t");
    const id = db.prepare("SELECT id FROM sources WHERE label='t'").get().id;
    db.prepare("INSERT INTO chunks (title, content, source_id, content_type) VALUES (?,?,?,'prose')").run("h", "hello world", id);
    const hit = db.prepare("SELECT content FROM chunks WHERE chunks MATCH ?").all("hello");
    assert.equal(hit.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("db-loader: ensureSchema is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "dbloader-"));
  const p = join(dir, "s.db");
  const db = loadDatabase(p, { timeoutMs: 1000 });
  try {
    ensureSchema(db);
    ensureSchema(db); // must not throw on re-run
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("db-loader: SCHEMA matches ContentStore's tokenizer choices", () => {
  assert.ok(SCHEMA.includes("porter unicode61"));
  assert.ok(SCHEMA.includes("tokenize='trigram'"));
});
