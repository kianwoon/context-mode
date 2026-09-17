import test from "node:test";
import assert from "node:assert/strict";
import {
  truncateJSON,
  escapeXML,
  capBytes,
} from "../src/truncate.ts";

// ── capBytes ─────────────────────────────────────────────

test("capBytes: returns input unchanged when within budget", () => {
  assert.equal(capBytes("hello", 32), "hello");
});

test("capBytes: never exceeds maxBytes", () => {
  const s = "x".repeat(1000);
  const out = capBytes(s, 40);
  assert.ok(Buffer.byteLength(out) <= 40, `got ${Buffer.byteLength(out)}`);
  assert.ok(out.endsWith("..."));
});

test("capBytes: byte-safe on multi-byte characters (no lone surrogates)", () => {
  // Emoji are 4 UTF-8 bytes / 2 UTF-16 code units each.
  const s = "😀".repeat(50);
  for (const max of [1, 3, 4, 5, 7, 9, 33, 100]) {
    const out = capBytes(s, max);
    assert.ok(Buffer.byteLength(out) <= max, `max=${max} got ${Buffer.byteLength(out)}`);
    // No U+FFFD replacement char / dangling surrogate.
    assert.ok(!out.includes("\uFFFD"), `replacement char at max=${max}`);
    assert.equal(Buffer.from(out, "utf8").toString("utf8"), out);
  }
});

test("capBytes: degenerate budget truncates the marker itself", () => {
  const out = capBytes("abcdef", 2);
  assert.ok(Buffer.byteLength(out) <= 2);
});

// ── truncateJSON ─────────────────────────────────────────

test("truncateJSON: compact output fits budget", () => {
  const out = truncateJSON({ a: 1 }, 100);
  assert.equal(out, '{\n  "a": 1\n}');
});

test("truncateJSON: adds truncation marker and respects budget", () => {
  const big = { items: Array.from({ length: 200 }, (_, i) => `item-${i}`) };
  const out = truncateJSON(big, 64);
  assert.ok(Buffer.byteLength(out) <= 64);
  assert.ok(out.includes("truncated"));
});

test("truncateJSON: byte-safe for surrogate pairs", () => {
  const big = { s: "🎉".repeat(100) };
  const out = truncateJSON(big, 30);
  assert.ok(Buffer.byteLength(out) <= 30);
  assert.ok(!out.includes("\uFFFD"));
});

// ── escapeXML ────────────────────────────────────────────

test("escapeXML: escapes all five reserved characters", () => {
  assert.equal(
    escapeXML(`<a href="x">&'`),
    "&lt;a href=&quot;x&quot;&gt;&amp;&apos;",
  );
});

test("escapeXML: escapes ampersand before other entities", () => {
  assert.equal(escapeXML("&lt;"), "&amp;lt;");
});

test("escapeXML: passes plain text through unchanged", () => {
  assert.equal(escapeXML("plain text 123"), "plain text 123");
});
