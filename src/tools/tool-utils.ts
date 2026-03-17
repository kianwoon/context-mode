/**
 * Extract error message from unknown error value.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Threshold in bytes above which error output gets condensed. */
const ERROR_CONDENSE_THRESHOLD = 5_000;

/**
 * Condense large error output to first few lines.
 * Keeps exit code + first 3 content lines, truncates the rest.
 * Small errors (<=5KB) are returned as-is.
 */
export function condenseError(output: string): string {
  if (Buffer.byteLength(output) <= ERROR_CONDENSE_THRESHOLD) return output;

  const lines = output.split("\n");
  const totalLines = lines.length;

  // Keep first line (usually "Exit code: X") + first 3 non-empty content lines
  const firstLine = lines[0];
  const contentLines = lines.filter((l) => l.trim()).slice(1, 4);

  return (
    `${firstLine}\n${contentLines.join("\n")}\n` +
    `... ${totalLines - contentLines.length - 1} more lines. ` +
    `Use execute with intent to search error details.`
  );
}
