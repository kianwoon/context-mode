import type { SearchResult } from "./types.js";

export const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "his", "how", "its", "may",
  "new", "now", "old", "see", "way", "who", "did", "get", "got", "let",
  "say", "she", "too", "use", "will", "with", "this", "that", "from",
  "they", "been", "have", "many", "some", "them", "than", "each", "make",
  "like", "just", "over", "such", "take", "into", "year", "your", "good",
  "could", "would", "about", "which", "their", "there", "other", "after",
  "should", "through", "also", "more", "most", "only", "very", "when",
  "what", "then", "these", "those", "being", "does", "done", "both",
  "same", "still", "while", "where", "here", "were", "much",
]);

function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

export function tokenizeQuery(query: string, minLength = 2): string[] {
  return dedupeTokens(
    query
      .toLowerCase()
      .replace(/['"(){}[\]*:^~]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= minLength && !["and", "or", "not", "near"].includes(w)),
  );
}

export function meaningfulQueryTerms(query: string, minLength = 2): string[] {
  const terms = tokenizeQuery(query, minLength);
  const filtered = terms.filter((w) => !STOPWORDS.has(w));
  return filtered.length > 0 ? filtered : terms;
}

export function sanitizeQuery(query: string, mode: "AND" | "OR" = "OR"): string {
  const words = dedupeTokens(
    query
      .replace(/['"(){}[\]*:^~]/g, " ")
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 0 &&
          !["AND", "OR", "NOT", "NEAR"].includes(w.toUpperCase()),
      ),
  );

  if (words.length === 0) return '""';

  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const final = meaningful.length > 0 ? meaningful : words;

  return final.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

export function sanitizeTrigramQuery(query: string, mode: "AND" | "OR" = "OR"): string {
  const cleaned = query.replace(/["'(){}[\]*:^~]/g, "").trim();
  if (cleaned.length < 3) return "";
  const words = dedupeTokens(
    cleaned.split(/\s+/).filter((w) => w.length >= 3),
  );
  if (words.length === 0) return "";

  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const final = meaningful.length > 0 ? meaningful : words;

  return final.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

export function maxEditDistance(wordLength: number): number {
  if (wordLength <= 4) return 1;
  if (wordLength <= 12) return 2;
  return 3;
}

export function findAllPositions(text: string, term: string): number[] {
  const positions: number[] = [];
  let idx = text.indexOf(term);
  while (idx !== -1) {
    positions.push(idx);
    idx = text.indexOf(term, idx + 1);
  }
  return positions;
}

export function findMinSpan(positionLists: number[][]): number {
  if (positionLists.length === 0) return Infinity;
  if (positionLists.length === 1) return 0;

  const sorted = positionLists.map((p) => [...p].sort((a, b) => a - b));
  const ptrs = new Array(sorted.length).fill(0);
  let minSpan = Infinity;

  while (true) {
    let curMin = Infinity;
    let curMax = -Infinity;
    let minIdx = 0;

    for (let i = 0; i < sorted.length; i++) {
      const val = sorted[i][ptrs[i]];
      if (val < curMin) {
        curMin = val;
        minIdx = i;
      }
      if (val > curMax) {
        curMax = val;
      }
    }

    const span = curMax - curMin;
    if (span < minSpan) minSpan = span;

    ptrs[minIdx]++;
    if (ptrs[minIdx] >= sorted[minIdx].length) break;
  }

  return minSpan;
}

export function buildEvidenceSnippet(
  result: SearchResult,
  query: string,
  contextLines = 2,
): { snippet: string; lineRange: [number, number] } {
  const lines = result.content.split("\n");
  const terms = meaningfulQueryTerms(query, 2);
  const hitLine = lines.findIndex((line) => {
    const lower = line.toLowerCase();
    return terms.some((term) => lower.includes(term));
  });

  const center = hitLine >= 0 ? hitLine : 0;
  const start = Math.max(0, center - contextLines);
  const end = Math.min(lines.length - 1, center + contextLines);
  const snippet = lines.slice(start, end + 1).join("\n");
  return { snippet, lineRange: [start + 1, end + 1] };
}
