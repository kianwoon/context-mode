import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Remove stale DB files from previous sessions.
 *
 * Two cleanup strategies:
 * 1. Dead PID — process no longer exists → clean immediately
 * 2. Orphan PID — process alive but DB untouched for >4hrs → likely an
 *    orphaned MCP server from a crashed Claude session. The 4hr threshold
 *    balances catching orphans against affecting legitimately idle sessions.
 */
export function cleanupStaleDBs(): number {
  const dir = tmpdir();
  const STALE_MS = 4 * 60 * 60 * 1000;
  let cleaned = 0;
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const match = file.match(/^context-mode-(\d+)\.db$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (pid === process.pid) continue;

      let shouldClean = false;
      let processExists = false;
      try {
        process.kill(pid, 0);
        processExists = true;
      } catch (killErr) {
        const code = (killErr as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          shouldClean = true;
        } else if (code === "EPERM") {
          processExists = true; // alive but owned by another user — fall through to mtime check
        }
      }
      if (processExists) {
        try {
          const mtime = statSync(join(dir, file)).mtimeMs;
          if (Date.now() - mtime > STALE_MS) shouldClean = true;
        } catch { /* stat failed — skip */ }
      }

      if (shouldClean) {
        const base = join(dir, file);
        for (const suffix of ["", "-wal", "-shm"]) {
          try { unlinkSync(base + suffix); } catch { /* ignore */ }
        }
        cleaned++;
      }
    }
  } catch { /* ignore readdir errors */ }
  return cleaned;
}

/**
 * Clean up stale per-project content store DBs older than maxAgeDays.
 * Scans the given directory for *.db files and checks mtime.
 * Also detects stale WAL files that may block new connections.
 */
export function cleanupStaleContentDBs(contentDir: string, maxAgeDays: number): number {
  let cleaned = 0;
  try {
    if (!existsSync(contentDir)) return 0;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(contentDir).filter(f => f.endsWith(".db"));
    for (const file of files) {
      try {
        const filePath = join(contentDir, file);
        const mtime = statSync(filePath).mtimeMs;
        let shouldClean = mtime < cutoff;

        if (!shouldClean) {
          const walPath = filePath + "-wal";
          if (existsSync(walPath)) {
            try {
              const walStat = statSync(walPath);
              if (walStat.size > 0 && (Date.now() - walStat.mtimeMs) > 3600_000) {
                shouldClean = true;
              }
            } catch { /* ignore WAL check errors */ }
          }
        }

        if (shouldClean) {
          for (const suffix of ["", "-wal", "-shm"]) {
            try { unlinkSync(filePath + suffix); } catch { /* ignore */ }
          }
          cleaned++;
        }
      } catch { /* ignore per-file errors */ }
    }
  } catch { /* ignore readdir errors */ }
  return cleaned;
}
