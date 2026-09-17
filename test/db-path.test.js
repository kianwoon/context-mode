import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { resolveDbPath, discoverSessionDbs } = require("../hooks/db-path.cjs");

const TMP = "/tmp/cm-test";

// ── resolveDbPath: override ──────────────────────────────

test("resolveDbPath: CONTEXT_MODE_DB override wins", () => {
  const out = resolveDbPath({ CONTEXT_MODE_DB: "/custom/x.db" }, TMP, 123, {
    readdir: () => [],
    isAlive: () => false,
  });
  assert.equal(out, "/custom/x.db");
});

test("resolveDbPath: whitespace-only override ignored", () => {
  const out = resolveDbPath({ CONTEXT_MODE_DB: "   " }, TMP, 55, {
    readdir: () => [],
    isAlive: () => false,
  });
  assert.equal(out, join(TMP, "context-mode-55.db"));
});

test("resolveDbPath: unexpanded ${...} placeholder ignored", () => {
  const out = resolveDbPath({ CONTEXT_MODE_DB: "${TMPDIR}/context-mode-session.db" }, TMP, 55, {
    readdir: () => [],
    isAlive: () => false,
  });
  assert.equal(out, join(TMP, "context-mode-55.db"));
});

// ── resolveDbPath: discovery ─────────────────────────────

test("resolveDbPath: discovers a live session DB by PID", () => {
  // statSync is used on discovered files; inject via readdir of real files is
  // hard, so create real temp files.
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbpath-"));
  const own = process.pid;
  const livePid = process.pid + 1;
  fs.writeFileSync(path.join(tmp, `context-mode-${livePid}.db`), "");

  const out = resolveDbPath({}, tmp, own, {
    isAlive: (pid) => pid === livePid,
  });
  assert.equal(out, path.join(tmp, `context-mode-${livePid}.db`));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveDbPath: ignores dead PIDs and falls back to own path", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbpath-"));
  const own = process.pid;
  fs.writeFileSync(path.join(tmp, "context-mode-999999.db"), "");

  const out = resolveDbPath({}, tmp, own, { isAlive: () => false });
  assert.equal(out, path.join(tmp, `context-mode-${own}.db`));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── resolveDbPath: own-PID preference + ambiguity warning ─

test("resolveDbPath: own-PID DB preferred over newer live other-PID DB", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbpath-"));
  const own = process.pid;
  const otherPid = process.pid + 1;
  // other DB is written last → newest mtime, but own DB must still win.
  fs.writeFileSync(path.join(tmp, `context-mode-${own}.db`), "");
  fs.writeFileSync(path.join(tmp, `context-mode-${otherPid}.db`), "");

  const out = resolveDbPath({}, tmp, own, { isAlive: () => true });
  assert.equal(out, path.join(tmp, `context-mode-${own}.db`));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveDbPath: ambiguous multiple live candidates logs warning", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbpath-"));
  const own = process.pid + 100; // no own DB present
  fs.writeFileSync(path.join(tmp, `context-mode-${process.pid + 1}.db`), "");
  fs.writeFileSync(path.join(tmp, `context-mode-${process.pid + 2}.db`), "");

  let warned = "";
  const out = resolveDbPath({}, tmp, own, {
    isAlive: () => true,
    warn: (m) => { warned += m; },
  });
  assert.match(out, /context-mode-\d+\.db$/);
  assert.match(warned, /WARNING: 2 live session DBs/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveDbPath: single live candidate logs no warning", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbpath-"));
  const own = process.pid + 100;
  fs.writeFileSync(path.join(tmp, `context-mode-${process.pid + 1}.db`), "");

  let warned = "";
  resolveDbPath({}, tmp, own, { isAlive: () => true, warn: (m) => { warned += m; } });
  assert.equal(warned, "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveDbPath: no candidates at all → deterministic fallback", () => {
  const out = resolveDbPath({}, TMP, 4242, {
    readdir: () => { throw new Error("ENOENT"); },
    isAlive: () => false,
  });
  assert.equal(out, join(TMP, "context-mode-4242.db"));
});

test("discoverSessionDbs: parses only context-mode-<pid>.db names", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbpath-"));
  fs.writeFileSync(path.join(tmp, "context-mode-11.db"), "");
  fs.writeFileSync(path.join(tmp, "other-22.db"), "");
  fs.writeFileSync(path.join(tmp, "context-mode-abc.db"), "");

  const found = discoverSessionDbs(tmp);
  assert.equal(found.length, 1);
  assert.equal(found[0].owner, 11);
  fs.rmSync(tmp, { recursive: true, force: true });
});
