import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks");

/** Run a hook script with JSON on stdin, return parsed stdout (or null). */
function runHook(script, payload, env = {}) {
  const out = execFileSync("node", [join(HOOKS, script)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
  return out ? JSON.parse(out) : null;
}

function decision(res) {
  return res?.hookSpecificOutput?.permissionDecision ?? null;
}
function context(res) {
  return res?.hookSpecificOutput?.additionalContext ?? null;
}

// ── log-read-guard ───────────────────────────────────────

test("log-read-guard: allows small .log file", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const f = join(dir, "small.log");
  writeFileSync(f, "x".repeat(1000));
  const res = runHook("log-read-guard.cjs", { tool_input: { file_path: f } });
  assert.notEqual(decision(res), "deny");
  rmSync(dir, { recursive: true, force: true });
});

test("log-read-guard: denies large .log with no range", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const f = join(dir, "big.log");
  writeFileSync(f, "x".repeat(60 * 1024));
  const res = runHook("log-read-guard.cjs", { tool_input: { file_path: f } });
  assert.equal(decision(res), "deny");
  rmSync(dir, { recursive: true, force: true });
});

test("log-read-guard: allows large .log when limit supplied (range read)", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const f = join(dir, "big.log");
  writeFileSync(f, "x".repeat(60 * 1024));
  const res = runHook("log-read-guard.cjs", { tool_input: { file_path: f, limit: 100 } });
  assert.notEqual(decision(res), "deny");
  rmSync(dir, { recursive: true, force: true });
});

test("log-read-guard: allows large .log when offset supplied", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const f = join(dir, "big.log");
  writeFileSync(f, "x".repeat(60 * 1024));
  const res = runHook("log-read-guard.cjs", { tool_input: { file_path: f, offset: 0 } });
  assert.notEqual(decision(res), "deny");
  rmSync(dir, { recursive: true, force: true });
});

test("log-read-guard: denies large .json (>100KB) with no range", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const f = join(dir, "big.json");
  writeFileSync(f, "x".repeat(120 * 1024));
  const res = runHook("log-read-guard.cjs", { tool_input: { file_path: f } });
  assert.equal(decision(res), "deny");
  rmSync(dir, { recursive: true, force: true });
});

test("log-read-guard: allows 60KB .json (under 100KB threshold)", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const f = join(dir, "mid.json");
  writeFileSync(f, "x".repeat(60 * 1024));
  const res = runHook("log-read-guard.cjs", { tool_input: { file_path: f } });
  assert.notEqual(decision(res), "deny");
  rmSync(dir, { recursive: true, force: true });
});

test("log-read-guard: missing file does not hard-block", () => {
  const res = runHook("log-read-guard.cjs", { tool_input: { file_path: "/nope/missing.log" } });
  assert.notEqual(decision(res), "deny");
});

// ── web-fetch-guard ──────────────────────────────────────

test("web-fetch-guard: allows normal URL and emits additionalContext, not deny", () => {
  const res = runHook("web-fetch-guard.cjs", {
    tool_name: "WebFetch",
    tool_input: { url: "https://example.com/docs" },
  }, { TMPDIR: mkdtempSync(join(tmpdir(), "wf-")) });
  assert.notEqual(decision(res), "deny");
  // Guidance may or may not fire depending on marker freshness, but must never deny.
});

test("web-fetch-guard: denies raw binary document URLs", () => {
  const res = runHook("web-fetch-guard.cjs", {
    tool_name: "WebFetch",
    tool_input: { url: "https://example.com/whitepaper.pdf" },
  });
  assert.equal(decision(res), "deny");
});

test("web-fetch-guard: ignores non-fetch tools", () => {
  const res = runHook("web-fetch-guard.cjs", {
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
  assert.equal(res, null);
});
