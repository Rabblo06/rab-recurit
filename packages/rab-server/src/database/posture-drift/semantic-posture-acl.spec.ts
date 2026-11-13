import { ACL_WATCHED_TABLES, SEMANTIC_OBJECT_SQL, SemanticPosture, semanticDriftFromGolden, semanticDriftFromSnapshot } from './semantic-posture';

/**
 * Security review L6 (OWNER-DB-ULTIMATE Part B): the semantic posture's `acl|` section watches the full raw ACL of every
 * append-only core table: core.audit_log and core.upgrade_migration. A re-grant of UPDATE or TRUNCATE to the logbook's owner
 * (rab_secure_owner) is posture drift: the boot gate refuses it against the golden, and the monitor reports it at runtime.
 */
const posture = (core: string[]): SemanticPosture => ({ core: [...core].sort(), workspaces: new Map(), roles: [], sha256: 'x', serverMajor: 16 });

const LOGBOOK_ACL = [
  'acl|upgrade_migration|rab_secure_owner:DELETE:false',
  'acl|upgrade_migration|rab_secure_owner:INSERT:false',
  'acl|upgrade_migration|rab_secure_owner:SELECT:false',
];
const BASE = ['acl|audit_log|crewflow_app:INSERT:false', ...LOGBOOK_ACL, 'rls|upgrade_migration|enable=true|force=true'];

describe('semantic posture acl| section (security review L6)', () => {
  it('watches core.audit_log and core.upgrade_migration, and only reads them by name in core', () => {
    expect(ACL_WATCHED_TABLES).toEqual(['audit_log', 'upgrade_migration']);
    expect(SEMANTIC_OBJECT_SQL).toContain("c.relname IN ('audit_log', 'upgrade_migration')");
    expect(SEMANTIC_OBJECT_SQL).toContain("'acl|' || c.relname || '|'");
    expect(SEMANTIC_OBJECT_SQL).not.toContain("'core.audit_log'::regclass");
  });

  it('the golden matches the reviewed ACL', () => {
    expect(semanticDriftFromGolden(posture(BASE), BASE)).toEqual([]);
  });

  for (const privilege of ['UPDATE', 'TRUNCATE']) {
    it(`a ${privilege} granted to rab_secure_owner on upgrade_migration is drift (golden and runtime snapshot)`, () => {
      const loosened = posture([...BASE, `acl|upgrade_migration|rab_secure_owner:${privilege}:false`]);
      expect(semanticDriftFromGolden(loosened, BASE)).toEqual([
        { section: 'core', missing: [], unexpected: [`acl|upgrade_migration|rab_secure_owner:${privilege}:false`] },
      ]);
      expect(semanticDriftFromSnapshot(posture(BASE), loosened)).toEqual([
        { section: 'core', missing: [], unexpected: [`acl|upgrade_migration|rab_secure_owner:${privilege}:false`] },
      ]);
    });
  }
});
