/**
 * Wave 5 — the ONLY place a client's free-text search string is turned into search parameters. Pure (unit-tested in
 * search-query.spec.ts). Everything it returns is bound as a SQL PARAMETER; nothing here is ever concatenated into SQL,
 * and the text-search configuration is a literal (`'pg_catalog.simple'`) in the SQL itself, never derived from input.
 *
 *  - `tsquery`: prefix terms for `to_tsquery('pg_catalog.simple', core.immutable_unaccent(lower($n)))`. Terms are
 *    reduced to Unicode letters/digits only, so tsquery operators (`& | ! ( ) : * < >` and quotes) can never come from
 *    the client — no tsquery syntax injection, no "syntax error in tsquery" 500s. At most MAX_TERMS terms of
 *    MAX_TERM_LENGTH characters each.
 *  - `likePattern`: `%…%` for the trigram (pg_trgm GIN) infix fallback, with `\`, `%` and `_` escaped so they match
 *    literally. Normalised in SQL with the same `core.immutable_unaccent(lower(...))` as the indexed expressions.
 *  - `useInfix`: the trigram fallback only runs for >= 3 characters (shorter patterns cannot use a trigram index and
 *    would scan); short identifiers are still found by prefix FTS.
 *  - `emailPrefix`: only when the query looks like an email fragment (contains `@`); the caller adds it ONLY when the
 *    email field is visible to that caller (field permission). Never infix — exact/prefix via the email index.
 */
export const MAX_TERMS = 6;
export const MAX_TERM_LENGTH = 64;
export const MAX_QUERY_LENGTH = 200;
export const MIN_INFIX_LENGTH = 3;

export interface SearchQuery {
  /** Normalised raw text (trimmed, collapsed whitespace, ≤ MAX_QUERY_LENGTH). Used for exact-match ranking. */
  text: string;
  /** e.g. `jose:* & mar:*`, or null when the query has no letters/digits at all (⇒ no results). */
  tsquery: string | null;
  likePattern: string;
  useInfix: boolean;
  emailPrefix: string | null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function buildSearchQuery(raw: string): SearchQuery {
  // Control characters (NUL in particular, which PostgreSQL text cannot hold) become spaces: never a 500.
  // eslint-disable-next-line no-control-regex
  const text = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
  const terms = (text.match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((t) => t.slice(0, MAX_TERM_LENGTH))
    .slice(0, MAX_TERMS);
  const tsquery = terms.length ? terms.map((t) => `${t}:*`).join(' & ') : null;
  const emailPrefix = text.includes('@') && !/\s/.test(text) ? `${escapeLike(text)}%` : null;
  return {
    text,
    tsquery,
    likePattern: `%${escapeLike(text)}%`,
    useInfix: [...text].length >= MIN_INFIX_LENGTH,
    emailPrefix,
  };
}
