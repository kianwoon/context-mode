# OpenClaw Adapter

context-mode plugin for the [OpenClaw](https://github.com/openclaw) gateway, targeting **Pi Agent** sessions.

## Overview

**OpenClaw** is the gateway/platform that manages agent sessions, extensions, and tool routing. **Pi Agent** is OpenClaw's coding agent — it runs within OpenClaw and provides Read, Write, Edit, and Bash tools for software development tasks.

The context-mode adapter hooks into Pi Agent sessions specifically, intercepting tool calls to route data-heavy operations through the sandbox and tracking session events for compaction recovery.

### Supported Configurations

- **Pi Agent sessions** with coding tools (Read/Write/Edit/Bash) — fully supported.
- **Custom agents** with coding tools — may work but are untested. The adapter relies on tool names matching Pi Agent's conventions.

## Installation

Use the one-shot installer:

```bash
scripts/install-openclaw-plugin.sh [OPENCLAW_STATE_DIR]
```

The script handles:
1. Building the plugin (`npm run build`)
2. Rebuilding `better-sqlite3` for the system Node version
3. Creating the extension directory at `OPENCLAW_STATE_DIR/extensions/context-mode/`
4. Registering the plugin in `runtime.json`
5. Clearing the jiti cache
6. Restarting the gateway

See [`scripts/install-openclaw-plugin.sh`](../../scripts/install-openclaw-plugin.sh) for details.

## Hook Registration

The adapter uses two different registration APIs, matching OpenClaw's internal architecture:

- **`api.on()`** for lifecycle and tool hooks: `session_start`, `before_tool_call`, `after_tool_call`, `before_compaction`, `after_compaction`, `before_prompt_build`, `before_model_resolve`. These are typed event emitters with structured payloads.
- **`api.registerHook()`** for command hooks: `command:new`, `command:reset`, `command:stop`. These use colon-delimited names and the generic hook registration system.

Using the wrong API (e.g., `api.registerHook("before_tool_call", ...)`) registers silently but the hook never fires. This distinction is critical.

### Synchronous `register()`

OpenClaw silently discards the return value of `register()`. If `register()` is async, all hooks registered inside it are lost. The adapter uses the initPromise pattern:

```typescript
register(api): void {
  const initPromise = (async () => { /* async setup */ })();
  api.on("after_tool_call", async (e) => {
    await initPromise;
    // handle event
  });
}
```

## Session Continuity

| Hook | Method | Status |
|---|---|---|
| `after_tool_call` | `api.on()` | Working |
| `before_compaction` | `api.on()` | Working |
| `session_start` | `api.on()` | Working |
| `command:new` | `api.registerHook()` | Working |
| `command:reset` | `api.registerHook()` | Working |
| `command:stop` | `api.registerHook()` | Working |

### Graceful Degradation

If compaction hooks fail to fire (e.g., on older OpenClaw versions), the adapter falls back to **DB snapshot reconstruction** — rebuilding session state from the events already persisted in SQLite by `after_tool_call`. This produces a less precise snapshot than the PreCompact path but preserves critical state (active files, tasks, errors).

## Previously Known Upstream Issues

Both issues below have been resolved in upstream OpenClaw:

- **[#4967](https://github.com/openclaw/openclaw/issues/4967)** — Compaction hooks not firing. Closed as duplicate of [#3728](https://github.com/openclaw/openclaw/issues/3728); fix merged.
- **[#5513](https://github.com/openclaw/openclaw/issues/5513)** — `api.on()` hooks not invoked for tool lifecycle events. Fixed in [PR #9761](https://github.com/openclaw/openclaw/pull/9761).

## Minimum Version

**Required: OpenClaw >2026.1.29**

This is the first release that includes the `api.on()` fix from [PR #9761](https://github.com/openclaw/openclaw/pull/9761), which shipped on 2026-01-29.

**What breaks on older versions:** Lifecycle hooks registered via `api.on()` — including `before_compaction`, `after_compaction`, `session_start`, and tool interception hooks — may silently fail to fire.

**Graceful degradation:** If compaction hooks don't fire, the adapter falls back to DB snapshot reconstruction, rebuilding session state from events already persisted by `after_tool_call`. This produces a less precise snapshot than the PreCompact path but preserves critical state (active files, tasks, errors). The adapter will not crash on older versions, but compaction recovery quality will be reduced.

## Workspace Routing

The adapter includes a workspace router (`src/openclaw/workspace-router.ts`) that resolves project paths from Pi Agent session metadata, ensuring session databases and routing instructions are scoped per-workspace.

## Key Files

| File | Purpose |
|---|---|
| `src/openclaw-plugin.ts` | Main plugin entry (sync register, initPromise pattern) |
| `src/openclaw/workspace-router.ts` | Workspace path resolution for session scoping |
| `.openclaw-plugin/` | Plugin manifest (index.ts, openclaw.plugin.json, package.json) |
| `scripts/install-openclaw-plugin.sh` | One-shot installer |
