# context-mode

Sandboxed code execution + FTS5 knowledge base for Claude Code.

## TL;DR

Write code. `console.log()` only the answer. Raw output stays in a sandbox — out of your context window.

| Tool | Use when |
|------|----------|
| `execute(language, code)` | Data processing — analyze, filter, transform, count |
| `batch_execute(commands, queries)` | Research — explore codebase, index, search |
| `search(queries, source?)` | Follow-up queries on indexed content |
| `fetch_and_index(url, queries?)` | Web research — fetch, index, query |

**Hooks auto-enforce the pattern.** If you reach for the wrong tool, Claude redirects you with examples.

## Install

```bash
claude plugin add kianwoon/context-mode
```

Requires Node.js 22+.

## Quick Start

### Instead of `Bash` for research:

❌ **Before (raw output floods context):**
```
Bash: git log
Bash: git diff
Bash: git branch -a
```

✓ **After (indexed + searchable):**
```
batch_execute({
  commands: [
    {label: "log", command: "git log --oneline -20"},
    {label: "diff", command: "git diff --stat"},
    {label: "branches", command: "git branch -a | head -30"}
  ],
  queries: ["what changed in the last commit", "any pending migrations"]
})
```

### Instead of `Read` on data files:

❌ **Before (raw file floods context):**
```
Read: results.csv    # 50MB CSV
Read: app.log        # unbounded log
```

✓ **After (only the answer enters context):**
```
execute({
  language: "javascript",
  code: `
    const fs = require('fs');
    const lines = fs.readFileSync('results.csv', 'utf8').split('\\n').filter(l => l.includes('ERROR'));
    console.log(lines.length);
  `
})
```

### Instead of `WebFetch`:

❌ **Before (raw HTML floods context — 5K-50K+ tokens):**
```
WebFetch: https://docs.example.com/api
```

✓ **After (indexed + searchable):**
```
fetch_and_index({url: "https://docs.example.com/api", queries: ["rate limit", "auth"]})
```

## Tools

### execute(language, code, timeout?)
Runs code in 11 languages. Only `console.log()` output returns — everything else stays sandboxed.

```javascript
execute({language: "javascript", code: `
  const data = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  console.log(Object.keys(data.dependencies).join(', '));
`})
```

### batch_execute(commands, queries?, timeout?)
Runs shell commands, auto-indexes output into FTS5, runs BM25 search, returns ranked results.

```javascript
batch_execute({
  commands: [
    {label: "src", command: "find src -name '*.ts' | head -50"},
    {label: "tests", command: "find . -name '*.test.ts'"},
  ],
  queries: ["auth middleware", "API routes"]
})
```

### search(queries, limit?)
BM25 search over previously indexed content. Works across all `batch_execute` and `fetch_and_index` output in the session.

```javascript
search({queries: ["where is the login handler", "what does the auth middleware do"]})
```

### fetch_and_index(url, queries?, timeout?)
Fetches a URL, converts HTML→markdown, indexes into FTS5, returns structured summary + search results.

```javascript
fetch_and_index({url: "https://github.com/kianwoon/context-mode", queries: ["features", "install"]})
```

## How hooks work

Hooks auto-enforce the pattern — you don't need to memorize when to use what.

| Trigger | What happens |
|---------|---------------|
| `Bash` with dangerous command (bare `git log`, `git diff`, etc.) | **Denied** with redirect to `execute`/`batch_execute` example |
| First `Bash` call in session (safe command) | **Guidance** with pattern examples (once/session) |
| `Read` on data file (.log, .csv, .json >100KB) | **Denied** with redirect to `execute` example |
| First `Read` call in session (safe file) | **Guidance** with pattern examples (once/session) |
| `WebFetch` / `webReader` | **Denied** with redirect to `fetch_and_index` |
| `batch_execute` / `execute` / `fetch_and_index` with large output | **Indexed** to FTS5, output replaced with search summary |

## Data lifecycle

Plugin self-manages — no config needed.

- **Per-session DB**: `context-mode-{pid}.db` in tmpdir, deleted on session end
- **Source dedup**: re-indexing same label atomically replaces old content
- **TTL eviction**: entries older than 60 minutes evicted on each insert
- **Orphan sweep**: stale DBs from dead PIDs cleaned up on start

## Build

```bash
npm run build   # outputs build/index.js (~607KB, committed to repo)
```
