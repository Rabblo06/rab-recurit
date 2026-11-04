import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  PLATFORM_ADMIN_GUARD_DOWN_SQL,
  PLATFORM_ADMIN_GUARD_UP_SQL,
  PLATFORM_ADMIN_GUARDED_POLICIES,
  PLATFORM_ADMIN_POLICY_SQL,
  PlatformAdminPolicyRow,
  platformAdminPolicyProblems,
  PREAUTH_FORCE_COUNTS_SQL,
  PREAUTH_FORCE_DOWN_SQL,
  PREAUTH_FORCE_PREFLIGHT_SQL,
  PREAUTH_FORCE_STATE_SQL,
  PREAUTH_FORCE_TABLES,
  PREAUTH_FORCE_UP_SQL,
  PreauthForceState,
  preauthForceEndProblems,
  preauthForceStartProblems,
} from '../preauth-force-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';

/**
 * M-T1 (Twenty Mode Option A; owner-approved as a new forward migration, M0 §5.3 / D8): FORCE ROW LEVEL SECURITY plus an
 * owner-only definer policy on the 16 pre-auth tables owned by rab_secure_owner. Exact SQL and the full reasoning in
 * ../preauth-force-sql.ts. Runs in BOTH modes: in separated mode the runtime logins are not the owner, so what they see
 * is unchanged (proved by preauth-force-owner-only.integration.spec.ts as crewflow_app); in Twenty mode the runtime login
 * crewflow_owner stops bypassing RLS on these tables on normal code paths (G-01). Injection is NOT covered (G-02/G-03).
 *
 * Identity: the session must be able to act as the table owner — superuser, or pg_has_role(current_user,
 * 'rab_secure_owner', 'USAGE') (the separated migration identity; crewflow_owner in Twenty mode). Anything else refuses
 * before any change.
 *
 * Self-checks (the whole migration rolls back on any failure):
 *  1. start state: every table present, owned by rab_secure_owner, ENABLE, not yet FORCE, no definer policy;
 *  2. end state: every table ENABLE + FORCE with its definer policy;
 *  3. functional: when the session may SET ROLE rab_secure_owner, the rows rab_secure_owner sees in each table are
 *     counted before and after — they must be equal (a definer keeps seeing every row);
 *  4. the secure-owner invariants still hold (the policy expression calls no function);
 *  5. platform_admin recursion guard (fixed in place 2026-11-04, owner decision): core.platform_admin's three TO PUBLIC
 *     policies call core.is_active_platform_admin(), a rab_secure_owner definer that reads core.platform_admin; under
 *     FORCE that recursed until "stack depth limit exceeded". They are made false for rab_secure_owner (behind CASE)
 *     BEFORE FORCE, with start and end state checked; self-check 3 then reads every platform_admin row as
 *     rab_secure_owner, which is exactly the path that recursed. Full reasoning in ../preauth-force-sql.ts.
 *
 * down(): NO FORCE, drop the 16 definer policies, and the three platform_admin policies back to their previous
 * expressions (exactly the previous state).
 */
export class PreAuthTablesForceOwnerOnly1786721400000 implements MigrationInterface {
  name = 'PreAuthTablesForceOwnerOnly1786721400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    const canSetOwner = await this.preflight(queryRunner);
    const start = (await queryRunner.query(PREAUTH_FORCE_STATE_SQL, [[...PREAUTH_FORCE_TABLES]])) as PreauthForceState[];
    const startProblems = preauthForceStartProblems(start);
    if (startProblems.length) throw new Error(`${this.name}: unexpected starting state (nothing changed):\n  ${startProblems.join('\n  ')}`);

    const policiesAtStart = (await queryRunner.query(PLATFORM_ADMIN_POLICY_SQL, [[...PLATFORM_ADMIN_GUARDED_POLICIES]])) as PlatformAdminPolicyRow[];
    const policyStartProblems = platformAdminPolicyProblems(policiesAtStart, 'start');
    if (policyStartProblems.length) throw new Error(`${this.name}: unexpected platform_admin policies (nothing changed):\n  ${policyStartProblems.join('\n  ')}`);

