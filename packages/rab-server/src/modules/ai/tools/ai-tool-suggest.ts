import { AI_TOOL_MAX_SUGGESTIONS } from './ai-tool.constants';
import { AI_TOOL_NAME_PATTERN } from './ai-tool.types';

/** Verbs every tool name starts with; sharing one of them is not similarity. */
const GENERIC_TOKENS = new Set(['get', 'list', 'find', 'count', 'compare', 'show', 'tool', 'tools']);
const MAX_DISTANCE = 3;

/** Optimal-string-alignment Damerau–Levenshtein distance (adjacent transpositions count as one edit). Pure. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

const tokens = (name: string) => name.split('_').filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));

/** True when a meaningful `_`-token of one name is a prefix of a token of the other ("unfilled" ~ "unfilled_shifts"). */
function sharesTokenPrefix(a: string, b: string): number {
  let shared = 0;
  for (const x of tokens(a)) for (const y of tokens(b)) if (x.startsWith(y) || y.startsWith(x)) shared += 1;
  return shared;
}

/**
 * "Did you mean" for an unknown tool name (AI Phase 3, docs/ai/PHASE3_TWENTY_PLAN.md §2.5, P3 C6). PURE. The candidate
 * set is ALWAYS the caller-supplied names permitted for THIS turn — never the registry's full catalogue — so a suggestion
 * can never reveal a tool the user may not use (and through it their role). The model's string is never returned: the
 * result holds only permitted names. A string that fails AI_TOOL_NAME_PATTERN (after lower-casing) gets no suggestion.
 * Ranking: edit distance ≤ 3 first (closest first), then a shared meaningful token prefix; ties by name; at most 3.
 */
export function suggestTools(raw: unknown, permittedNames: Iterable<string>): string[] {
  if (typeof raw !== 'string') return [];
  const name = raw.toLowerCase();
  if (!AI_TOOL_NAME_PATTERN.test(name)) return [];
  const ranked: Array<{ candidate: string; group: number; score: number }> = [];
  for (const candidate of new Set(permittedNames)) {
    if (!AI_TOOL_NAME_PATTERN.test(candidate)) continue;
    const distance = editDistance(name, candidate);
    if (distance <= MAX_DISTANCE) {
      ranked.push({ candidate, group: 0, score: distance });
      continue;
    }
    const shared = sharesTokenPrefix(name, candidate);
    if (shared > 0) ranked.push({ candidate, group: 1, score: -shared });
  }
  return ranked
    .sort((a, b) => a.group - b.group || a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, AI_TOOL_MAX_SUGGESTIONS)
    .map((r) => r.candidate);
}
