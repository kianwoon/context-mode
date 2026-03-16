# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note**: This project inherits global rules from `~/.claude/CLAUDE.md` and `~/.claude/rules/*.md`. This file supplements (not replaces) those global rules with project-specific guidance.

# Development

## Commands

| Command | What it does |
|---------|-------------|
| `npm run build` | TypeScript compile → `build/` |
| `npm run bundle` | esbuild → `server.bundle.mjs`, `cli.bundle.mjs`, hook bundles |
| `npm run dev` | Run MCP server via tsx (no bundle needed) |
| `npm test` | Vitest run (all `tests/**/*.test.ts`) |
| `npm run test:watch` | Vitest in watch mode |
| `npx vitest run tests/store.test.ts` | Run single test file |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run doctor` | Runtime diagnostics (runtimes, FTS5, hooks) |

## Architecture

- **`start.mjs`** — Bootstrap entry. Installs native deps on-the-fly, loads `server.bundle.mjs` (CI) or `build/server.js` (dev). Writes routing instructions to project `CLAUDE.md`. Self-heals plugin cache version on startup.
- **`src/server.ts`** — Monolithic MCP server. Registers all tools on `McpServer`, creates `PolyglotExecutor` + lazy `ContentStore` singleton, tracks session stats.
- **`src/executor.ts`** — `PolyglotExecutor`: spawns sandboxed child processes per language (JS via Bun, Python, Ruby, Perl, Shell, Go, Rust, PHP, Elixir, R). Detects runtimes at startup.
- **`src/store.ts`** — `ContentStore`: FTS5 SQLite knowledge base with BM25 ranking. Chunks markdown by headings, indexes for searchable retrieval. Session event files consumed on `getStore()`.
- **`src/security.ts`** — Command deny patterns, file path evaluation, shell command extraction. Server-side firewall before execution.
- **`src/cli.ts`** — CLI for setup, doctor, and hook installation.
- **`hooks/`** — Platform-specific hook scripts (Claude Code, Gemini CLI, VS Code Copilot). `pretooluse.mjs` intercepts tool calls and redirects to sandbox. `sessionstart.mjs` writes routing instructions.
- **`configs/`** — Routing instruction templates per platform (Claude Code, Gemini CLI, VS Code Copilot).
- **`skills/`** — Claude Code skill definitions (ctx-stats, ctx-doctor, ctx-upgrade).

## Key Gotchas

- **Native deps**: `better-sqlite3` requires compilation. Bundles mark it `--external` — must be installed separately in the deployment dir. `start.mjs` handles this automatically.
- **ESM only**: `"type": "module"` in package.json. All imports must use `.js` extensions (not `.ts`).
- **Bundle vs source**: CI publishes `server.bundle.mjs` + `cli.bundle.mjs`. Dev uses `tsx` → `src/server.ts` directly. The `start.mjs` bootstrap prefers bundle, falls back to build.
- **Hook bundles**: `session-extract.bundle.mjs`, `session-snapshot.bundle.mjs`, `session-db.bundle.mjs` are pre-built esbuild bundles in `hooks/`. Rebuild with `npm run bundle`.
- **ContentStore lazy init**: FTS5 DB is only created on first `index()` or `search()` call — no overhead if unused.
- **Session events**: Written as `*-events.md` files to `~/.claude/context-mode/sessions/`, consumed and deleted on `getStore()`.

# Plugin Routing (auto-managed)

Raw tool output floods your context window. Use context-mode MCP tools to keep raw data in the sandbox.

## Tool Selection

1. **GATHER**: `batch_execute(commands, queries)` — Primary tool for research. Runs all commands, auto-indexes, and searches. ONE call replaces many individual steps.
2. **FOLLOW-UP**: `search(queries: ["q1", "q2", ...])` — Use for all follow-up questions. ONE call, many queries.
3. **PROCESSING**: `execute(language, code)` or `execute_file(path, language, code)` — Use for API calls, log analysis, and data processing.
4. **WEB**: `fetch_and_index(url)` then `search(queries)` — Fetch, index, then query. Never dump raw HTML.

## Rules

- DO NOT use Bash for commands producing >20 lines of output — use `execute` or `batch_execute`.
- DO NOT use Read for analysis — use `execute_file`. Read IS correct for files you intend to Edit.
- DO NOT use WebFetch — use `fetch_and_index` instead.
- DO NOT use curl/wget in Bash — use `execute` or `fetch_and_index`.
- Bash is ONLY for git, mkdir, rm, mv, navigation, and short commands.

## Output

- Keep responses under 500 words.
- Write artifacts (code, configs) to FILES — never return them as inline text.
- Return only: file path + 1-line description.
