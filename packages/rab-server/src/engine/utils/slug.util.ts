/**
 * Linear-time slug helpers (CodeQL js/polynomial-redos on `.replace(/^_+|_+$/g, '')`). The edge trim is an index scan from
 * both ends, so its cost is O(n) whatever the input; the separator collapse `/[^a-z0-9]+/g` is a single character class
 * with one quantifier and no alternation, which matches linearly.
 *
 * Output is byte-identical to the previous expression
 *   value.toLowerCase().trim().replace(/[^a-z0-9]+/g, sep).replace(/^sep+|sep+$/g, '') || fallback
 * for every input (slug.util.spec.ts compares both over a fuzzed corpus).
 */

/** Removes every leading and trailing occurrence of the single character `char`. O(n). */
export function trimEdgeChar(value: string, char: string): string {
  if (char.length !== 1) throw new Error('trimEdgeChar trims exactly one character');
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === char) start += 1;
  while (end > start && value[end - 1] === char) end -= 1;
  return value.slice(start, end);
}

/** lowercase → trim → every run of characters other than [a-z0-9] becomes `separator` → separators trimmed from the edges. */
export function slugify(value: string, separator: '_' | '-', fallback: string): string {
  return trimEdgeChar(value.toLowerCase().trim().replace(/[^a-z0-9]+/g, separator), separator) || fallback;
}
