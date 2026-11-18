import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  INVITE_DELETE_BODY_HASH_FK_ONLY,
  INVITE_DELETE_BODY_HASH_RESTRICT,
  INVITE_DELETE_BODY_HASH_SQL,
  INVITE_DELETE_EXPECTED_STATE,
  INVITE_DELETE_PREFLIGHT_SQL,
  INVITE_DELETE_REPLACEABLE_BODY_HASHES,
  INVITE_DELETE_RESTORE_SQL,
  INVITE_DELETE_RESTRICT_VIOLATION_SQL,
  INVITE_DELETE_STATE_SQL,
} from '../invite-delete-restrict-violation-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { INVITE_CLEANUP_EXPECTED, INVITE_CLEANUP_STATE_SQL } from '../worker-dispatch-pointer-sql';

/**
 * PostgreSQL 18 invite-cleanup audit label (DRAFT, owner SQL review pending; PR #227 follow-up). Replaces
 * core.worker_delete_expired_invited_user(uuid) of InviteCleanupSkipsSoftDeleted1786721520000 in place; the only change is
 * its exception handler, which now also catches PostgreSQL 18's restrict_violation (23001):
 * `EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN RETURN 'referenced';`. Root cause, reasoning and the
 * exact SQL: ../invite-delete-restrict-violation-sql.ts; THREAT-MODEL "Invite cleanup: PostgreSQL 18 RESTRICT refusal keeps
 * the 'referenced' label".
 *
 * Identity: like 1786721520000 — the migrator must be a superuser or able to act as rab_secure_owner (the definer's owner,
 * required to replace it; CREATE on schema core, which CREATE OR REPLACE checks). No object changes owner.
 *
 * Before the replace, both directions: the identity, the definer's state below, the state of the three invite-cleanup
 * definers (INVITE_CLEANUP_STATE_SQL, unchanged since 1786721340000), and a KNOWN current body: up() replaces only the
 * 1786721520000 body or its own (idempotent re-run), down() only its own or the 1786721520000 one; any other body
 * (hand-altered, a later fix) is refused, never overwritten. Body identity = the semantic-golden body hash
 * (002c0784… = 1786721520000, 0f7179d7… = this fix).
 *
 * Self-check before commit, both directions: the exact body installed (the same body hash), INVITE_DELETE_EXPECTED_STATE
 * (owner rab_secure_owner, SECURITY DEFINER, plpgsql, VOLATILE, returns text, pinned search_path, EXECUTE for
 * crewflow_worker and the owner rab_secure_owner, neither with the grant option, no trigger calls it), INVITE_CLEANUP_EXPECTED for all three definers, and
 * secureOwnerInvariantViolations() empty; anything else raises and rolls back.
 */
export class InviteDeleteRestrictViolation1786721580000 implements MigrationInterface {
  name = 'InviteDeleteRestrictViolation1786721580000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.replace(queryRunner, 'up', INVITE_DELETE_RESTRICT_VIOLATION_SQL, INVITE_DELETE_BODY_HASH_RESTRICT);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.replace(queryRunner, 'down', INVITE_DELETE_RESTORE_SQL, INVITE_DELETE_BODY_HASH_FK_ONLY);
  }

  private async replace(queryRunner: QueryRunner, direction: 'up' | 'down', sql: string, wantHash: string): Promise<void> {
    // Same as 1786721520000: this transaction resolves names in pg_catalog only; every object named here is schema-qualified.
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
    await this.preflight(queryRunner, direction);
    const before = await this.bodyHash(queryRunner);
    if (!before || !INVITE_DELETE_REPLACEABLE_BODY_HASHES[direction].includes(before)) {
      throw new Error(
        `${this.name}: refusing to run ${direction}: core.worker_delete_expired_invited_user(uuid) has an unknown body (hash ${before ?? 'none'}; expected one of ${INVITE_DELETE_REPLACEABLE_BODY_HASHES[direction].join(', ')}).`,
      );
    }
    await queryRunner.query(sql);

    const after = await this.bodyHash(queryRunner);
    if (after !== wantHash) {
      throw new Error(`${this.name}: core.worker_delete_expired_invited_user(uuid) body after ${direction} is ${after ?? 'missing'}, expected ${wantHash} (rolled back).`);
    }
    const stateProblems = await this.stateProblems(queryRunner);
    if (stateProblems.length) throw new Error(`${this.name}: unexpected state after ${direction} (rolled back):\n  ${stateProblems.join('\n  ')}`);
    const violations = await secureOwnerInvariantViolations((q) => queryRunner.query(q));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  private async bodyHash(queryRunner: QueryRunner): Promise<string | null> {
    const [row] = (await queryRunner.query(INVITE_DELETE_BODY_HASH_SQL)) as Array<{ body_hash: string | null }>;
    return row?.body_hash ?? null;
  }

  /** Owner, definer, language, volatility, return type, search_path, EXECUTE grantees and triggers, for this definer and its two siblings. */
  private async stateProblems(queryRunner: QueryRunner): Promise<string[]> {
    const problems: string[] = [];
    const [one] = (await queryRunner.query(INVITE_DELETE_STATE_SQL)) as Array<{ state: string | null }>;
    if (one?.state !== INVITE_DELETE_EXPECTED_STATE) problems.push(`core.worker_delete_expired_invited_user(uuid): ${one?.state ?? 'absent'} (expected ${INVITE_DELETE_EXPECTED_STATE})`);
    const [all] = (await queryRunner.query(INVITE_CLEANUP_STATE_SQL)) as Array<{ functions: string | null }>;
    if (all?.functions !== INVITE_CLEANUP_EXPECTED) problems.push(`invite-cleanup definers: ${all?.functions ?? 'absent'} (expected ${INVITE_CLEANUP_EXPECTED})`);
    return problems;
  }

  private async preflight(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const [f] = (await queryRunner.query(INVITE_DELETE_PREFLIGHT_SQL)) as Array<{ who: string; su: boolean; can_act_secure: boolean; pg16_or_later: boolean }>;
    const problems: string[] = [];
    if (!f) problems.push('cannot read the connecting identity');
    else {
      if (!f.su && !f.can_act_secure) problems.push('it cannot act as rab_secure_owner, the owner of core.worker_delete_expired_invited_user(uuid) (migration identity required)');
      if (!f.pg16_or_later) problems.push('PostgreSQL 16 or later is required');
    }
    if (problems.length) throw new Error(`${this.name}: refusing to run ${direction} as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
    // Before the replace, too: the owner, ACL and shape 1786721520000 left are what this migration preserves.
    const before = await this.stateProblems(queryRunner);
    if (before.length) throw new Error(`${this.name}: refusing to run ${direction}: unexpected state before the replace:\n  ${before.join('\n  ')}`);
  }
}