    const before = canSetOwner ? await countsAsSecureOwner(queryRunner) : null;
    // The recursion guard first: the recursive policy form must never coexist with FORCE.
    for (const sql of PLATFORM_ADMIN_GUARD_UP_SQL) await queryRunner.query(sql);
    for (const sql of PREAUTH_FORCE_UP_SQL) await queryRunner.query(sql);

    const end = (await queryRunner.query(PREAUTH_FORCE_STATE_SQL, [[...PREAUTH_FORCE_TABLES]])) as PreauthForceState[];
    const endProblems = preauthForceEndProblems(end);
    if (endProblems.length) throw new Error(`${this.name}: self-check failed (rolled back):\n  ${endProblems.join('\n  ')}`);
    const policiesAtEnd = (await queryRunner.query(PLATFORM_ADMIN_POLICY_SQL, [[...PLATFORM_ADMIN_GUARDED_POLICIES]])) as PlatformAdminPolicyRow[];
    const policyEndProblems = platformAdminPolicyProblems(policiesAtEnd, 'end');
    if (policyEndProblems.length) throw new Error(`${this.name}: platform_admin recursion guard missing (rolled back):\n  ${policyEndProblems.join('\n  ')}`);

    if (before) {
      const after = await countsAsSecureOwner(queryRunner);
      const lost = PREAUTH_FORCE_TABLES.filter((t) => before.get(t) !== after.get(t)).map((t) => `core.${t}: ${before.get(t)} -> ${after.get(t)}`);
      if (lost.length) throw new Error(`${this.name}: rab_secure_owner lost row visibility after FORCE (rolled back):\n  ${lost.join('\n  ')}`);
    }

    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    for (const sql of PREAUTH_FORCE_DOWN_SQL) await queryRunner.query(sql);
    for (const sql of PLATFORM_ADMIN_GUARD_DOWN_SQL) await queryRunner.query(sql);
  }

  /** Refuses unless the session can act as rab_secure_owner. Returns whether it may also SET ROLE to it (self-check 3). */
  private async preflight(queryRunner: QueryRunner): Promise<boolean> {
    const [f] = (await queryRunner.query(PREAUTH_FORCE_PREFLIGHT_SQL)) as Array<{
      who: string;
      su: boolean;
      owner_usage: boolean;
      owner_set: boolean;
      secure_bad: boolean | null;
    }>;
    const problems: string[] = [];
    if (!f) problems.push('cannot read the connecting identity');
    else {
      if (!f.su && !f.owner_usage) problems.push(`"${f.who}" cannot act as rab_secure_owner (pg_has_role USAGE is false; superuser or the migration identity required)`);
      if (f.secure_bad !== false) problems.push('rab_secure_owner must exist and be NOLOGIN, NOSUPERUSER, NOBYPASSRLS');
    }
    if (problems.length) throw new Error(`${this.name}: refusing to run: ${problems.join('; ')}.`);
    return Boolean(f!.su || f!.owner_set);
  }
}

/** Same as Phase 0b: this session resolves names in pg_catalog only; every object named here is core-qualified. */
async function pinSearchPath(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}

/** Row counts as rab_secure_owner, then the session's previous role restored (transaction-local either way). */
async function countsAsSecureOwner(queryRunner: QueryRunner): Promise<Map<string, string>> {
  const [{ role }] = (await queryRunner.query(`SELECT pg_catalog.current_setting('role') AS role`)) as Array<{ role: string }>;
  await queryRunner.query(`SELECT pg_catalog.set_config('role', 'rab_secure_owner', true)`);
  try {
    const rows = (await queryRunner.query(PREAUTH_FORCE_COUNTS_SQL)) as Array<{ tbl: string; n: string }>;
    return new Map(rows.map((r) => [r.tbl, String(r.n)]));
  } finally {
    await queryRunner.query(`SELECT pg_catalog.set_config('role', $1, true)`, [role]);
  }
}
