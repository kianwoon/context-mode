#!/usr/bin/env node
/**
 * context-mode v2.5 — Lean MCP server
 *
 * Five tools: execute, batch_execute, search, get_chunk, fetch_and_index.
 * Four auto-enforcing hooks: bash-output-guard, log-read-guard,
 * web-fetch-guard (PreToolUse) and posttooluse-indexer (PostToolUse).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PolyglotExecutor } from "./executor.js";
import { ContentStore, cleanupStaleDBs } from "./store.js";
import { detectRuntimes, getAvailableLanguages } from "./runtime.js";
import type { Language } from "./runtime.js";
import { formatInventory, formatSearchMatch, type SearchOutputMode } from "./response.js";
import { truncateHeadTail } from "./truncate.js";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import TurndownService from "turndown";

// ── Setup ──────────────────────────────────────────────────

// Clean up stale DBs from dead/orphaned sessions before creating a new one
cleanupStaleDBs();

const runtimes = detectRuntimes();
const available = getAvailableLanguages(runtimes);
const executor = new PolyglotExecutor();
const store = new ContentStore(
  join(tmpdir(), `context-mode-${process.pid}.db`),
);

const server = new McpServer({
  name: "context-mode",
  version: "2.5.0",
});

// Prevent silent death
process.on("unhandledRejection", (err: unknown) => {
  process.stderr.write(`[context-mode] unhandledRejection: ${err}\n`);
});
process.on("uncaughtException", (err: Error) => {
  process.stderr.write(`[context-mode] uncaughtException: ${err?.message ?? err}\n`);
});

// Graceful shutdown: checkpoint WAL and reap backgrounded processes
process.on("exit", () => {
  try { store.close(); } catch { /* ignore */ }
  executor.cleanupBackgrounded();
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

// ── Helpers ────────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 50_000; // ~12K tokens — keeps responses lean

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

function coerceStringArray(val: unknown): string[] {
  if (typeof val === "string") {
    // Only JSON.parse if the string explicitly starts with '[' — otherwise
    // JSON.parse("123") → 123 (number), JSON.parse("true") → true (boolean),
    // JSON.parse("null") → null, all of which zod would reject as not string[].
    // The model sends a raw string like "hello world" when it means a single
    // query, and JSON.stringify([...]) when it means multiple.
    if (val.startsWith("[")) {
      try { return JSON.parse(val); } catch { return [val]; }
    }
    return [val];
  }
  return Array.isArray(val) ? val : [];
}

function shortSource(prefix: string, labels: string[]): string {
  const joined = labels.join(",");
  const digest = createHash("sha256").update(joined).digest("hex").slice(0, 10);
  const readable = labels
    .slice(0, 3)
    .map((l) => l.replace(/[^\w.-]+/g, "_").slice(0, 18))
    .filter(Boolean)
    .join(",");
  return `${prefix}:${readable || "batch"}:${digest}`;
}

// ── Tool 1: execute ────────────────────────────────────────

