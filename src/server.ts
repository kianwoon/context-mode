#!/usr/bin/env node
/**
 * context-mode MCP server — thin orchestrator.
 *
 * All tool registrations are extracted into src/tools/*.ts.
 * Helper modules live in src/server/*.ts.
 * This file wires them together, creates singletons, and handles startup.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { PolyglotExecutor } from "./executor.js";
import { ContentStore, cleanupStaleDBs } from "./store.js";
import {
  detectRuntimes,
  getRuntimeSummary,
  hasBunRuntime,
} from "./runtime.js";
import { startLifecycleGuard } from "./lifecycle.js";
import {
  createSessionStats,
  trackResponse,
  trackIndexed,
  type SessionStats,
} from "./server/session-stats.js";

// Re-export for backward compat (tests import extractSnippet from here)
export { extractSnippet, positionsFromHighlight } from "./server/snippet-extractor.js";

const VERSION = "1.0.22";

// Prevent silent server death from unhandled async errors
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[context-mode] unhandledRejection: ${err}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`[context-mode] uncaughtException: ${err?.message ?? err}\n`);
});

// ─────────────────────────────────────────────────────────
// Singletons
// ─────────────────────────────────────────────────────────

const runtimes = detectRuntimes();
const server = new McpServer({
  name: "context-mode",
  version: VERSION,
});

const executor = new PolyglotExecutor({
  runtimes,
  projectRoot: process.env.CLAUDE_PROJECT_DIR,
});

const sessionStats: SessionStats = createSessionStats();

// Lazy singleton — no DB overhead unless index/search is used
let _store: ContentStore | null = null;

/**
 * Auto-index session events files written by SessionStart hook.
 * Scans ~/.claude/context-mode/sessions/ for *-events.md files.
 * Files are consumed (deleted) after indexing to prevent double-indexing.
 */
function maybeIndexSessionEvents(store: ContentStore): void {
  try {
    const sessionsDir = join(homedir(), ".claude", "context-mode", "sessions");
    if (!existsSync(sessionsDir)) return;
    const files = readdirSync(sessionsDir).filter(f => f.endsWith("-events.md"));
    for (const file of files) {
      const filePath = join(sessionsDir, file);
      try {
        store.index({ path: filePath, source: "session-events" });
        unlinkSync(filePath);
      } catch { /* best-effort per file */ }
    }
  } catch { /* best-effort */ }
}

function getStore(): ContentStore {
  if (!_store) _store = new ContentStore();
  maybeIndexSessionEvents(_store);
  return _store;
}

// ─────────────────────────────────────────────────────────
// Shared deps passed to all tool register functions
// ─────────────────────────────────────────────────────────

const sharedDeps = {
  trackResponse: (toolName: string, response: { content: Array<{ type: "text"; text: string }>; isError?: boolean }) =>
    trackResponse(sessionStats, toolName, response),
  trackIndexed: (bytes: number) => trackIndexed(sessionStats, bytes),
  getStore,
  executor,
  sessionStats,
};

// ─────────────────────────────────────────────────────────
// Register all tools
// ─────────────────────────────────────────────────────────

// Standalone tools (no executor/store dependency)
const { registerDoctorTool } = await import("./tools/doctor.js");
registerDoctorTool(server, sharedDeps);

const { registerUpgradeTool } = await import("./tools/upgrade.js");
registerUpgradeTool(server, sharedDeps);

// Stats tool (sessionStats dependency)
const { registerStatsTool } = await import("./tools/stats.js");
registerStatsTool(server, sharedDeps);

// Store-dependent tools
const { registerIndexTool } = await import("./tools/index.js");
registerIndexTool(server, sharedDeps);

const { registerSearchTool } = await import("./tools/search.js");
registerSearchTool(server, sharedDeps);

const { registerFetchAndIndexTool } = await import("./tools/fetch-and-index.js");
registerFetchAndIndexTool(server, sharedDeps);

// Executor-dependent tools
const { registerExecuteTool } = await import("./tools/execute.js");
registerExecuteTool(server, sharedDeps);

const { registerExecuteFileTool } = await import("./tools/execute-file.js");
registerExecuteFileTool(server, sharedDeps);

const { registerBatchExecuteTool } = await import("./tools/batch-execute.js");
registerBatchExecuteTool(server, sharedDeps);

// ─────────────────────────────────────────────────────────
// Server startup
// ─────────────────────────────────────────────────────────

async function main() {
  // Clean up stale DB files from previous sessions
  const cleaned = cleanupStaleDBs();
  if (cleaned > 0) {
    console.error(`Cleaned up ${cleaned} stale DB file(s) from previous sessions`);
  }

  // Clean up own DB + backgrounded processes on shutdown
  const shutdown = () => {
    executor.cleanupBackgrounded();
    if (_store) _store.cleanup();
  };
  const gracefulShutdown = async () => {
    shutdown();
    process.exit(0);
  };
  process.on("exit", shutdown);
  process.on("SIGINT", () => { gracefulShutdown(); });
  process.on("SIGTERM", () => { gracefulShutdown(); });

  // Lifecycle guard: detect parent death + stdin close to prevent orphaned processes (#103)
  startLifecycleGuard({ onShutdown: () => gracefulShutdown() });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Write routing instructions for hookless platforms (e.g. Codex CLI)
  try {
    const { detectPlatform, getAdapter } = await import("./adapters/detect.js");
    const signal = detectPlatform();
    const adapter = await getAdapter(signal.platform);
    if (!adapter.capabilities.sessionStart) {
      const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.env.CODEX_HOME ?? process.cwd();
      const written = adapter.writeRoutingInstructions(projectDir, pluginRoot);
      if (written) console.error(`Wrote routing instructions: ${written}`);
    }
  } catch { /* best effort — don't block server startup */ }

  console.error(`Context Mode MCP server v${VERSION} running on stdio`);
  console.error(`Detected runtimes:\n${getRuntimeSummary(runtimes)}`);
  if (!hasBunRuntime()) {
    console.error(
      "\nPerformance tip: Install Bun for 3-5x faster JS/TS execution",
    );
    console.error("  curl -fsSL https://bun.sh/install | bash");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
