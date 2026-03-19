/**
 * Consolidated CLI tests
 *
 * Combines:
 *   - cli-bundle.test.ts (marketplace install support)
 *   - cli-hook-path.test.ts (forward-slash hook paths)
 *   - package-exports.test.ts (public API surface)
 */
import { describe, it, test, expect, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync, existsSync, accessSync, constants, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { toUnixPath } from "../../src/cli.js";

const ROOT = resolve(import.meta.dirname, "../..");

// ── cli.bundle.mjs — marketplace install support ──────────────────────

describe("cli.bundle.mjs — marketplace install support", () => {
  // ── Package configuration ─────────────────────────────────

  it("package.json files field includes cli.bundle.mjs", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.files).toContain("cli.bundle.mjs");
  });

  it("package.json bundle script builds cli.bundle.mjs", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts.bundle).toContain("cli.bundle.mjs");
    expect(pkg.scripts.bundle).toContain("src/cli.ts");
  });

  // ── Bundle artifact ────────────────────────────────────────

  it("cli.bundle.mjs exists after npm run bundle", () => {
    expect(existsSync(resolve(ROOT, "cli.bundle.mjs"))).toBe(true);
  });

  it("cli.bundle.mjs is readable", () => {
    expect(() => accessSync(resolve(ROOT, "cli.bundle.mjs"), constants.R_OK)).not.toThrow();
  });

  it("cli.bundle.mjs has shebang only on line 1 (Node.js strips it)", () => {
    const content = readFileSync(resolve(ROOT, "cli.bundle.mjs"), "utf-8");
    const lines = content.split("\n");
    expect(lines[0].startsWith("#!")).toBe(true);
    // No shebang on any other line (would cause SyntaxError)
    const shebangsAfterLine1 = lines.slice(1).filter(l => l.startsWith("#!"));
    expect(shebangsAfterLine1).toHaveLength(0);
  });

  // ── Source code contracts ──────────────────────────────────

  it("cli.ts getPluginRoot handles both build/ and root locations", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    // Must detect build/ subdirectory and go up, or stay at root
    expect(src).toContain('endsWith("/build")');
    expect(src).toContain('endsWith("\\\\build")');
  });

  it("cli.ts upgrade copies cli.bundle.mjs to target", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    expect(src).toContain('"cli.bundle.mjs"');
    // Must be in the items array for in-place update
    expect(src).toMatch(/items\s*=\s*\[[\s\S]*?"cli\.bundle\.mjs"/);
  });

  it("cli.ts upgrade doctor call prefers cli.bundle.mjs with fallback", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    expect(src).toContain("cli.bundle.mjs");
    expect(src).toContain("build", "cli.js");
    // Must use existsSync for fallback
    expect(src).toContain("existsSync");
  });

  it("cli.ts upgrade rebuilds better-sqlite3 native addon after deps install", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    // Extract only the upgrade function body (starts with "async function upgrade")
    const upgradeStart = src.indexOf("async function upgrade");
    expect(upgradeStart).toBeGreaterThan(-1);
    const upgradeSrc = src.slice(upgradeStart);
    // Must rebuild native addons between production deps and global install
    const depsIdx = upgradeSrc.indexOf("npm install --production");
    const rebuildIdx = upgradeSrc.indexOf('execSync("npm rebuild better-sqlite3"');
    const globalIdx = upgradeSrc.indexOf("npm install -g");
    expect(depsIdx).toBeGreaterThan(-1);
    expect(rebuildIdx).toBeGreaterThan(-1);
    expect(globalIdx).toBeGreaterThan(-1);
    // rebuild must come after deps and before global install
    expect(rebuildIdx).toBeGreaterThan(depsIdx);
    expect(rebuildIdx).toBeLessThan(globalIdx);
  });

  it("cli.ts upgrade chmod handles both cli binaries", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    // Must chmod both build/cli.js and cli.bundle.mjs
    expect(src).toMatch(/for\s*\(.*\["build\/cli\.js",\s*"cli\.bundle\.mjs"\]/);
  });

  // ── Skill files ────────────────────────────────────────────

  it("ctx-upgrade skill uses cli.bundle.mjs with fallback", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-upgrade", "SKILL.md"), "utf-8");
    expect(skill).toContain("cli.bundle.mjs");
    expect(skill).toContain("build/cli.js");
    // Fallback pattern: try bundle first, then build
    expect(skill).toMatch(/CLI=.*cli\.bundle\.mjs.*\[ ! -f.*\].*build\/cli\.js/);
  });

  it("ctx-doctor skill uses cli.bundle.mjs with fallback", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-doctor", "SKILL.md"), "utf-8");
    expect(skill).toContain("cli.bundle.mjs");
    expect(skill).toContain("build/cli.js");
    expect(skill).toMatch(/CLI=.*cli\.bundle\.mjs.*\[ ! -f.*\].*build\/cli\.js/);
  });

  // ── .gitignore ─────────────────────────────────────────────

  it(".gitignore excludes bundle files (CI uses git add -f)", () => {
    const gitignore = readFileSync(resolve(ROOT, ".gitignore"), "utf-8");
    expect(gitignore).toContain("server.bundle.mjs");
    expect(gitignore).toContain("cli.bundle.mjs");
  });
});

