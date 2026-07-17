// FTS5 query handling — the single source for operator detection (previously
// duplicated across db ops, the AI orchestrator and the popup).

/** Detects text that already uses FTS5 syntax: column filters (kind:short,
 *  collection:"watch later"), quoted phrases, AND/OR/NOT/NEAR, parens, prefix
 *  stars, ^ anchors. Such queries pass through parsing untouched, and search
 *  routing keeps them on FTS (a semantic model can't honor operators). */
export const FTS_OPERATORS = /["():*^]|\b(AND|OR|NOT|NEAR)\b|\S:/;

/** Linkosh-local search flags, stripped from the text before it reaches FTS5.
 *  `is:starred` restricts results to starred items. starred_at is mutable UI
 *  state and deliberately not FTS-indexed (starring would churn the index),
 *  so the flag becomes a SQL filter in search() instead of a MATCH term. The
 *  `\S:` arm of FTS_OPERATORS already matches it, which is what keeps flagged
 *  queries on FTS in every search mode. */
export function extractQueryFlags(text: string): { text: string; starred: boolean } {
  let starred = false;
  const stripped = text
    .replace(/(?:^|\s)is:starred(?=\s|$)/gi, () => {
      starred = true;
      return " ";
    })
    .trim();
  return { text: stripped, starred };
}

/** Turn free text into an FTS5 query: each word quoted (so user input can't
 *  break the syntax), last word as prefix so search feels live while typing.
 *  Operator-bearing text passes through untouched so the full syntax works
 *  from the search bar; if it doesn't parse, search() falls back to LIKE. */
export function ftsQuery(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (FTS_OPERATORS.test(trimmed)) return trimmed;
  const tokens = trimmed.split(/\s+/).map((t) => `"${t.replaceAll('"', '""')}"`);
  tokens[tokens.length - 1] = tokens[tokens.length - 1]! + "*";
  return tokens.join(" ");
}
