#!/usr/bin/env node
/**
 * context-mode v2 — Lean MCP server
 *
 * Three tools: execute, batch_execute, search.
 * No hooks, no adapters, no session DB, no analytics.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PolyglotExecutor } from "./executor.js";
import { ContentStore, cleanupStaleDBs } from "./store.js";
import { detectRuntimes, getAvailableLanguages } from "./runtime.js";
import type { Language } from "./runtime.js";
import { truncateJSON } from "./truncate.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  version: "2.0.0",
});

// Prevent silent death
process.on("unhandledRejection", (err: unknown) => {
  process.stderr.write(`[context-mode] unhandledRejection: ${err}\n`);
});
process.on("uncaughtException", (err: Error) => {
  process.stderr.write(`[context-mode] uncaughtException: ${err?.message ?? err}\n`);
});

// ── Helpers ────────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 200_000; // ~50K tokens

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

function coerceStringArray(val: unknown): string[] {
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return [val]; }
  }
  return Array.isArray(val) ? val : [];
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
      return textResult(truncateJSON(output, MAX_RESPONSE_BYTES, 0));
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
      timeout: z.coerce.number().optional().default(60_000)
        .describe("Total batch timeout in ms (default: 60000)"),
    },
  },
  async ({ commands, queries, timeout }) => {
    try {
      const outputs: string[] = [];
      const startTime = Date.now();
      let timedOut = false;

      for (const cmd of commands) {
        const remaining = timeout - (Date.now() - startTime);
        if (remaining <= 0) {
          outputs.push(`# ${cmd.label}\n\n(skipped — batch timeout exceeded)\n`);
          timedOut = true;
          continue;
        }

        const result = await executor.execute({
          language: "shell" as Language,
          code: `${cmd.command} 2>&1`,
          timeout: remaining,
        });

        outputs.push(`# ${cmd.label}\n\n${result.stdout || "(no output)"}\n`);

        if (result.timedOut) {
          timedOut = true;
          const idx = commands.indexOf(cmd);
          for (let i = idx + 1; i < commands.length; i++) {
            outputs.push(`# ${commands[i].label}\n\n(skipped — batch timeout exceeded)\n`);
          }
          break;
        }
      }

      if (timedOut && outputs.length === 0) {
        return textResult(`Batch timed out after ${timeout}ms. No output captured.`, true);
      }

      const stdout = outputs.join("\n");
      const source = `batch:${commands.map((c) => c.label).join(",").slice(0, 80)}`;
      const indexed = store.index({ content: stdout, source });

      // Section inventory
      const allSections = store.getChunksBySource(indexed.sourceId);
      const inventory = ["## Indexed Sections", ""];
      for (const s of allSections) {
        const kb = (Buffer.byteLength(s.content) / 1024).toFixed(1);
        inventory.push(`- ${s.title} (${kb}KB)`);
      }

      // Search queries
      const searchResults: string[] = [];
      for (const q of queries) {
        const results = store.search(q, 5, source);
        if (results.length > 0) {
          searchResults.push(`### ${q}`);
          for (const r of results) {
            searchResults.push(`**${r.title}**\n${r.content}\n`);
          }
        }
      }

      const totalLines = stdout.split("\n").length;
      const totalKB = (Buffer.byteLength(stdout) / 1024).toFixed(1);
      const output = [
        `Executed ${commands.length} commands (${totalLines} lines, ${totalKB}KB). ` +
        `Indexed ${indexed.totalChunks} sections. Searched ${queries.length} queries.`,
        "",
        ...inventory,
        "",
        ...searchResults,
      ].join("\n");

      return textResult(truncateJSON(output, MAX_RESPONSE_BYTES, 0));
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
      `Returns ranked results with full content. One call, many queries.`,
    inputSchema: {
      queries: z.preprocess(
        (val: unknown) => coerceStringArray(val),
        z.array(z.string()).min(1).describe("Search queries."),
      ),
      limit: z.coerce.number().optional().default(5)
        .describe("Results per query (default: 5)"),
    },
  },
  async ({ queries, limit }) => {
    try {
      const results: string[] = [];
      for (const q of queries) {
        const matches = store.search(q, limit);
        if (matches.length > 0) {
          results.push(`### ${q}`);
          for (const m of matches) {
            results.push(`**${m.title}** [${m.source}]\n${m.content}\n`);
          }
        } else {
          results.push(`### ${q}\n(no results)\n`);
        }
      }

      if (results.length === 0) {
        return textResult("No results found. Index content first via batch_execute.");
      }

      return textResult(truncateJSON(results.join("\n"), MAX_RESPONSE_BYTES, 0));
    } catch (err) {
      return textResult(
        `Search error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
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
