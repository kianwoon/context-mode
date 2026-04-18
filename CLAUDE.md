# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev

```bash
npm run build        # tsc typecheck + esbuild bundle → build/index.js
npm run dev          # run via tsx (unbundled, for dev)
npm run typecheck    # tsc --noEmit
```

No test framework is configured. The `better-sqlite3` dependency is externalized from the bundle — it loads at runtime via `require()`.

## Architecture

This is a Claude Code plugin (v2.2.0) that provides 4 MCP tools and 3 auto-enforcing PreToolUse hooks. The goal: keep raw tool output out of Claude's context window.

### MCP Server (`src/index.ts`)

Entry point. Registers 4 tools on a `McpServer` (stdio transport):
- **execute** — runs code in 11 languages via sandboxed subprocess, only `console.log()` output returns
- **batch_execute** — runs shell commands sequentially, auto-indexes output into FTS5, returns BM25 search results
- **search** — BM25 search over previously indexed content
- **fetch_and_index** — fetches URL, HTML→markdown via Turndown, indexes into FTS5

Response size is capped at `MAX_RESPONSE_BYTES = 200_000` (~50K tokens) via `truncateJSON`.

### ContentStore (`src/store.ts`)

SQLite + FTS5 knowledge base. Key design:
- **Dual FTS5 tables**: `chunks` (porter tokenizer for stemming) + `chunks_trigram` (trigram tokenizer for partial matches)
- **3-layer search**: porter BM25 → trigram BM25 → fuzzy correction via Levenshtein on vocabulary table. Results merged via Reciprocal Rank Fusion (RRF)
- **Proximity reranking**: multi-term queries get a boost when terms appear close together in the chunk
- **Auto-eviction**: entries older than 60 minutes are evicted on each `index()` call
- **Dedup by label**: re-indexing the same source label atomically deletes old chunks and inserts new ones (prevents stale results in iterative workflows)
- **FTS5 optimization**: index segments are defragmented every 50 inserts
- DB files live in `$TMPDIR/context-mode-{pid}.db`, cleaned up on process exit or when the PID is dead

### Executor (`src/executor.ts`)

Runs code via child process. Detects available runtimes at startup.

### Hooks (`hooks/`)

Three PreToolUse guards defined in `hooks/hooks.json`:
- **bash-output-guard.cjs** — blocks bare `git log`, `git diff`, `git show`, `git blame`, `git reflog`, `git stash list`, `git branch -a`, broad `find`
- **log-read-guard.cjs** — blocks `Read` on data-heavy files (.log, .csv, .xml, .sql, .json >100KB)
- **web-fetch-guard.cjs** — blocks `WebFetch`, `webReader`, `WebSearch`

All hooks read stdin as JSON, check the tool command against regex patterns, and output a `permissionDecision: "deny"` with a redirect suggestion. They must stay under 50ms — no directory scans, no sync I/O on hot paths.

### Plugin Config (`.claude-plugin/plugin.json`)

Declares the MCP server entry point (`node ${CLAUDE_PLUGIN_ROOT}/build/index.js`) and plugin metadata. The hooks manifest is separate at `hooks/hooks.json`.

## Key Conventions

- The build uses `esbuild` with `--external:better-sqlite3` because native modules can't be bundled
- All SQL prepared statements are cached at construction time in `ContentStore` to avoid recompilation
- `withRetry()` wraps all DB operations to handle transient SQLITE_BUSY errors
- The `sanitizeQuery()` function strips FTS5 special chars and filters stopwords before BM25 search
