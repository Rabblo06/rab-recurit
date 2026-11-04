import { readFileSync } from 'fs';
import { join } from 'path';

import {
  appendToTableSource,
  buildPlaceholders,
  FINGERPRINT_PLACEHOLDER,
  FingerprintAppendRefusal,
  missingVersions,
  planAppend,
} from './fingerprint-append';
import { EXPECTED_WORKSPACE_FINGERPRINTS_PG16, EXPECTED_WORKSPACE_FINGERPRINTS_PG18 } from './expected-fingerprints';

const h = (c: string) => c.repeat(64);
const COMMITTED = { 14: h('a'), 15: h('b'), 16: h('c'), 17: h('d'), 18: h('e'), 19: h('f') };

describe('fingerprint "only missing versions" mode (PAY-1 module 20 on PostgreSQL 16 and 18)', () => {
  it('missing versions are exactly the absent ones from 14 to LATEST', () => {
    expect(missingVersions(COMMITTED, 19)).toEqual([]);
    expect(missingVersions(COMMITTED, 20)).toEqual([20]);
    expect(missingVersions({}, 16)).toEqual([14, 15, 16]);
    expect(missingVersions(EXPECTED_WORKSPACE_FINGERPRINTS_PG16, 19)).toEqual([]);
    expect(missingVersions(EXPECTED_WORKSPACE_FINGERPRINTS_PG18, 19)).toEqual([]);
  });

  it('the throwaway build keeps every committed value and fills only the gaps (reference major, else the placeholder)', () => {
    expect(buildPlaceholders(COMMITTED, 20)).toEqual({ ...COMMITTED, 20: FINGERPRINT_PLACEHOLDER });
    expect(buildPlaceholders(COMMITTED, 20, { 20: h('9') })).toEqual({ ...COMMITTED, 20: h('9') });
    expect(buildPlaceholders({ 14: h('1') }, 15, { 14: h('2'), 15: h('3') })).toEqual({ 14: h('1'), 15: h('3') });
  });

  it('appends only the missing versions when every committed value regenerates identically', () => {
    expect(planAppend(COMMITTED, { ...COMMITTED, 20: h('7') }, 20)).toEqual({ 20: h('7') });
    expect(planAppend(COMMITTED, COMMITTED, 19)).toEqual({});
  });

  it('NEVER changes a committed value: any regenerated difference refuses the whole run', () => {
    expect(() => planAppend(COMMITTED, { ...COMMITTED, 17: h('8'), 20: h('7') }, 20)).toThrow(FingerprintAppendRefusal);
    expect(() => planAppend(COMMITTED, { ...COMMITTED, 17: h('8'), 20: h('7') }, 20)).toThrow(/committed value is never changed.*module 17/);
  });

  it('refuses a missing, malformed or placeholder generated value', () => {
    expect(() => planAppend(COMMITTED, COMMITTED, 20)).toThrow(/module 20: no valid generated fingerprint/);
    expect(() => planAppend(COMMITTED, { ...COMMITTED, 20: 'not-hex' }, 20)).toThrow(/module 20/);
    expect(() => planAppend(COMMITTED, { ...COMMITTED, 20: FINGERPRINT_PLACEHOLDER }, 20)).toThrow(/module 20/);
  });

  it('appends lines to the real table sources without touching any existing line', () => {
    for (const [file, name] of [
      ['expected-fingerprints.ts', 'EXPECTED_WORKSPACE_FINGERPRINTS_PG16'],
      ['expected-fingerprints-pg18.ts', 'EXPECTED_WORKSPACE_FINGERPRINTS_PG18'],
    ] as const) {
      const before = readFileSync(join(__dirname, file), 'utf8');
      const after = appendToTableSource(before, name, { 20: h('7') }, 'PAY-1 module 20');
      const removed = before.split('\n').filter((l) => !after.split('\n').includes(l));
      expect(removed).toEqual([]);
      expect(after).toContain(`  20: '${h('7')}',\n};`);
      expect(after.split('\n').length).toBe(before.split('\n').length + 2);
    }
  });

  it('refuses to append a version already present, an older version, or a non-sha256 value', () => {
    const src = `export const T: Readonly<Record<number, string>> = {\n  14: '${h('a')}',\n  15: '${h('b')}',\n};\n`;
    expect(() => appendToTableSource(src, 'T', { 15: h('c') })).toThrow(/already has a value/);
    expect(() => appendToTableSource(`export const T: Readonly<Record<number, string>> = {\n  16: '${h('a')}',\n};\n`, 'T', { 15: h('c') })).toThrow(/append-only/);
    expect(() => appendToTableSource(src, 'T', { 16: 'zz' })).toThrow(/not a sha256/);
    expect(() => appendToTableSource(src, 'T', { 16: FINGERPRINT_PLACEHOLDER })).toThrow(/not a sha256/);
    expect(() => appendToTableSource(src, 'Missing', { 16: h('c') })).toThrow(/not declared exactly once/);
    expect(appendToTableSource(`export const T: Readonly<Record<number, string>> = {};\n`, 'T', { 14: h('a') })).toBe(
      `export const T: Readonly<Record<number, string>> = {\n  14: '${h('a')}',\n};\n`,
    );
  });
});
