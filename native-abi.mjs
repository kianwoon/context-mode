/**
 * ABI-aware native binary caching for better-sqlite3.
 *
 * Users with mise/asdf may run concurrent Claude Code sessions with
 * different Node.js versions. Each ABI needs its own compiled binary.
 * This module caches per-ABI binaries side-by-side so switching between
 * Node versions is instant after the first encounter.
 *
 * @see https://github.com/mksglu/context-mode/issues/148
 */

import { existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

/**
 * Ensure better-sqlite3 native binary matches the current Node.js ABI.
 *
 * @param {string} pluginRoot — root directory containing node_modules/
 * @param {object} [opts] — options for testing
 * @param {boolean} [opts.skipProbe] — skip loading the binary to check ABI (for testing with fake binaries)
 * @param {function} [opts.rebuild] — custom rebuild function (for testing without running npm)
 */
export function ensureNativeCompat(pluginRoot, opts = {}) {
  try {
    const abi = process.versions.modules;
    const nativeDir = resolve(pluginRoot, "node_modules", "better-sqlite3", "build", "Release");
    const binaryPath = resolve(nativeDir, "better_sqlite3.node");
    const abiCachePath = resolve(nativeDir, `better_sqlite3.abi${abi}.node`);

    if (!existsSync(nativeDir)) return;

    if (existsSync(abiCachePath)) {
      // Fast path: cached binary for this ABI — swap it in
      copyFileSync(abiCachePath, binaryPath);
      return;
    }

    if (!existsSync(binaryPath)) return;

    if (opts.skipProbe) {
      // Testing mode: assume binary is compatible, just cache it
      copyFileSync(binaryPath, abiCachePath);
      return;
    }

    // Probe: try loading current binary to check ABI compatibility
    try {
      const req = createRequire(resolve(pluginRoot, "package.json"));
      req("better-sqlite3");
      // Compatible — cache for future sessions
      copyFileSync(binaryPath, abiCachePath);
    } catch (probeErr) {
      if (probeErr?.message?.includes("NODE_MODULE_VERSION")) {
        // ABI mismatch — rebuild
        const rebuildFn = opts.rebuild ?? (() => {
          execSync("npm rebuild better-sqlite3", {
            cwd: pluginRoot,
            stdio: "pipe",
            timeout: 60000,
          });
        });
        rebuildFn();
        if (existsSync(binaryPath)) {
          copyFileSync(binaryPath, abiCachePath);
        }
      }
    }
  } catch {
    /* best effort — server will report the error on first DB access */
  }
}