// ── .mcp.json — MCP server config ────────────────────────────────────

describe(".mcp.json — MCP server config", () => {
  it("upgrade writes .mcp.json with resolved absolute path, not ${CLAUDE_PLUGIN_ROOT}", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    const upgradeStart = src.indexOf("async function upgrade");
    const upgradeSrc = src.slice(upgradeStart);
    // items array must NOT include .mcp.json (it's written dynamically)
    const itemsMatch = upgradeSrc.match(/const items\s*=\s*\[([\s\S]*?)\];/);
    expect(itemsMatch).not.toBeNull();
    expect(itemsMatch![1]).not.toContain(".mcp.json");
    // Must write .mcp.json dynamically with resolve()
    expect(upgradeSrc).toContain('resolve(pluginRoot, "start.mjs")');
    expect(upgradeSrc).toContain('resolve(pluginRoot, ".mcp.json")');
  });

  it("template .mcp.json keeps ${CLAUDE_PLUGIN_ROOT} for marketplace compatibility", () => {
    const mcp = JSON.parse(readFileSync(resolve(ROOT, ".mcp.json"), "utf-8"));
    const args = mcp.mcpServers["context-mode"].args;
    expect(args[0]).toContain("CLAUDE_PLUGIN_ROOT");
  });
});

// ── CLI Hook Path Tests ───────────────────────────────────────────────

describe("CLI Hook Path Tests", () => {
  test("toUnixPath: converts backslashes to forward slashes", () => {
    const input = "C:\\Users\\xxx\\AppData\\Local\\npm-cache\\_npx\\hooks\\pretooluse.mjs";
    const result = toUnixPath(input);
    assert.ok(
      !result.includes("\\"),
      `Expected no backslashes, got: ${result}`,
    );
    assert.equal(
      result,
      "C:/Users/xxx/AppData/Local/npm-cache/_npx/hooks/pretooluse.mjs",
    );
  });

  test("toUnixPath: leaves forward-slash paths unchanged", () => {
    const input = "/home/user/.claude/plugins/context-mode/hooks/pretooluse.mjs";
    const result = toUnixPath(input);
    assert.equal(result, input);
  });

  test("toUnixPath: handles mixed slashes", () => {
    const input = "C:/Users\\xxx/AppData\\Local\\hooks/pretooluse.mjs";
    const result = toUnixPath(input);
    assert.ok(!result.includes("\\"), `Expected no backslashes, got: ${result}`);
  });

  test("toUnixPath: hook command string has no backslashes", () => {
    // Simulate what upgrade() does: "node " + resolve(...)
    // On Windows, resolve() returns backslashes — toUnixPath must normalize them
    const windowsPath = "C:\\Users\\xxx\\.claude\\plugins\\cache\\context-mode\\hooks\\pretooluse.mjs";
    const command = "node " + toUnixPath(windowsPath);
    assert.ok(
      !command.includes("\\"),
      `Hook command must not contain backslashes: ${command}`,
    );
  });

  test("toUnixPath: sessionstart path has no backslashes", () => {
    const windowsPath = "C:\\Users\\xxx\\.claude\\plugins\\cache\\context-mode\\hooks\\sessionstart.mjs";
    const command = "node " + toUnixPath(windowsPath);
    assert.ok(
      !command.includes("\\"),
      `SessionStart command must not contain backslashes: ${command}`,
    );
  });
});

// ── ABI-aware native binary caching (#148) ────────────────────────────

