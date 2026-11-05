/**
 * Owner decision D4, follow-up (PAY-1 needs module 20 on PostgreSQL 16 AND 18): the pure rules of the "only missing
 * versions" mode of scripts/generate-workspace-fingerprints.ts (FINGERPRINT_MODE=append).
 *
 *   - Only module versions ABSENT from a major's committed table are generated and appended (14..LATEST).
 *   - A committed value is NEVER changed: the run regenerates every version on the same database, and any committed
 *     version whose regenerated value differs refuses the whole run (FingerprintAppendRefusal) — the tables are
 *     append-only, like migrations; a differing value means the module SQL, the catalog rendering or the build changed,
 *     which is a review question, not something a tool may overwrite.
 *   - The throwaway build that generates them needs a value for every version the frozen migrations read; a missing one
 *     is filled with FINGERPRINT_PLACEHOLDER for that build only (no workspace exists while the chain runs, so it is
 *     only baked into that throwaway database's provision_workspace literal and never compared).
 *   - Appending to the source file inserts new `  <version>: '<sha256>',` lines before the table's closing brace and
 *     refuses a version that is already there.
 */
export const FIRST_FINGERPRINTED_VERSION = 14;
/** Never a real fingerprint (all zeros); used only inside a throwaway generation build. */
export const FINGERPRINT_PLACEHOLDER = '0'.repeat(64);
const SHA256 = /^[0-9a-f]{64}$/;

export class FingerprintAppendRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FingerprintAppendRefusal';
  }
}

/** Versions FIRST_FINGERPRINTED_VERSION..latest without a committed value, ascending. */
export function missingVersions(table: Readonly<Record<number, string>>, latest: number): number[] {
  const out: number[] = [];
  for (let v = FIRST_FINGERPRINTED_VERSION; v <= latest; v++) if (!table[v]) out.push(v);
  return out;
}

/**
 * The values to load for the throwaway build: every committed value as is; a missing version takes `reference[v]`
 * (another major's value) when there is one, else FINGERPRINT_PLACEHOLDER.
 */
export function buildPlaceholders(
  table: Readonly<Record<number, string>>,
  latest: number,
  reference: Readonly<Record<number, string>> = {},
): Record<number, string> {
  const out: Record<number, string> = {};
  for (let v = FIRST_FINGERPRINTED_VERSION; v <= latest; v++) out[v] = table[v] ?? reference[v] ?? FINGERPRINT_PLACEHOLDER;
  return out;
}

/**
 * Pure decision over a full regeneration: what to append. Refuses when a committed value differs from its regenerated
 * value (never changed), when a missing version was not generated, or when any value is not a sha256 hex (the
 * placeholder included).
 */
export function planAppend(
  committed: Readonly<Record<number, string>>,
  generated: Readonly<Record<number, string>>,
  latest: number,
): Record<number, string> {
  const changed: string[] = [];
  const append: Record<number, string> = {};
  for (let v = FIRST_FINGERPRINTED_VERSION; v <= latest; v++) {
    const g = generated[v];
    if (!g || !SHA256.test(g) || g === FINGERPRINT_PLACEHOLDER) throw new FingerprintAppendRefusal(`module ${v}: no valid generated fingerprint. Nothing appended.`);
    const c = committed[v];
    if (c === undefined) append[v] = g;
    else if (c !== g) changed.push(`module ${v}: committed ${c.slice(0, 12)}…, regenerated ${g.slice(0, 12)}…`);
  }
  if (changed.length) {
    throw new FingerprintAppendRefusal(
      `refusing to append: committed fingerprints differ from this regeneration, and a committed value is never changed (${changed.join('; ')}). Nothing appended.`,
    );
  }
  return append;
}

/**
 * Inserts `entries` into the object literal `export const <exportName>…= { … };` of a fingerprint table source file,
 * before its closing brace, in ascending order after the existing entries. Refuses a version that already has a line,
 * an entry not newer than the highest existing version, or a source without exactly one such table.
 */
export function appendToTableSource(source: string, exportName: string, entries: Readonly<Record<number, string>>, comment?: string): string {
  const start = source.indexOf(`export const ${exportName}:`);
  if (start < 0 || source.indexOf(`export const ${exportName}:`, start + 1) >= 0) throw new FingerprintAppendRefusal(`${exportName} is not declared exactly once.`);
  const open = source.indexOf('{', source.indexOf('=', start));
  const close = source.indexOf('}', open); // entries hold no braces: the first one closes the literal
  if (open < 0 || close < 0 || !source.startsWith('};', close)) throw new FingerprintAppendRefusal(`${exportName}: object literal not found (or a brace inside it).`);
  const body = source.slice(open + 1, close);
  const existing = [...body.matchAll(/^\s*(\d+):\s*'([0-9a-f]{64})',?\s*$/gm)].map((m) => Number(m[1]));
  const highest = existing.length ? Math.max(...existing) : 0;
  const versions = Object.keys(entries).map(Number).sort((a, b) => a - b);
  if (!versions.length) return source;
  for (const v of versions) {
    if (existing.includes(v)) throw new FingerprintAppendRefusal(`${exportName}: module ${v} already has a value; a committed value is never changed.`);
    if (v <= highest) throw new FingerprintAppendRefusal(`${exportName}: module ${v} is not newer than the committed ${highest}; append-only.`);
    if (!SHA256.test(entries[v]!) || entries[v] === FINGERPRINT_PLACEHOLDER) throw new FingerprintAppendRefusal(`${exportName}: module ${v} is not a sha256 value.`);
  }
  const lines = [...(comment ? [`  // ${comment}`] : []), ...versions.map((v) => `  ${v}: '${entries[v]}',`)].join('\n');
  const head = source.slice(0, close).replace(/\s*$/, '');
  const needsComma = head.length > 0 && !head.endsWith('{') && !head.endsWith(',');
  return `${head}${needsComma ? ',' : ''}\n${lines}\n${source.slice(close)}`;
}
