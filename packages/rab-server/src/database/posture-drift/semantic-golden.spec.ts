import { SUPPORTED_FINGERPRINT_MAJORS } from '../typeorm/workspace-schema/v1/expected-fingerprints';
import { SEMANTIC_GOLDEN_BY_MAJOR } from './semantic-golden';
import { splitSemanticGolden } from './semantic-posture';

/**
 * DB-SETUP §6 (PostgreSQL 17): a major is accepted only when BOTH reviewed artefacts exist for it — the workspace
 * fingerprints (expected-fingerprints*.ts, the migrator refuses otherwise) and the semantic posture golden (production
 * refuses an unmapped major at boot). This keeps the two lists from drifting apart when a major is added or removed.
 */
describe('semantic posture goldens per PostgreSQL major', () => {
  it('exactly the fingerprint-supported majors have a semantic golden', () => {
    expect(Object.keys(SEMANTIC_GOLDEN_BY_MAJOR).map(Number).sort()).toEqual([...SUPPORTED_FINGERPRINT_MAJORS].sort());
  });

  it('every golden is a non-empty, sorted, duplicate-free core posture (no workspace template, no test marker)', () => {
    for (const major of SUPPORTED_FINGERPRINT_MAJORS) {
      const golden = SEMANTIC_GOLDEN_BY_MAJOR[major]!;
      const { core, workspace } = splitSemanticGolden(golden);
      expect(core.length).toBeGreaterThan(500);
      expect(workspace).toEqual([]);
      expect(new Set(golden).size).toBe(golden.length);
      expect(golden.filter((l) => l.includes('disposable_test_database'))).toEqual([]);
    }
  });

  it('majors differ only where the server differs: the MAINTAIN privilege (17+) and the baked fingerprint literal', () => {
    const pg16 = new Set(SEMANTIC_GOLDEN_BY_MAJOR[16]);
    for (const major of [17, 18]) {
      const other = new Set(SEMANTIC_GOLDEN_BY_MAJOR[major]);
      const added = [...other].filter((l) => !pg16.has(l));
      const removed = [...pg16].filter((l) => !other.has(l));
      const isProvision = (l: string) => l.startsWith('function|provision_workspace(p_workspace_id uuid)|');
      expect(added.filter((l) => !isProvision(l))).toEqual(['acl|audit_log|crewflow:MAINTAIN:false']);
      expect(added.filter(isProvision)).toHaveLength(1);
      expect(removed).toHaveLength(1);
      expect(removed.every(isProvision)).toBe(true);
    }
  });
});
