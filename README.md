# context-mode

[![Version](https://img.shields.io/badge/version-2.1.0-blue)](https://github.com/kianwoon/context-mode/releases)
[![License](https://img.shields.io/badge/license-Elastic--2.0-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![CI](https://github.com/kianwoon/context-mode/actions/workflows/ci.yml/badge.svg)](https://github.com/kianwoon/context-mode/actions/workflows/ci.yml)

Sandboxed code execution + FTS5 knowledge base for Claude Code. 4 MCP tools, 2 auto-enforcing hooks.

## Why

Every LLM has a finite context window — whether it's 200K, 128K, or 32K tokens. Every token spent on raw tool output is a token NOT available for reasoning.

**The problem:** Reading files, running commands, and searching codebases floods your context window with raw data. A typical research session (explore structure, find routes, debug errors) can burn through 135K tokens — most of your window — before the LLM even starts thinking.

**The fix:** context-mode keeps raw data in a sandbox. Write code that does the work, `console.log()` only the answer. The raw output stays out of context.

| Scenario | Raw Tokens | context-mode | Savings |
|----------|-----------|-------------|---------|
| Find all API routes | 15,000 | 800 | 95% |
| Analyze test failures | 35,000 | 1,200 | 97% |
| Research codebase structure | 60,000 | 2,500 | 96% |
| Debug a production error | 25,000 | 1,000 | 96% |
| **Typical session** | **135,000** | **5,500** | **~96%** |

That's 129,500 tokens freed for reasoning instead of holding raw data.

## Install

```bash
claude plugin add kianwoon/context-mode
```

Requires Node.js 22+ (uses built-in `node:sqlite`). No build step, no native dependencies.

## Tools

| Tool | Description |
|------|-------------|
| `execute(language, code, timeout?)` | Run code in 11 languages via sandboxed subprocess |
| `batch_execute(commands, queries, timeout?)` | Run shell commands, auto-index output, search |
| `search(queries, limit?)` | BM25 search over indexed content |
| `fetch_and_index(url, queries?, timeout?)` | Fetch URL, convert HTML→markdown, index, return summary |

## How it works

1. **execute** — Write code that processes data. Only `console.log()` output enters context.
2. **batch_execute** — Run multiple shell commands, auto-index output into FTS5, search for what you need. One call replaces 30+ tool calls.
3. **search** — BM25 search over previously indexed content. One call, many queries.
4. **fetch_and_index** — Fetch a URL, convert HTML to markdown, index into FTS5, return structured summary. Follow-up via `search()`.

**Auto-enforcing hooks** block `Read` on data-heavy files (.log, .csv, .xml, .sql, .json >100KB), `WebFetch`/`webReader` (raw HTML dumps), and `WebSearch` (US-only, unreliable) — redirecting to the tools above.

**When to use what:**
- `Read` → files you want to **edit** (need exact content for Edit tool)
- `execute` → data you want to **analyze** (count, filter, transform, parse)
- `batch_execute` → codebases you want to **research** (explore, index, query)
- `fetch_and_index` → web pages you want to **read** (fetch, index, query)
- `search` → follow-up queries on indexed content

## Build

```bash
npm run build
```

Outputs `build/index.js` (~607KB single bundle). The bundle is committed to the repo for zero-build install.

## Architecture

```
src/index.ts     — MCP server entry (~350 lines, 4 tools)
src/executor.ts  — PolyglotExecutor: 11 languages, process group kill
src/store.ts     — FTS5/BM25 content store (SQLite)
src/db-base.ts   — Multi-backend SQLite: node:sqlite (primary) → better-sqlite3 (fallback)
src/runtime.ts   — Runtime detection
src/types.ts     — Shared types
src/truncate.ts  — Output truncation
hooks/           — PreToolUse guards (auto-enforce usage patterns)
```

## Data lifecycle

No user intervention needed — the plugin self-manages:

| Mechanism | When | What |
|-----------|------|------|
| **Per-session DB** | On start | Each session gets its own temp SQLite DB (`context-mode-{pid}.db`). No cross-session accumulation. |
| **Source dedup** | On index | Re-indexing the same source/label atomically replaces old content — prevents stale build-fix-build buildup. |
| **TTL eviction** | On index | Entries older than 60 minutes are evicted before each new insert. |
| **Session cleanup** | On exit | DB files + WAL/SHM are deleted when the process exits. |
| **Orphan sweep** | On start | Stale DBs from dead PIDs or orphaned sessions (untouched >4hrs) are cleaned up at launch. |

Result: the knowledge base stays lean automatically. No config, no cron, no manual cleanup.

## What's not here (by design)

No adapters, no session DB, no CLI, no analytics. PreToolUse hooks auto-enforce best practices.
