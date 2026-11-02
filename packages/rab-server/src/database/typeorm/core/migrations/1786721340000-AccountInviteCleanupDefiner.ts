import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import {
  BOOTSTRAP_IDENTITY_SQL,
  BootstrapIdentityFacts,
  bootstrapIdentityProblems,
  INVITE_CLEANUP_DOWN_SQL,
  INVITE_CLEANUP_EXPECTED,
  INVITE_CLEANUP_STATE_SQL,
  INVITE_CLEANUP_UP_SQL,
  WORKER_ROLE_FACTS_SQL,
  WorkerRoleFacts,
  workerRoleProblems,
} from '../worker-dispatch-pointer-sql';

/**
 * Phase D / D8 — F-1: the account-invite cleanup is a silent no-op on the runtime login. SQL owner-approved 2026-11-01 (docs/plans/PHASE-D-SQL-GATE.md);
 * exact SQL in ../worker-dispatch-pointer-sql.ts. Executed on disposable test databases only. Account deletion stays off
 * (WORKER_INVITE_AUTO_DELETE_ENABLED, default false; production refuses true).
 *
 * Root cause: runAccountInviteCleanupCycle (rab-worker) runs on the runtime DataSource with no tenant context, but
 * `core."user"` and `core.account_invite` are rab_secure_owner-owned with organisation-scoped policies: the runtime login
 * sees zero rows (verified read-only on rab_c1d: 0 of 24 users / 0 of 38 invites visible as crewflow_app), so nothing is
 * ever expired or cleaned up. Not a security hole — every redemption path refuses an expired, revoked or consumed link on
 * the token row itself (phase-d-invite-redemption-without-cleanup.integration.spec.ts, 6/6 passing at main's schema) — but
 * a data-retention defect.
 *
 * Three narrow SECURITY DEFINER functions (rab_secure_owner, `search_path = pg_catalog, pg_temp`, EXECUTE crewflow_worker
 * only), touching only rab_secure_owner tables, so the Worker can do exactly what the cycle intends:
 *   - worker_expire_account_invites(limit ≤ 500): final (3rd) attempt past expires_at, unaccepted, unrevoked, user
 *     'invited' → 'invite_expired'; returns (user_id, organisation_id) for the Worker's audit rows. SKIP LOCKED.
 *   - worker_account_invite_cleanup_candidates(limit ≤ 50, keyset cursor): 'invite_expired' users whose final attempt's
 *     cleanup_at has passed AND who were never activated (E-6: last_login_at IS NULL, no refresh_token and no user_session
 *     row ever), with the secure-table blocking reason (owned workspace, platform administrator) or NULL.
 *   - worker_delete_expired_invited_user(user): re-checks every one of those conditions under the user's row lock and
 *     deletes; a NO ACTION / RESTRICT business reference retains the user ('referenced').
 * The business-history checks (shift, venue, job role, offer, assignment, staff profile created_by — crewflow-owned, in
 * core and in workspace schemas) stay in the Worker under tenant context exactly as today, then the delete function is
 * called; audit rows stay the Worker's, in the same transaction. Change request for Agent B: docs/plans/PHASE-D-SQL-GATE.md §1786721340000.
 *
 * SECURITY TRADE-OFF: a caller holding crewflow_worker could call the delete function without first running the business
 * checks. Bounded (E-6, now structural, not assumed): only accounts that never signed in and never held a refresh token or
 * a web session — so could never have written business history — whose invitation is exhausted and past the 7-day grace
 * period, with no owned workspace or platform-admin row, can be deleted; NO ACTION / RESTRICT references still block it.
 * The full inventory of foreign keys to core."user" (SET NULL / CASCADE / NO ACTION / RESTRICT) is in docs/plans/PHASE-D-SQL-GATE.md.
 *
 * down(): drops the three functions (the Worker falls back to the old, no-op path).
 */
export class AccountInviteCleanupDefiner1786721340000 implements MigrationInterface {
  name = 'AccountInviteCleanupDefiner1786721340000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    for (const sql of INVITE_CLEANUP_UP_SQL) await queryRunner.query(sql);
    const [row] = (await queryRunner.query(INVITE_CLEANUP_STATE_SQL)) as Array<{ functions: string | null }>;
    if (row?.functions !== INVITE_CLEANUP_EXPECTED) {
      throw new Error(`${this.name}: unexpected function state after create (rolled back): ${row?.functions ?? 'none'}`);
    }
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const problems = bootstrapIdentityProblems(f);
    if (problems.length) throw new Error(`${this.name}: refusing to run down as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
    for (const sql of INVITE_CLEANUP_DOWN_SQL) await queryRunner.query(sql);
  }

  private async preflight(queryRunner: QueryRunner): Promise<void> {
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const [w] = (await queryRunner.query(WORKER_ROLE_FACTS_SQL)) as WorkerRoleFacts[];
    const problems = [...bootstrapIdentityProblems(f), ...workerRoleProblems(w)];
    if (problems.length) throw new Error(`${this.name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }
}

/** Same as Phase 0b: this session resolves names in pg_catalog only; every object named here is core-qualified. */
async function pinSearchPath(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}
