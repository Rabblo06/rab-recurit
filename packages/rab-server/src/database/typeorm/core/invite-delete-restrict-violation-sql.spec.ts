import { createHash } from 'node:crypto';

import {
  INVITE_DELETE_BODY_HASH_FK_ONLY,
  INVITE_DELETE_BODY_HASH_RESTRICT,
  INVITE_DELETE_FK_ONLY_HANDLER,
  INVITE_DELETE_REFERENCED_HANDLER,
  INVITE_DELETE_REPLACEABLE_BODY_HASHES,
  INVITE_DELETE_RESTORE_SQL,
  INVITE_DELETE_RESTRICT_VIOLATION_SQL,
  inviteDeleteBodyOf,
} from './invite-delete-restrict-violation-sql';
import { INVITE_DELETE_SKIP_SOFT_DELETED_SQL } from './migrations/1786721520000-InviteCleanupSkipsSoftDeleted';
import { SEMANTIC_GOLDEN_PG16 } from '../../posture-drift/semantic-golden.pg16';
import { SEMANTIC_GOLDEN_PG17 } from '../../posture-drift/semantic-golden.pg17';
import { SEMANTIC_GOLDEN_PG18 } from '../../posture-drift/semantic-golden.pg18';

/**
 * Static review of InviteDeleteRestrictViolation1786721580000's SQL. The behaviour (a PostgreSQL 18 RESTRICT refusal is
 * answered 'referenced', nothing deleted) is proven in invite-delete-restrict-violation.integration.spec.ts (definer, real
 * payroll-evidence RESTRICT chain) and rab-worker account-invite-cleanup.integration.spec.ts (the audit reason).
 */
describe('invite cleanup definer: restrict_violation is "referenced" (1786721580000)', () => {
  const md5 = (text: string) => createHash('md5').update(text).digest('hex');
  /** semantic-posture.ts hashes `prosrc || '|' || coalesce(pg_get_function_sqlbody, '')`; plpgsql has no sqlbody. */
  const goldenBodyHash = (createSql: string) => md5(`${inviteDeleteBodyOf(createSql)}|`);

  it('the handler catches foreign_key_violation OR restrict_violation, once, and the old handler is gone', () => {
    expect(INVITE_DELETE_RESTRICT_VIOLATION_SQL.split(INVITE_DELETE_REFERENCED_HANDLER)).toHaveLength(2);
    expect(INVITE_DELETE_RESTRICT_VIOLATION_SQL).not.toContain(INVITE_DELETE_FK_ONLY_HANDLER);
    expect(INVITE_DELETE_RESTRICT_VIOLATION_SQL.match(/EXCEPTION WHEN/g)).toHaveLength(1);
  });

  it('changes exactly that one handler of the 1786721520000 definer and nothing else', () => {
    expect(INVITE_DELETE_SKIP_SOFT_DELETED_SQL.split(INVITE_DELETE_FK_ONLY_HANDLER)).toHaveLength(2);
    expect(INVITE_DELETE_RESTRICT_VIOLATION_SQL).toBe(INVITE_DELETE_SKIP_SOFT_DELETED_SQL.replace(INVITE_DELETE_FK_ONLY_HANDLER, INVITE_DELETE_REFERENCED_HANDLER));
  });

  it('replaces in place (same signature, SECURITY DEFINER, pinned search_path); down() restores the 1786721520000 body', () => {
    expect(INVITE_DELETE_RESTRICT_VIOLATION_SQL.startsWith('CREATE OR REPLACE FUNCTION core.worker_delete_expired_invited_user(p_user_id uuid)\nRETURNS text\n')).toBe(true);
    expect(INVITE_DELETE_RESTRICT_VIOLATION_SQL).toContain('LANGUAGE plpgsql VOLATILE SECURITY DEFINER\nSET search_path = pg_catalog, pg_temp\n');
    expect(INVITE_DELETE_RESTORE_SQL).toBe(INVITE_DELETE_SKIP_SOFT_DELETED_SQL);
    // No grant, revoke, owner change or second statement rides along.
    expect(INVITE_DELETE_RESTRICT_VIOLATION_SQL).not.toMatch(/\b(GRANT|REVOKE|OWNER\s+TO|ALTER\s+FUNCTION|DROP)\b/i);
    expect(INVITE_DELETE_RESTRICT_VIOLATION_SQL.trimEnd().endsWith('$fn$')).toBe(true);
  });

  it('the body hashes the migration checks are exactly those of the two SQL bodies (semantic-golden formula)', () => {
    expect(goldenBodyHash(INVITE_DELETE_SKIP_SOFT_DELETED_SQL)).toBe(INVITE_DELETE_BODY_HASH_FK_ONLY);
    expect(goldenBodyHash(INVITE_DELETE_RESTRICT_VIOLATION_SQL)).toBe(INVITE_DELETE_BODY_HASH_RESTRICT);
    expect(goldenBodyHash(INVITE_DELETE_RESTORE_SQL)).toBe(INVITE_DELETE_BODY_HASH_FK_ONLY);
  });

  it('only the two known bodies are replaceable, in either direction; nothing else', () => {
    expect([...INVITE_DELETE_REPLACEABLE_BODY_HASHES.up].sort()).toEqual([INVITE_DELETE_BODY_HASH_FK_ONLY, INVITE_DELETE_BODY_HASH_RESTRICT].sort());
    expect([...INVITE_DELETE_REPLACEABLE_BODY_HASHES.down].sort()).toEqual([INVITE_DELETE_BODY_HASH_FK_ONLY, INVITE_DELETE_BODY_HASH_RESTRICT].sort());
    const altered = INVITE_DELETE_RESTRICT_VIOLATION_SQL.replace("RETURN 'deleted';", "RETURN 'deleted'; -- altered");
    expect(altered).not.toBe(INVITE_DELETE_RESTRICT_VIOLATION_SQL);
    expect(INVITE_DELETE_REPLACEABLE_BODY_HASHES.up).not.toContain(goldenBodyHash(altered));
  });

  it('the semantic posture goldens (PG16, PG17, PG18) pin the fixed body, not the 1786721520000 one', () => {
    for (const golden of [SEMANTIC_GOLDEN_PG16, SEMANTIC_GOLDEN_PG17, SEMANTIC_GOLDEN_PG18]) {
      expect(golden.filter((l) => l.startsWith('function|worker_delete_expired_invited_user('))).toEqual([
        `function|worker_delete_expired_invited_user(p_user_id uuid)|owner=rab_secure_owner|definer=true|lang=plpgsql|vol=v|strict=false|leakproof=false|config=search_path=pg_catalog, pg_temp|body=${INVITE_DELETE_BODY_HASH_RESTRICT}`,
      ]);
    }
  });
});
