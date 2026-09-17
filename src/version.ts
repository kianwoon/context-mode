/**
 * Single source of truth for the plugin version.
 *
 * Reads version from the package.json that sits one directory above this
 * file — which resolves to the repo root both in dev (src/version.ts) and in
 * the bundled build (build/index.js). This keeps the MCP server's advertised
 * version, package.json, and .claude-plugin/plugin.json from drifting apart.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION: string = readVersion();