describe("ABI-aware native binary caching (#148)", () => {
  let tempDir: string;
  let releaseDir: string;
  let binaryPath: string;

  const currentAbi = process.versions.modules; // e.g. "115"

  function abiCachePath(abi: string = currentAbi): string {
    return join(releaseDir, `better_sqlite3.abi${abi}.node`);
  }

  function createFakeBinary(path: string, content: string = "fake-binary"): void {
    writeFileSync(path, content);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "abi-test-"));
    releaseDir = join(tempDir, "node_modules", "better-sqlite3", "build", "Release");
    binaryPath = join(releaseDir, "better_sqlite3.node");
    mkdirSync(releaseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("cache hit: copies cached ABI binary to active path", async () => {
    const { ensureNativeCompat } = await import("../../native-abi.mjs");

    // Set up: cached binary for current ABI exists, active binary has different content
    createFakeBinary(abiCachePath(), "abi-cached-binary");
    createFakeBinary(binaryPath, "old-binary");

    ensureNativeCompat(tempDir);

    // Active binary should now match the cached version
    expect(readFileSync(binaryPath, "utf-8")).toBe("abi-cached-binary");
  });

  test("cache miss + compatible: caches current binary for future sessions", async () => {
    const { ensureNativeCompat } = await import("../../native-abi.mjs");

    // Set up: active binary exists but no ABI cache yet
    // We can't actually load this fake binary, so we test with skipProbe option
    createFakeBinary(binaryPath, "compatible-binary");

    ensureNativeCompat(tempDir, { skipProbe: true });

    // Should have created an ABI cache file
    expect(existsSync(abiCachePath())).toBe(true);
    expect(readFileSync(abiCachePath(), "utf-8")).toBe("compatible-binary");
  });

  test("missing release directory: does not throw", async () => {
    const { ensureNativeCompat } = await import("../../native-abi.mjs");

    // Remove the release dir
    rmSync(releaseDir, { recursive: true });

    expect(() => ensureNativeCompat(tempDir)).not.toThrow();
  });

  test("missing binary + no cache: does not throw", async () => {
    const { ensureNativeCompat } = await import("../../native-abi.mjs");

    // Release dir exists but no binary
    expect(() => ensureNativeCompat(tempDir)).not.toThrow();
  });

  test("cache hit does not trigger rebuild", async () => {
    const { ensureNativeCompat } = await import("../../native-abi.mjs");

    let rebuildCalled = false;
    createFakeBinary(abiCachePath(), "cached");
    createFakeBinary(binaryPath, "old");

    ensureNativeCompat(tempDir, {
      rebuild: () => { rebuildCalled = true; },
    });

    expect(rebuildCalled).toBe(false);
    expect(readFileSync(binaryPath, "utf-8")).toBe("cached");
  });

  test("cross-platform: ABI cache filename uses correct format", async () => {
    const { ensureNativeCompat } = await import("../../native-abi.mjs");

    createFakeBinary(binaryPath, "binary");
    ensureNativeCompat(tempDir, { skipProbe: true });

    // Cache file should be named better_sqlite3.abi{N}.node
    const files = readdirSync(releaseDir);
    const cacheFiles = files.filter(f => f.match(/^better_sqlite3\.abi\d+\.node$/));
    expect(cacheFiles).toHaveLength(1);
    expect(cacheFiles[0]).toBe(`better_sqlite3.abi${currentAbi}.node`);
  });

  test("multiple ABI caches coexist without interference", async () => {
    const { ensureNativeCompat } = await import("../../native-abi.mjs");

    // Simulate: two ABI caches already exist + active binary
    createFakeBinary(join(releaseDir, "better_sqlite3.abi115.node"), "node20-binary");
    createFakeBinary(join(releaseDir, "better_sqlite3.abi137.node"), "node24-binary");
    createFakeBinary(binaryPath, "old");

    ensureNativeCompat(tempDir);

    // Should copy the correct ABI's cached binary
    const expected = currentAbi === "115" ? "node20-binary" : currentAbi === "137" ? "node24-binary" : undefined;
    if (expected) {
      expect(readFileSync(binaryPath, "utf-8")).toBe(expected);
    }

    // Both cache files should still exist
    expect(existsSync(join(releaseDir, "better_sqlite3.abi115.node"))).toBe(true);
    expect(existsSync(join(releaseDir, "better_sqlite3.abi137.node"))).toBe(true);
  });
});

// ── Package exports ───────────────────────────────────────────────────

describe("Package exports", () => {
  test("default export exposes ContextModePlugin factory", async () => {
    const mod = await import("../../src/opencode-plugin.js");
    expect(mod.ContextModePlugin).toBeDefined();
    expect(typeof mod.ContextModePlugin).toBe("function");
  });

  test("default export does not leak CLI internals", async () => {
    const mod = (await import("../../src/opencode-plugin.js")) as any;
    expect(mod.toUnixPath).toBeUndefined();
    expect(mod.doctor).toBeUndefined();
    expect(mod.upgrade).toBeUndefined();
  });
});
