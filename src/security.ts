import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ==============================================================================
// Types
// ==============================================================================

export type PermissionDecision = "allow" | "deny" | "ask";

export interface SecurityPolicy {
  allow: string[];
  deny: string[];
  ask: string[];
}

// ==============================================================================
// Pattern Parsing
// ==============================================================================

/**
 * Extract the glob from a Bash permission pattern.
 * "Bash(sudo *)" returns "sudo *", "Read(.env)" returns null.
 */
export function parseBashPattern(pattern: string): string | null {
  // Non-greedy: for "Bash(echo (foo))" captures "echo (foo)" correctly
  const match = pattern.match(/^Bash\((.+?)\)$/);
  return match ? match[1] : null;
}

/**
 * Parse any tool permission pattern like "ToolName(glob)".
 * Returns { tool, glob } or null if not a valid pattern.
 */
export function parseToolPattern(
  pattern: string,
): { tool: string; glob: string } | null {
  // Non-greedy: for "Read(some(path))" captures "some(path)" correctly
  const match = pattern.match(/^(\w+)\((.+?)\)$/);
  return match ? { tool: match[1], glob: match[2] } : null;
}

// ==============================================================================
// Glob-to-Regex Conversion
// ==============================================================================

/** Escape all regex special characters (including *). */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\\/\-]/g, "\\$&");
}

/** Escape regex specials except *, then convert * to .* */
function convertGlobPart(glob: string): string {
  return glob
    .replace(/[.+?^${}()|[\]\\\/\-]/g, "\\$&")
    .replace(/\*/g, ".*");
}

/**
 * Convert a Bash permission glob to a regex.
 *
 * Two formats:
 * - Colon: "tree:*" becomes /^tree(\s.*)?$/ (command with optional args)
 * - Space: "sudo *" becomes /^sudo .*$/  (literal glob match)
 */
export function globToRegex(
  glob: string,
  caseInsensitive: boolean = false,
): RegExp {
  let regexStr: string;

  const colonIdx = glob.indexOf(":");
  if (colonIdx !== -1) {
    // Colon format: "command:argsGlob"
    const command = glob.slice(0, colonIdx);
    const argsGlob = glob.slice(colonIdx + 1);
    const escapedCmd = escapeRegex(command);
    const argsRegex = convertGlobPart(argsGlob);
    // Match command alone OR command + space + args
    regexStr = `^${escapedCmd}(\\s${argsRegex})?$`;
  } else {
    // Plain glob: "sudo *", "ls*", "* commit *"
    regexStr = `^${convertGlobPart(glob)}$`;
  }

  return new RegExp(regexStr, caseInsensitive ? "i" : "");
}

/**
 * Convert a file path glob to a regex.
 *
 * Unlike `globToRegex` (which handles command patterns with colon and
 * space semantics), this handles file path globs where:
 * - `**` matches any number of path segments (including zero)
 * - `*` matches anything except path separators
 * - Paths are matched with forward slashes (callers normalize first)
 */
