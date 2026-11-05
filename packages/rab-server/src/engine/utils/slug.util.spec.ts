import { slugify, trimEdgeChar } from './slug.util';

/**
 * CodeQL js/polynomial-redos (role.service.ts:190, and the same pattern in organisation-onboarding.service.ts): the edge trim
 * is now a linear index scan. These tests pin the output BYTE-IDENTICAL to the previous expression for every input class, and
 * guard the running time.
 */
const legacy = (value: string, sep: '_' | '-', fallback: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(sep === '_' ? /^_+|_+$/g : /^-+|-+$/g, '') || fallback;

describe('slugify (linear, byte-identical to the previous regex trim)', () => {
  it.each([
    ['Shift Lead', 'shift_lead'],
    ['  Shift   Lead  ', 'shift_lead'],
    ['__leading', 'leading'],
    ['trailing__', 'trailing'],
    ['__both__', 'both'],
    ['in__ner___under_scores', 'in_ner_under_scores'],
    ['!!!', 'role'],
    ['___', 'role'],
    ['', 'role'],
    ['   ', 'role'],
    ['Café Ünïcode 管理者', 'caf_n_code'],
    ['Ünïcode', 'n_code'],
    ['管理者', 'role'],
    ['A-B.C/D', 'a_b_c_d'],
    ['Role 2', 'role_2'],
  ])('role keys: %j → %j', (input, expected) => {
    expect(slugify(input, '_', 'role')).toBe(expected);
    expect(slugify(input, '_', 'role')).toBe(legacy(input, '_', 'role'));
  });

  it('an 80-character name (the DTO maximum) and one of 80 underscores', () => {
    const name = `${'Senior Venue Shift Supervisor '.repeat(3)}`.slice(0, 80);
    expect(name).toHaveLength(80);
    expect(slugify(name, '_', 'role')).toBe(legacy(name, '_', 'role'));
    expect(slugify('_'.repeat(80), '_', 'role')).toBe('role');
    expect(slugify(`_${'a'.repeat(78)}_`, '_', 'role')).toBe('a'.repeat(78));
  });

  it('organisation slugs (separator "-", fallback "organisation") are unchanged too', () => {
    for (const input of ['Acme Ltd', '--Acme--', 'Acme -- Events', '!!!', '', 'Ünïcode Café']) {
      expect(slugify(input, '-', 'organisation')).toBe(legacy(input, '-', 'organisation'));
    }
    expect(slugify('Acme Ltd', '-', 'organisation')).toBe('acme-ltd');
    expect(slugify('***', '-', 'organisation')).toBe('organisation');
  });

  it('byte-identical over a fuzzed corpus (both separators)', () => {
    const alphabet = ['a', 'Z', '0', '9', '_', '-', ' ', '.', '!', 'é', 'Ü', '管', '\t', '__', '--', '  '];
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 5000; i += 1) {
      const len = rand(40);
      let s = '';
      for (let j = 0; j < len; j += 1) s += alphabet[rand(alphabet.length)];
      expect([s, slugify(s, '_', 'role')]).toEqual([s, legacy(s, '_', 'role')]);
      expect([s, slugify(s, '-', 'organisation')]).toEqual([s, legacy(s, '-', 'organisation')]);
    }
  });

  it('timing guard: 80 underscores, and a pathological 200 000-character edge run, stay linear', () => {
    let started = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) slugify('_'.repeat(80), '_', 'role');
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(500);
    const huge = `${'_'.repeat(100_000)}x${'_'.repeat(100_000)}`;
    started = process.hrtime.bigint();
    expect(trimEdgeChar(huge, '_')).toBe('x');
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(200);
  });

  it('trimEdgeChar trims exactly one character, from both edges only', () => {
    expect(trimEdgeChar('__a_b__', '_')).toBe('a_b');
    expect(trimEdgeChar('____', '_')).toBe('');
    expect(trimEdgeChar('abc', '_')).toBe('abc');
    expect(() => trimEdgeChar('x', '__')).toThrow(/exactly one character/);
  });
});
