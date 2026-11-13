import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  readSecurityPostureGoldens,
  SECURITY_POSTURE_REFERENCE_MAJOR,
  selectSecurityPostureGolden,
  splitGolden,
  WORKSPACE_GOLDEN_MAJORS,
} from './security-posture';
import { SUPPORTED_FINGERPRINT_MAJORS } from '../workspace-schema/v1/expected-fingerprints';

/**
 * DB-SETUP section 6 follow-up (lead decision 2026-11-12, the STRICTER option): one reviewed security-posture golden per
 * PostgreSQL major. The PostgreSQL 16 reference file is used unchanged; 17 and 18 keep its core lines and carry their own
 * workspace (`ws|`) template, generated on disposable clusters with workspaces. This spec pins the ONLY expected
 * difference between majors: PostgreSQL 17 added the MAINTAIN privilege, so the table owner's implicit ACL on each
 * workspace table gains MAINTAIN. Anything else differing between the templates is drift in a generated file.
 */
const goldens = readSecurityPostureGoldens();
const reference = splitGolden(goldens.reference);

/** The PG16 template with MAINTAIN inserted (sorted) into the raw-ACL line of each table's OWNER, and nothing else. */
function withOwnerMaintain(ws: string[]): string[] {
  const ownerOf = new Map<string, string>();
  for (const l of ws) {
    const m = /^ws\|owner\|r\|([^|]+)\|([^|]+)$/.exec(l);
    if (m) ownerOf.set(m[1]!, m[2]!);
  }
  return ws.map((l) => {
    const m = /^ws\|acl\|([^|]+)\|([^|]+)\|([A-Z,]+)$/.exec(l);
    if (!m || ownerOf.get(m[1]!) !== m[2]) return l;
    return `ws|acl|${m[1]}|${m[2]}|${[...m[3]!.split(','), 'MAINTAIN'].sort().join(',')}`;
  });
}

describe('security-posture goldens per PostgreSQL major', () => {
  it('a golden exists for exactly the supported majors (16 = the reference file, 17 and 18 = a committed workspace template)', () => {
    expect([SECURITY_POSTURE_REFERENCE_MAJOR, ...WORKSPACE_GOLDEN_MAJORS]).toEqual([...SUPPORTED_FINGERPRINT_MAJORS]);
    expect(Object.keys(goldens.workspaceByMajor).map(Number)).toEqual([...WORKSPACE_GOLDEN_MAJORS]);
  });

  it('PostgreSQL 16 selects the reference file byte for byte', () => {
    const file = readFileSync(join(__dirname, 'security-posture.golden.txt'), 'utf8').split('\n').filter(Boolean);
    expect(selectSecurityPostureGolden(goldens, 16)).toEqual(file);
    expect(reference.workspace.length).toBeGreaterThan(300);
  });

  it.each(WORKSPACE_GOLDEN_MAJORS.map((m) => [m]))('PostgreSQL %i: reference core + its own template; the template is ws| lines only', (major) => {
    const selected = splitGolden(selectSecurityPostureGolden(goldens, major));
    expect(selected.core).toEqual(reference.core);
    expect(selected.workspace).toEqual([...goldens.workspaceByMajor[major]!]);
    expect(selected.workspace.length).toBe(reference.workspace.length);
  });

  it.each(WORKSPACE_GOLDEN_MAJORS.map((m) => [m]))(
    'PostgreSQL %i: the ws| template differs from PostgreSQL 16 ONLY by MAINTAIN on the table owner raw-ACL line',
    (major) => {
      const ws = [...goldens.workspaceByMajor[major]!];
      expect(ws).toEqual(withOwnerMaintain(reference.workspace));
      // Non-vacuous: every workspace table's owner line changed, and nothing else did.
      const changed = ws.filter((l) => !reference.workspace.includes(l));
      expect(changed.length).toBe(reference.workspace.filter((l) => l.startsWith('ws|owner|r|')).length);
      expect(changed.every((l) => /^ws\|acl\|[^|]+\|crewflow\|.*\bMAINTAIN\b/.test(l))).toBe(true);
      // MAINTAIN reaches no other grantee (crewflow_app, PUBLIC, rab_secure_owner keep the PostgreSQL 16 lines).
      expect(ws.filter((l) => l.includes('MAINTAIN') && !/^ws\|acl\|[^|]+\|crewflow\|/.test(l))).toEqual([]);
    },
  );

  it('17 and 18 have identical workspace templates', () => {
    expect([...goldens.workspaceByMajor[17]!]).toEqual([...goldens.workspaceByMajor[18]!]);
  });

  it('fails closed: a major without a reviewed golden is refused, never compared against another major', () => {
    expect(() => selectSecurityPostureGolden(goldens, 15)).toThrow(/no reviewed security-posture golden for PostgreSQL 15/);
    expect(() => selectSecurityPostureGolden(goldens, 19)).toThrow(/no reviewed security-posture golden for PostgreSQL 19/);
    expect(() => selectSecurityPostureGolden(goldens, Number.NaN)).toThrow(/no reviewed security-posture golden/);
    expect(() => selectSecurityPostureGolden({ reference: goldens.reference, workspaceByMajor: { 17: ['owner|table|x|crewflow'] } }, 17)).toThrow(/ws\| lines only/);
    expect(() => selectSecurityPostureGolden({ reference: goldens.reference, workspaceByMajor: { 17: [] } }, 17)).toThrow(/at least one/);
  });
});