server.registerTool(
  "execute",
  {
    title: "Execute Code",
    description:
      `Sandboxed code execution. Only console.log() output enters context. ` +
      `Available languages: ${available.join(", ")}. ` +
      `PREFER THIS OVER BASH for: API calls, test runners, git queries, data processing. ` +
      `Think in Code — write code that does the work, console.log() only the answer.`,
    inputSchema: {
      language: z.enum(available as [string, ...string[]])
        .describe("Programming language"),
      code: z.string()
        .describe("Code to execute. Use console.log() to return results."),
      timeout: z.coerce.number().optional().default(30_000)
        .describe("Timeout in ms (default: 30000)"),
    },
  },
  async ({ language, code, timeout }) => {
    try {
      const result = await executor.execute({
        language: language as Language,
        code,
        timeout,
      });
      const output = result.exitCode === 0
        ? result.stdout || "(no output)"
        : `Exit code: ${result.exitCode}\n\n${result.stdout}${result.stderr ? `\n\nstderr:\n${result.stderr}` : ""}`;
      return textResult(truncateHeadTail(output, MAX_RESPONSE_BYTES, 0, 0));
    } catch (err) {
      return textResult(
        `Execution error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// ── Tool 2: batch_execute ──────────────────────────────────

server.registerTool(
  "batch_execute",
  {
    title: "Batch Execute & Search",
    description:
      `Run multiple shell commands in one call, auto-index output into FTS5 knowledge base. ` +
      `Returns search results for your queries — no follow-up needed. ` +
      `ONE call replaces 30+ individual execute calls + 10+ search calls.`,
    inputSchema: {
      commands: z.preprocess(
        (val: unknown) => {
          if (typeof val === "string") {
            try { return JSON.parse(val); } catch { return [{ label: "cmd", command: val }]; }
          }
          return val;
        },
        z.array(z.object({
          label: z.string().describe("Section header for output (e.g., 'README', 'Source Tree')"),
          command: z.string().describe("Shell command to execute"),
        })).min(1).describe("Commands to execute sequentially."),
      ),
      queries: z.preprocess(
        (val: unknown) => coerceStringArray(val),
        z.array(z.string()).min(1).describe("Search queries to extract from indexed output."),
      ),
      outputMode: z.enum(["snippets", "full"]).optional().default("snippets")
        .describe("Search result detail. Default snippets saves tokens; full returns complete chunks."),
      includeInventory: z.boolean().optional().default(false)
        .describe("Include indexed section list. Default false to save tokens."),
      timeout: z.coerce.number().optional().default(60_000)
        .describe("Total batch timeout in ms (default: 60000)"),
    },
  },
  async ({ commands, queries, outputMode, includeInventory, timeout }) => {
    try {
      const outputs: string[] = [];
      const startTime = Date.now();
      let timedOut = false;

      for (let cmdIdx = 0; cmdIdx < commands.length; cmdIdx++) {
        const cmd = commands[cmdIdx];
        const remaining = timeout - (Date.now() - startTime);
        if (remaining <= 0) {
          timedOut = true;
          for (let i = cmdIdx; i < commands.length; i++) {
            outputs.push(`# ${commands[i].label}\n\n(skipped — batch timeout exceeded)\n`);
          }
          break;
        }

        const result = await executor.execute({
          language: "shell" as Language,
          code: `${cmd.command} 2>&1`,
          timeout: remaining,
        });

        outputs.push(`# ${cmd.label}\n\n${result.stdout || "(no output)"}\n`);

        if (result.timedOut) {
          timedOut = true;
          for (let i = cmdIdx + 1; i < commands.length; i++) {
            outputs.push(`# ${commands[i].label}\n\n(skipped — batch timeout exceeded)\n`);
          }
          break;
        }
      }

      const stdout = outputs.join("\n");
      const source = shortSource("batch", commands.map((c) => c.label));
      const indexed = store.index({ content: stdout, source });

      // Optional section inventory
      const allSections = store.getChunksBySource(indexed.sourceId);
      const inventory = includeInventory ? formatInventory(allSections) : [];
      const terms = store.getDistinctiveTerms(indexed.sourceId, 12);

      // Search queries
      const searchResults: string[] = [];
      for (const q of queries) {
        const results = store.searchWithFallback(q, 5, source);
        if (results.length > 0) {
          searchResults.push(`### ${q}`);
          for (const r of results) {
            searchResults.push(formatSearchMatch(r, q, outputMode as SearchOutputMode));
          }
        }
      }

      const totalLines = stdout.split("\n").length;
      const totalKB = (Buffer.byteLength(stdout) / 1024).toFixed(1);
      const output = [
        timedOut
          ? `Executed ${commands.length} commands (${totalLines} lines, ${totalKB}KB) — timed out, some commands skipped. ` +
            `Indexed ${indexed.totalChunks} sections as source "${source}". Searched ${queries.length} queries.`
          : `Executed ${commands.length} commands (${totalLines} lines, ${totalKB}KB). ` +
            `Indexed ${indexed.totalChunks} sections as source "${source}". Searched ${queries.length} queries.`,
        terms.length > 0 ? `Distinctive terms: ${terms.join(", ")}` : "",
        `Use get_chunk(chunkId) to expand a snippet.`,
        "",
        ...inventory,
        "",
        ...searchResults,
      ].join("\n");

      return textResult(truncateHeadTail(output, MAX_RESPONSE_BYTES, 30, 30));
    } catch (err) {
      return textResult(
        `Batch error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// ── Tool 3: search ─────────────────────────────────────────

server.registerTool(
  "search",
  {
    title: "Search Indexed Content",
    description:
      `BM25 search over indexed content. Use after batch_execute to query results. ` +
      `Returns ranked evidence snippets by default. Use get_chunk for full content.`,
    inputSchema: {
      queries: z.preprocess(
        (val: unknown) => coerceStringArray(val),
        z.array(z.string()).min(1).describe("Search queries."),
      ),
      limit: z.coerce.number().int().positive().optional().default(5)
        .describe("Results per query (default: 5)"),
      source: z.string().optional()
        .describe("Filter by source label (e.g. 'hook-plugin_context-mode_context-mode__execut')"),
      outputMode: z.enum(["snippets", "full"]).optional().default("snippets")
        .describe("Result detail. Default snippets saves tokens; full returns complete chunks."),
    },
  },
  async ({ queries, limit, source, outputMode }) => {
    try {
      const results: string[] = [];
      for (const q of queries) {
        const matches = store.searchWithFallback(q, limit, source);
        if (matches.length > 0) {
          results.push(`### ${q}`);
          for (const m of matches) {
            results.push(formatSearchMatch(m, q, outputMode as SearchOutputMode));
          }
        } else {
          results.push(`### ${q}\n(no results)\n`);
        }
      }

      if (results.length === 0) {
        return textResult("No results found. Index content first via batch_execute.");
      }

      return textResult(truncateHeadTail(results.join("\n"), MAX_RESPONSE_BYTES, 30, 30));
    } catch (err) {
      return textResult(
        `Search error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// ── Tool 4: get_chunk ───────────────────────────────────────

server.registerTool(
  "get_chunk",
  {
    title: "Get Full Indexed Chunk",
    description:
      `Expand one exact chunk returned by search, batch_execute, or fetch_and_index. ` +
      `Use this only after a snippet proves the chunk is relevant.`,
    inputSchema: {
      chunkId: z.coerce.number().int().positive()
        .describe("chunkId returned in snippet search results"),
    },
  },
  async ({ chunkId }) => {
    try {
      const chunk = store.getChunkById(chunkId);
      if (!chunk) {
        return textResult(`No chunk found for chunkId=${chunkId}`, true);
      }
      const header = `**${chunk.title}** [${chunk.source}] chunkId=${chunk.chunkId} sourceId=${chunk.sourceId} type=${chunk.contentType}`;
      return textResult(truncateHeadTail(`${header}\n\n${chunk.content}`, MAX_RESPONSE_BYTES, 30, 30));
    } catch (err) {
      return textResult(
        `get_chunk error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// ── Tool 5: fetch_and_index ─────────────────────────────────

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
// Strip non-content elements — Next.js RSC flight data lives in <script> tags
// (self.__next_f.push) and would otherwise flood the markdown output.
turndown.remove(["script", "style", "noscript", "iframe", "canvas", "template", "link", "meta"]);

/**
 * Detect pages that are pure SPA shells / raw RSC payloads with no renderable HTML.
 *
 * IMPORTANT: the presence of `self.__next_f.push` alone is NOT a rejection signal.
 * Virtually every server-rendered Next.js site embeds RSC hydration data alongside
 * fully rendered HTML. Reject only when the page also lacks semantic HTML structure.
 */
function isUnparseable(html: string): boolean {
  const htmlTags = (html.match(/<\/?(?:div|p|h[1-6]|ul|ol|li|table|section|article|main|header|footer)\b/g) || []).length;
  // High density of JS chunk references with minimal HTML structure
  const chunkRefs = (html.match(/static\/chunks\/[\w-]+\.js/g) || []).length;
  if (chunkRefs > 10 && htmlTags < 5) return true;
  // Raw RSC streaming payload with no document structure at all
  if (html.includes("self.__next_f.push") && htmlTags < 5) return true;
  return false;
}

server.registerTool(
  "fetch_and_index",
  {
    title: "Fetch URL and Index",
    description:
      `Fetches a URL, converts HTML to markdown, indexes into FTS5 knowledge base. ` +
      `Returns structured summary — sections, links, and optional search results. ` +
      `Use this INSTEAD of WebFetch/webReader to avoid flooding context with raw HTML.`,
    inputSchema: {
      url: z.string().describe("URL to fetch and index"),
      queries: z.preprocess(
        (val: unknown) => coerceStringArray(val),
        z.array(z.string()).optional().default([])
          .describe("Optional queries to search after indexing"),
      ),
      outputMode: z.enum(["snippets", "full"]).optional().default("snippets")
        .describe("Search result detail. Default snippets saves tokens; full returns complete chunks."),
      includeInventory: z.boolean().optional().default(false)
        .describe("Include indexed section list. Default false to save tokens."),
      includeLinks: z.boolean().optional().default(false)
        .describe("Include page links. Default false to save tokens."),
      timeout: z.coerce.number().optional().default(30_000)
        .describe("Fetch timeout in ms (default: 30000)"),
    },
  },
  async ({ url, queries, outputMode, includeInventory, includeLinks, timeout }) => {
    try {
      // Fetch with timeout. Send an explicit User-Agent: some sites (e.g.
      // Cloudflare, GitHub) reject requests with Node's default undici UA
      // ("node"), returning 403/403-ish or empty pages.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      let html: string;
      try {
        const res = await globalThis.fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          redirect: "follow",
        });
        if (!res.ok) {
          return textResult(`HTTP ${res.status} ${res.statusText} for ${url}`, true);
        }
        html = await res.text();
      } finally {
        clearTimeout(timer);
      }

      // Detect unparseable formats (RSC, SPA shells, etc.)
      if (isUnparseable(html)) {
        return textResult(
          `fetch_and_index: Page returned an unparseable format (RSC/SPA payload). ` +
          `The HTML-to-markdown converter cannot process this content. ` +
          `Source the content from an alternative URL or format ` +
          `(e.g., GitHub releases, API endpoint, raw markdown, cached/archive version).\n\nURL: ${url}`,
          true,
        );
      }

      // Extract title from raw HTML for section inventory
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const pageTitle = titleMatch ? titleMatch[1].trim() : new URL(url).hostname;

      // Convert HTML → markdown
      const markdown = turndown.turndown(html);

      if (!markdown.trim()) {
        return textResult(
          `fetch_and_index: Page rendered no extractable text content (HTML-to-markdown produced empty output). ` +
          `Try a raw markdown URL, API endpoint, or archive version instead.\n\nURL: ${url}`,
          true,
        );
      }

      // Extract links for reference summary
      const linkMatches = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi)];
      const links: string[] = [];
      const seen = new Set<string>();
      for (const m of linkMatches) {
        const href = m[1].trim();
        const text = m[2].trim();
        if (href && !seen.has(href) && !href.startsWith("javascript:")) {
          seen.add(href);
          links.push(`- [${text || href}](${href})`);
        }
        if (links.length >= 50) break; // cap at 50 links
      }

      // Index markdown
      const indexed = store.index({ content: markdown, source: url });

      // Section inventory
      const allSections = store.getChunksBySource(indexed.sourceId);
      const inventory = includeInventory ? formatInventory(allSections) : [];
      const terms = store.getDistinctiveTerms(indexed.sourceId, 12);

      // Optional search queries
      const searchResults: string[] = [];
      for (const q of queries) {
        const results = store.searchWithFallback(q, 5, url);
        if (results.length > 0) {
          searchResults.push(`### ${q}`);
          for (const r of results) {
            searchResults.push(formatSearchMatch(r, q, outputMode as SearchOutputMode));
          }
        }
      }

      const totalKB = (Buffer.byteLength(markdown) / 1024).toFixed(1);
      const output = [
        `Fetched: ${pageTitle}`,
        `URL: ${url}`,
        `Content: ${totalKB}KB, ${indexed.totalChunks} sections indexed as source "${url}".`,
        terms.length > 0 ? `Distinctive terms: ${terms.join(", ")}` : "",
        `Use get_chunk(chunkId) to expand a snippet.`,
        "",
        ...inventory,
        "",
        includeLinks && links.length > 0 ? `## Links (${links.length})\n\n${links.join("\n")}` : null,
        "",
        ...searchResults,
      ].filter(Boolean).join("\n");

      return textResult(truncateHeadTail(output, MAX_RESPONSE_BYTES, 30, 30));
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return textResult(`Fetch timed out after ${timeout}ms: ${url}`, true);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return textResult(`Fetch error: ${msg}`, true);
    }
  },
);

// ── Start ──────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: Error) => {
  process.stderr.write(`[context-mode] fatal: ${err.message}\n`);
  process.exit(1);
});