export function fileGlobToRegex(
  glob: string,
  caseInsensitive: boolean = false,
): RegExp {
  let regexStr = "";
  let i = 0;

  while (i < glob.length) {
    // Handle ** (globstar): match any number of directory segments
    if (glob[i] === "*" && glob[i + 1] === "*") {
      // **/ at the start or after a slash means "zero or more directories"
      if (i + 2 < glob.length && glob[i + 2] === "/") {
        regexStr += "(.*/)?";
        i += 3; // skip "*" "*" "/"
      } else {
        // Trailing ** matches everything
        regexStr += ".*";
        i += 2;
      }
    } else if (glob[i] === "*") {
      // Single * matches anything except /
      regexStr += "[^/]*";
      i++;
    } else if (glob[i] === "?") {
      regexStr += "[^/]";
      i++;
    } else {
      // Escape regex-special characters
      regexStr += glob[i].replace(/[.+^${}()|[\]\\\/\-]/g, "\\$&");
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`, caseInsensitive ? "i" : "");
}

/**
 * Check if a command matches any Bash pattern in the list.
 * Returns the matching pattern string, or null.
 */
export function matchesAnyPattern(
  command: string,
  patterns: string[],
  caseInsensitive: boolean = false,
): string | null {
  for (const pattern of patterns) {
    const glob = parseBashPattern(pattern);
    if (!glob) continue;
    if (globToRegex(glob, caseInsensitive).test(command)) return pattern;
  }
  return null;
}

// ==============================================================================
// Chained Command Splitting
// ==============================================================================

/**
 * Split a shell command on chain operators (&&, ||, ;, |) while
 * respecting single/double quotes and backticks.
 *
 * "echo hello && sudo rm -rf /" → ["echo hello", "sudo rm -rf /"]
 *
 * This prevents bypassing deny patterns by prepending innocent commands.
 */
export function splitChainedCommands(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const prev = i > 0 ? command[i - 1] : "";

    if (ch === "'" && !inDouble && !inBacktick && prev !== "\\") {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle && !inBacktick && prev !== "\\") {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === "`" && !inSingle && !inDouble && prev !== "\\") {
      inBacktick = !inBacktick;
      current += ch;
    } else if (!inSingle && !inDouble && !inBacktick) {
      if (ch === ";") {
        parts.push(current.trim());
        current = "";
      } else if (ch === "|" && command[i + 1] === "|") {
        parts.push(current.trim());
        current = "";
        i++; // skip second |
      } else if (ch === "&" && command[i + 1] === "&") {
        parts.push(current.trim());
        current = "";
        i++; // skip second &
      } else if (ch === "|") {
        // Single pipe — left side is a command too
        parts.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

// ==============================================================================
// Settings Cache
// ==============================================================================

interface SettingsCacheEntry {
  mtime: number | null;
  data: SecurityPolicy | null;
}

interface SettingsCache {
  localProject: SettingsCacheEntry;
  sharedProject: SettingsCacheEntry;
  global: SettingsCacheEntry;
}

const settingsCache: SettingsCache = {
  localProject: { mtime: null, data: null },
  sharedProject: { mtime: null, data: null },
  global: { mtime: null, data: null },
};

interface RawSettingsCacheEntry {
  mtime: number | null;
  data: string[][] | null;
}

interface RawSettingsCache {
  localProject: RawSettingsCacheEntry;
  sharedProject: RawSettingsCacheEntry;
  global: RawSettingsCacheEntry;
}

const rawSettingsCache: RawSettingsCache = {
  localProject: { mtime: null, data: null },
  sharedProject: { mtime: null, data: null },
  global: { mtime: null, data: null },
};

/**
 * Read settings file with mtime-based caching.
 * Returns cached result if file modification time hasn't changed.
 */
function readCachedSettings(
  filePath: string | null,
  cache: SettingsCacheEntry,
): SecurityPolicy | null {
  if (!filePath) return null;

  try {
    const stat = statSync(filePath);
    if (cache.mtime === stat.mtimeMs && cache.data !== null) {
      return cache.data; // Cache hit — mtime unchanged
    }
    // Cache miss or first read
    const result = readSingleSettings(filePath);
    cache.mtime = stat.mtimeMs;
    cache.data = result;
    return result;
  } catch {
    return null;
  }
}

/**
 * Read raw settings file with mtime-based caching.
 * Used by readToolDenyPatterns which needs raw globs, not SecurityPolicy.
 */
function readCachedToolDenyGlobs(
  filePath: string | null,
  toolName: string,
  cache: RawSettingsCacheEntry,
): string[] | null {
  if (!filePath) return null;

  try {
    const stat = statSync(filePath);
    if (cache.mtime === stat.mtimeMs && cache.data !== null) {
      const cached = cache.data;
      // Return the globs for the requested tool from the cached result
      const toolGlobs = cached
        .filter((entry) => entry[0] === toolName)
        .map((entry) => entry[1]);
      return toolGlobs;
    }
    // Cache miss or first read — read the raw file and extract ALL tool deny globs
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const perms = (parsed?.permissions ?? {}) as Record<string, unknown>;
    const deny = perms.deny;
    if (!Array.isArray(deny)) return [];

    // Index all tool deny globs for this file
    const allGlobs: string[][] = [];
    for (const entry of deny) {
      if (typeof entry !== "string") continue;
      const tp = parseToolPattern(entry);
      if (tp) {
        allGlobs.push([tp.tool, tp.glob]);
      }
    }
    cache.mtime = stat.mtimeMs;
    cache.data = allGlobs;

    // Return globs for the requested tool
    return allGlobs
      .filter((entry) => entry[0] === toolName)
      .map((entry) => entry[1]);
  } catch {
    return null;
  }
}

// ==============================================================================
// Settings Reader
// ==============================================================================

/** Read one settings file and return a SecurityPolicy with only Bash patterns. */
function readSingleSettings(path: string): SecurityPolicy | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const perms = parsed?.permissions;
  if (!perms || typeof perms !== "object") return null;

  const permsRec = perms as Record<string, unknown>;

  const filterBash = (arr: unknown): string[] => {
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p): p is string => typeof p === "string" && parseBashPattern(p) !== null,
    );
  };

  return {
    allow: filterBash(permsRec.allow),
    deny: filterBash(permsRec.deny),
    ask: filterBash(permsRec.ask),
  };
}

/**
 * Read Bash permission policies from up to 3 settings files.
 *
 * Returns policies in precedence order (most local first):
 *   1. .claude/settings.local.json  (project-local)
 *   2. .claude/settings.json        (project-shared)
 *   3. ~/.claude/settings.json      (global)
 *
 * Missing or invalid files are silently skipped.
 */
export function readBashPolicies(
  projectDir?: string,
  globalSettingsPath?: string,
): SecurityPolicy[] {
  const policies: SecurityPolicy[] = [];

  if (projectDir) {
    const localPath = resolve(projectDir, ".claude", "settings.local.json");
    const localPolicy = readCachedSettings(localPath, settingsCache.localProject);
    if (localPolicy) policies.push(localPolicy);

    const sharedPath = resolve(projectDir, ".claude", "settings.json");
    const sharedPolicy = readCachedSettings(sharedPath, settingsCache.sharedProject);
    if (sharedPolicy) policies.push(sharedPolicy);
  }

  const globalPath =
    globalSettingsPath ?? resolve(homedir(), ".claude", "settings.json");
  const globalPolicy = readCachedSettings(globalPath, settingsCache.global);
  if (globalPolicy) policies.push(globalPolicy);

  return policies;
}

/**
 * Read deny patterns for a specific tool from settings files.
 *
 * Reads the same 3-tier settings as `readBashPolicies`, but extracts
 * only deny globs for the given tool. Used for Read and Grep enforcement
 * — checks if file paths should be blocked by deny patterns.
 *
 * Returns an array of arrays (one per settings file, in precedence order).
 * Each inner array contains the extracted glob strings.
 */
export function readToolDenyPatterns(
  toolName: string,
  projectDir?: string,
  globalSettingsPath?: string,
): string[][] {
  const result: string[][] = [];

  if (projectDir) {
    const localGlobs = readCachedToolDenyGlobs(
      resolve(projectDir, ".claude", "settings.local.json"),
      toolName,
      rawSettingsCache.localProject,
    );
    if (localGlobs !== null) result.push(localGlobs);

    const sharedGlobs = readCachedToolDenyGlobs(
      resolve(projectDir, ".claude", "settings.json"),
      toolName,
      rawSettingsCache.sharedProject,
    );
    if (sharedGlobs !== null) result.push(sharedGlobs);
  }

  const globalPath =
    globalSettingsPath ?? resolve(homedir(), ".claude", "settings.json");
  const globalGlobs = readCachedToolDenyGlobs(
    globalPath,
    toolName,
    rawSettingsCache.global,
  );
  if (globalGlobs !== null) result.push(globalGlobs);

  return result;
}

// ==============================================================================
// Decision Engine
// ==============================================================================

interface CommandDecision {
  decision: PermissionDecision;
  matchedPattern?: string;
}

/**
 * Evaluate a command against policies in precedence order.
 *
 * Splits chained commands (&&, ||, ;, |) and checks each segment
 * against deny patterns — prevents bypassing deny by prepending
 * innocent commands like "echo ok && sudo rm -rf /".
 *
 * Within each policy: deny > ask > allow (most restrictive wins).
 * First definitive match across policies wins.
 * Default (no match in any policy): "ask".
 */
export function evaluateCommand(
  command: string,
  policies: SecurityPolicy[],
  caseInsensitive: boolean = process.platform === "win32",
): CommandDecision {
  // Check each segment of chained commands against deny patterns
  const segments = splitChainedCommands(command);
  for (const segment of segments) {
    for (const policy of policies) {
      const denyMatch = matchesAnyPattern(segment, policy.deny, caseInsensitive);
      if (denyMatch) return { decision: "deny", matchedPattern: denyMatch };
    }
  }

  // Check ask/allow against the full command (original behavior)
  for (const policy of policies) {
    const askMatch = matchesAnyPattern(command, policy.ask, caseInsensitive);
    if (askMatch) return { decision: "ask", matchedPattern: askMatch };

    const allowMatch = matchesAnyPattern(
      command,
      policy.allow,
      caseInsensitive,
    );
    if (allowMatch) return { decision: "allow", matchedPattern: allowMatch };
  }

  return { decision: "ask" };
}

/**
 * Server-side variant: only enforce deny patterns.
 *
 * The server has no UI for "ask" prompts, so allow/ask patterns are
 * irrelevant. Returns "deny" if any deny pattern matches, otherwise "allow".
 *
 * Also splits chained commands to prevent bypass.
 */
export function evaluateCommandDenyOnly(
  command: string,
  policies: SecurityPolicy[],
  caseInsensitive: boolean = process.platform === "win32",
): { decision: "deny" | "allow"; matchedPattern?: string } {
  const segments = splitChainedCommands(command);
  for (const segment of segments) {
    for (const policy of policies) {
      const denyMatch = matchesAnyPattern(segment, policy.deny, caseInsensitive);
      if (denyMatch) return { decision: "deny", matchedPattern: denyMatch };
    }
  }

  return { decision: "allow" };
}

// ==============================================================================
// File Path Evaluation
// ==============================================================================

/**
 * Check if a file path should be denied based on deny globs.
 *
 * Normalizes backslashes to forward slashes before matching so that
 * Windows paths work with Unix-style glob patterns.
 */
export function evaluateFilePath(
  filePath: string,
  denyGlobs: string[][],
  caseInsensitive: boolean = process.platform === "win32",
): { denied: boolean; matchedPattern?: string } {
  // Normalize backslashes to forward slashes for cross-platform matching
  const normalized = filePath.replace(/\\/g, "/");

  for (const globs of denyGlobs) {
    for (const glob of globs) {
      if (fileGlobToRegex(glob, caseInsensitive).test(normalized)) {
        return { denied: true, matchedPattern: glob };
      }
    }
  }

  return { denied: false };
}

// ==============================================================================
// Shell-Escape Scanner
// ==============================================================================

// Regex patterns that detect shell-escape calls in non-shell languages.
// Each pattern uses capture groups so that the embedded command string
// can be extracted from the last non-quote group.
//
// NOTE: These regexes contain literal strings like "execSync" — they are
// patterns for *detecting* shell escapes in user code, not actual usage.
const SHELL_ESCAPE_PATTERNS: Record<string, RegExp[]> = {
  python: [
    /os\.system\(\s*(['"])(.*?)\1\s*\)/g,
    /subprocess\.(?:run|call|Popen|check_output|check_call)\(\s*(['"])(.*?)\1/g,
  ],
  javascript: [
    /exec(?:Sync|File|FileSync)?\(\s*(['"`])(.*?)\1/g,
    /spawn(?:Sync)?\(\s*(['"`])(.*?)\1/g,
  ],
  typescript: [
    /exec(?:Sync|File|FileSync)?\(\s*(['"`])(.*?)\1/g,
    /spawn(?:Sync)?\(\s*(['"`])(.*?)\1/g,
  ],
  ruby: [
    /system\(\s*(['"])(.*?)\1/g,
    /`(.*?)`/g,
  ],
  go: [
    /exec\.Command\(\s*(['"`])(.*?)\1/g,
  ],
  php: [
    /shell_exec\(\s*(['"`])(.*?)\1/g,
    /(?:^|[^.])exec\(\s*(['"`])(.*?)\1/g,
    /(?:^|[^.])system\(\s*(['"`])(.*?)\1/g,
    /passthru\(\s*(['"`])(.*?)\1/g,
    /proc_open\(\s*(['"`])(.*?)\1/g,
  ],
  rust: [
    /Command::new\(\s*(['"`])(.*?)\1/g,
  ],
};

/**
 * Extract all string elements from a Python subprocess list call.
 *
 * subprocess.run(["rm", "-rf", "/"]) → "rm -rf /"
 *
 * This catches the list-of-strings form that the single-string regex misses.
 */
function extractPythonSubprocessListArgs(code: string): string[] {
  const commands: string[] = [];
  const pattern =
    /subprocess\.(?:run|call|Popen|check_output|check_call)\(\s*\[([^\]]+)\]/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const listContent = match[1];
    const args = [...listContent.matchAll(/(['"])(.*?)\1/g)].map((m) => m[2]);
    if (args.length > 0) {
      commands.push(args.join(" "));
    }
  }

  return commands;
}

/**
 * Scan non-shell code for shell-escape calls and extract the embedded
 * command strings.
 *
 * Returns an array of command strings found in the code. For unknown
 * languages or code without shell-escape calls, returns an empty array.
 */
export function extractShellCommands(
  code: string,
  language: string,
): string[] {
  const patterns = SHELL_ESCAPE_PATTERNS[language];
  if (!patterns && language !== "python") return [];

  const commands: string[] = [];

  if (patterns) {
    for (const pattern of patterns) {
      // Reset lastIndex since we reuse the global regex
      pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.exec(code)) !== null) {
        // The command string is in the last capture group that isn't the
        // quote delimiter. For patterns with 2 groups (quote + content),
        // it's group 2. For Ruby backticks with 1 group, it's group 1.
        const command = match[match.length - 1];
        if (command) commands.push(command);
      }
    }
  }

  // Python: also extract subprocess list-form args
  if (language === "python") {
    commands.push(...extractPythonSubprocessListArgs(code));
  }

  return commands;
}
