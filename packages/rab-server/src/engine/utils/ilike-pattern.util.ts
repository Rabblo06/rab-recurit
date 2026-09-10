/**
 * Postgres's default `LIKE`/`ILIKE` escape character is already `\` — a
 * caller-supplied `%` or `_` would otherwise act as a wildcard rather than a
 * literal character search, which is a correctness footgun (not an
 * injection risk on its own, since every value using this is still bound as
 * a parameter, never string-concatenated into the query), so it's escaped
 * here rather than passed through. Shared by every list endpoint's `q`
 * search param — extracted from `search.service.ts`'s original
 * `toIlikePattern`, which had this exact same logic duplicated for its own
 * five search branches.
 */
export function toIlikePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
