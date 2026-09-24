import { normaliseKeyPrefix } from './storage-key-prefix';

describe('normaliseKeyPrefix', () => {
  it.each([
    ['production', 'production/'],
    ['production/', 'production/'],
    [' /production/', 'production/'],
    [' /production', 'production/'],
    ['  production  ', 'production/'],
    ['staging', 'staging/'],
    ['dev', 'dev/'],
  ])('normalises %j to %j', (input, expected) => {
    expect(normaliseKeyPrefix(input)).toBe(expected);
  });

  it('never produces a double slash for a nested prefix', () => {
    expect(normaliseKeyPrefix('/production//org-a/')).toBe('production/org-a/');
  });

  it('rejects a traversal segment', () => {
    expect(() => normaliseKeyPrefix('../etc')).toThrow(/traversal/i);
    expect(() => normaliseKeyPrefix('production/../secret')).toThrow(/traversal/i);
    expect(() => normaliseKeyPrefix('.')).toThrow(/traversal/i);
  });

  it('rejects an empty or separator-only prefix', () => {
    expect(() => normaliseKeyPrefix('')).toThrow(/empty/i);
    expect(() => normaliseKeyPrefix('   ')).toThrow(/empty/i);
    expect(() => normaliseKeyPrefix('///')).toThrow(/empty/i);
  });
});
