/**
 * security-wrapper — Server-side deny firewall.
 *
 * Thin wrappers around security.ts that return ToolResult errors
 * when commands/paths match deny patterns.  Used by execute-type tools.
 */
import {
  readBashPolicies,
  evaluateCommandDenyOnly,
  extractShellCommands,
  readToolDenyPatterns,
  evaluateFilePath,
} from "../security.js";
import type { ToolResult } from "./session-stats.js";

/**
 * Check a shell command against Bash deny patterns.
 * Returns an error ToolResult if denied, or null if allowed.
 */
export function checkDenyPolicy(
  command: string,
  toolName: string,
  trackResponse: (toolName: string, response: ToolResult) => ToolResult,
): ToolResult | null {
  try {
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    const result = evaluateCommandDenyOnly(command, policies);
    if (result.decision === "deny") {
      return trackResponse(toolName, {
        content: [{
          type: "text" as const,
          text: `Command blocked by security policy: matches deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      });
    }
  } catch {
    // Security check failed — allow through (fail-open for server,
    // hooks are the primary enforcement layer)
  }
  return null;
}

/**
 * Check non-shell code for shell-escape calls against deny patterns.
 */
export function checkNonShellDenyPolicy(
  code: string,
  language: string,
  toolName: string,
  trackResponse: (toolName: string, response: ToolResult) => ToolResult,
): ToolResult | null {
  try {
    const commands = extractShellCommands(code, language);
    if (commands.length === 0) return null;
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    for (const cmd of commands) {
      const result = evaluateCommandDenyOnly(cmd, policies);
      if (result.decision === "deny") {
        return trackResponse(toolName, {
          content: [{
            type: "text" as const,
            text: `Command blocked by security policy: embedded shell command "${cmd}" matches deny pattern ${result.matchedPattern}`,
          }],
          isError: true,
        });
      }
    }
  } catch {
    // Fail-open
  }
  return null;
}

/**
 * Check a file path against Read deny patterns.
 * Returns an error ToolResult if denied, or null if allowed.
 */
export function checkFilePathDenyPolicy(
  filePath: string,
  toolName: string,
  trackResponse: (toolName: string, response: ToolResult) => ToolResult,
): ToolResult | null {
  try {
    const denyGlobs = readToolDenyPatterns("Read", process.env.CLAUDE_PROJECT_DIR);
    const result = evaluateFilePath(filePath, denyGlobs);
    if (result.denied) {
      return trackResponse(toolName, {
        content: [{
          type: "text" as const,
          text: `File access blocked by security policy: path matches Read deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      });
    }
  } catch {
    // Fail-open
  }
  return null;
}
