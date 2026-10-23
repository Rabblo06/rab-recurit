import { buildSearchQuery, MAX_TERM_LENGTH, MAX_TERMS } from '../services/search-query';
import { SEARCH_SQL_FRAGMENTS } from '../services/search.service';

/** Wave 5 — the only place client search text becomes search parameters. Injection attempts must produce inert params. */
describe('buildSearchQuery', () => {
  it('builds prefix tsquery terms joined with AND', () => {
    expect(buildSearchQuery('  Zoë   Smi ').tsquery).toBe('Zoë:* & Smi:*');
  });

  it('strips every tsquery operator and quote — no tsquery syntax can come from the client', () => {
    for (const raw of [`x' OR 1=1 --`, 'a:* | b', '!(foo) & <-> bar', '"quoted" (paren)', 'a&&&b', "o'brien"]) {
      const q = buildSearchQuery(raw);
      expect(q.tsquery).toMatch(/^[\p{L}\p{N}]+:\*( & [\p{L}\p{N}]+:\*)*$/u);
    }
    expect(buildSearchQuery(`x' OR 1=1 --`).tsquery).toBe('x:* & OR:* & 1:* & 1:*');
  });

  it('a query without letters or digits yields no tsquery (⇒ no results, never a scan)', () => {
    for (const raw of ['%%', '___', '--', '::*', '   ', '!!']) expect(buildSearchQuery(raw).tsquery).toBeNull();
  });

  it('control characters (NUL included — PostgreSQL text cannot hold it) become spaces, never a 500', () => {
    const q = buildSearchQuery('zo\u0000e\u0007x');
    expect(q.text).toBe('zo e x');
    expect(q.likePattern).not.toContain('\u0000');
    expect(q.tsquery).toBe('zo:* & e:* & x:*');
  });

  it('escapes LIKE wildcards so % and _ match literally', () => {
    expect(buildSearchQuery('50%_off\\').likePattern).toBe('%50\\%\\_off\\\\%');
  });

  it('infix (trigram) fallback only from 3 characters', () => {
    expect(buildSearchQuery('ab').useInfix).toBe(false);
    expect(buildSearchQuery('abc').useInfix).toBe(true);
    expect(buildSearchQuery('zoë').useInfix).toBe(true);
  });

  it('email prefix only for an email-like query without spaces', () => {
    expect(buildSearchQuery('ava@exa').emailPrefix).toBe('ava@exa%');
    expect(buildSearchQuery('ava smith').emailPrefix).toBeNull();
    expect(buildSearchQuery('a@b c').emailPrefix).toBeNull();
    expect(buildSearchQuery('a_b@x').emailPrefix).toBe('a\\_b@x%');
  });

  it('bounds the work: at most MAX_TERMS terms of MAX_TERM_LENGTH characters', () => {
    const q = buildSearchQuery(Array.from({ length: 20 }, (_, i) => `term${i}`).join(' '));
    expect(q.tsquery!.split(' & ')).toHaveLength(MAX_TERMS);
    expect(buildSearchQuery('x'.repeat(500)).tsquery).toBe(`${'x'.repeat(MAX_TERM_LENGTH)}:*`);
  });

  it('the SQL fragments are server constants: a literal text-search config and positional parameters only', () => {
    expect(SEARCH_SQL_FRAGMENTS.TSQ).toBe(`to_tsquery('pg_catalog.simple', core.immutable_unaccent(lower($1)))`);
    for (const fragment of Object.values(SEARCH_SQL_FRAGMENTS)) expect(fragment).toMatch(/\$[1-4]/);
  });
});
