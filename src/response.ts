import type { SearchResult } from "./types.js";
import { buildEvidenceSnippet } from "./search-utils.js";
import { capBytes } from "./truncate.js";

export type SearchOutputMode = "snippets" | "full";

export function formatSearchMatch(
  match: SearchResult,
  query: string,
  mode: SearchOutputMode = "snippets",
): string {
  const ids = [
    match.chunkId != null ? `chunkId=${match.chunkId}` : null,
    match.sourceId != null ? `sourceId=${match.sourceId}` : null,
    match.matchLayer ? `layer=${match.matchLayer}` : null,
    match.contentType ? `type=${match.contentType}` : null,
  ].filter(Boolean).join(" ");

  if (mode === "full") {
    return `**${match.title}** [${match.source}] ${ids}\n${match.content}\n`;
  }

  const evidence = buildEvidenceSnippet(match, query);
  const range = `lines ${evidence.lineRange[0]}-${evidence.lineRange[1]}`;
  return [
    `**${match.title}** [${match.source}] ${ids} ${range}`,
    capBytes(evidence.snippet, 1200),
    "",
  ].join("\n");
}

export function formatInventory(
  sections: SearchResult[],
  maxItems = 20,
): string[] {
  const out = ["## Indexed Sections", ""];
  for (const s of sections.slice(0, maxItems)) {
    const kb = (Buffer.byteLength(s.content) / 1024).toFixed(1);
    const id = s.chunkId != null ? ` chunkId=${s.chunkId}` : "";
    out.push(`- ${s.title} (${kb}KB${id})`);
  }
  if (sections.length > maxItems) {
    out.push(`- ... ${sections.length - maxItems} more sections`);
  }
  return out;
}
