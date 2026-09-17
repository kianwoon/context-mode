#!/usr/bin/env node
/**
 * db-path — Deterministic SQLite path resolution shared by hooks.
 *
 * The PostToolUse indexer runs as a sibling process of the MCP server (both
 * are children of the Claude Code process). It must open the SAME FTS5 DB
 * that the server's search() reads from. Historically this meant scraping
 * `ps` output to find the server PID — brittle and wrong when multiple
 * context-mode servers are alive.
 *
 * Resolution order (first hit wins):
 *   1. CONTEXT_MODE_DB env var (set explicitly by plugin config / server).
 *   2. This process's own `context-mode-<pid>.db`, when present.
 *   3. A live `context-mode-<pid>.db` in tmpdir owned by another process.
 *      When more than one live candidate exists (two concurrent servers)
 *      the newest-mtime one is chosen and an ambiguity warning is emitted
 *      to stderr — never silently. No `ps` ancestry check: single-level
 *      ppid is insufficient to prove ancestry, so we do not guess.
 *   4. Fallback: join(tmpdir(), `context-mode-${pid}.db`).
 *
 * Pure and injectable for testing: resolveDbPath(env, tmpdir, pid, opts).
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** A PID is "alive" if signal 0 can be delivered to it. */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM → exists but owned by another user; ESRCH → gone.
    return err && err.code === 'EPERM';
  }
}

/**
 * Parse `context-mode-<pid>.db` filenames from a temp dir, newest first.
 * Injectable via opts.readdir (defaults to fs.readdirSync) for tests.
 */
function discoverSessionDbs(tmp, readdir) {
  const read = readdir || ((d) => fs.readdirSync(d));
  let files;
  try {
    files = read(tmp);
  } catch {
    return [];
  }
  const found = [];
  for (const file of files) {
    const m = /^context-mode-(\d+)\.db$/.exec(file);
    if (!m) continue;
    const owner = parseInt(m[1], 10);
    const full = path.join(tmp, file);
    let mtime = 0;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    found.push({ path: full, owner, mtime });
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

/**
 * Resolve the DB path for a hook process.
 *
 * @param {Record<string,string|undefined>} env   process.env-like object
 * @param {string} tmp                            tmpdir()
 * @param {number} pid                            fallback PID (this process)
 * @param {{ readdir?: Function, isAlive?: Function, warn?: Function }} [opts]
 * @returns {string}
 */
function resolveDbPath(env, tmp, pid, opts) {
  opts = opts || {};

  // 1. Explicit override always wins — unless it still contains an
  //    unexpanded placeholder (e.g. a literal "${TMPDIR}" the host did not
  //    substitute), which would otherwise produce an invalid path.
  const override = env && env.CONTEXT_MODE_DB;
  if (override && String(override).trim() && !String(override).includes('${')) {
    return String(override).trim();
  }

  const isAlive = opts.isAlive || pidAlive;
  const warn = opts.warn || ((msg) => process.stderr.write(msg));
  const candidates = discoverSessionDbs(tmp, opts.readdir);

  // 2. Prefer our own DB when it already exists (this process is the server,
  //    or the server reused our PID path). Deterministic and cross-talk-free.
  const own = candidates.find((c) => c.owner === pid);
  if (own) return own.path;

  // 3. Otherwise pick the newest-mtime live DB owned by a *different* PID.
  //    With concurrent servers this is inherently ambiguous: we cannot prove
  //    ancestry from a single-level ppid without `ps`, so we surface the
  //    ambiguity on stderr rather than silently cross-talking.
  const lives = candidates.filter((c) => c.owner !== pid && isAlive(c.owner));
  if (lives.length > 0) {
    if (lives.length > 1) {
      warn(
        `[db-path] WARNING: ${lives.length} live session DBs found in ${tmp} ` +
          `(owners: ${lives.map((c) => c.owner).join(', ')}); ` +
          `choosing newest by mtime "${lives[0].path}". ` +
          `Set CONTEXT_MODE_DB to disambiguate.\n`,
      );
    }
    return lives[0].path;
  }

  // 4. Deterministic fallback.
  return path.join(tmp, `context-mode-${pid}.db`);
}

module.exports = { resolveDbPath, discoverSessionDbs, pidAlive };
