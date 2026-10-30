import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  DEPLOYMENT_IDENTITY_DOWN_SQL,
  DEPLOYMENT_IDENTITY_EXPECTED_STATE,
  DEPLOYMENT_IDENTITY_GONE_SQL,
  DEPLOYMENT_IDENTITY_PREFLIGHT_SQL,
  DEPLOYMENT_IDENTITY_STATE_SQL,
  DEPLOYMENT_IDENTITY_UP_SQL,
} from '../deployment-identity-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';

/**
 * Phase B / B3 (P3): provider-neutral deployment identity marker (replaces the Neon endpoint pin in database-target.ts).
 * Owner-approved for ISOLATED TESTING ONLY (disposable databases); NOT approved for production: it is later than
 * PRODUCTION_APPROVED_THROUGH and not in PRODUCTION_APPROVED_MIGRATIONS (production-migration-approval.ts), so a production
 * `rab-migrate` run refuses the whole run while it is pending. Renumbered from the never-applied draft 1786721200000 so it
 * sorts after ProvisioningHealth1786721220000 (no ledger row or table existed in any database under the old number).
 * The exact SQL lives in ../deployment-identity-sql.ts.
 *
 *   - `core.deployment_identity`, a singleton (boolean PK = true): environment (production | staging | development | test |
 *     ci), deployment_id (uuid), bound_database (current_database() at bind time, recorded by the definer), bound_hosts
 *     (1 to 5 confirmed connection host names), bound_system_identifier (informational, may be NULL), bound_at, bound_by,
 *     reason;
 *   - `core.deployment_identity_history`, one row per bind (previous and new value incl. database and hosts, session
 *     login, actor, reason). UPDATE, DELETE and TRUNCATE are revoked even from the owner;
 *   - `core.deployment_identity_check()`: SECURITY DEFINER read, EXECUTE crewflow_app (API/Worker boot) and crewflow
 *     (operator CLI, provisioner guard);
 *   - `core.deployment_identity_bind(env, id, reason, actor, expected_current_id, hosts[])`: SECURITY DEFINER write of the
 *     singleton plus a history row in one statement. EXECUTE only by the owner, so only the migration identity (a member of
 *     rab_secure_owner) or a superuser can call it; it re-checks that the SESSION login is such a member and is neither
 *     crewflow nor crewflow_app. A rebind must confirm the currently bound id (compare-and-swap) and choose a new id.
 *
 * Why a table and not a database-level setting: crewflow owns the database (H2) and could `ALTER DATABASE ... SET` a
 * GUC marker. After Phase 0b only rab_secure_owner (NOLOGIN) and its members can write a rab_secure_owner table in core.
 *
 * NOT tamper-proof against the migration identity: as a member of rab_secure_owner it can `SET ROLE rab_secure_owner` and
 * write the singleton directly (no history row), or ALTER / DROP the tables. The history protects against the runtime
 * logins and operator mistakes only (see deployment-identity-sql.ts BOUNDARY).
 *
 * RLS: neither table has `organisation_id` — deployment identity is not tenant data (like `permission` /
 * `platform_admin`). It still gets ENABLE + FORCE ROW LEVEL SECURITY in this migration, owner-only permissive policies that
 * additionally require CURRENT_USER = rab_secure_owner (true only inside the two definers; a member's direct query sees and
 * writes nothing), and a RESTRICTIVE deny-all for crewflow / crewflow_app. FORCE is safe here — no pre-auth lookup
 * needs owner bypass: the definers run AS the owner and the owner policies admit exactly them. tools/check-rls-coverage.ts
 * asserts ENABLE + FORCE on both tables explicitly (its per-table scan only sees tables with organisation_id).
 *
 * Authority: the CF-41 / Phase 0b bootstrap identity — the restricted migrator (member of rab_secure_owner + crewflow, no
 * CREATEROLE, no superuser) or a superuser. No CREATE ROLE, no membership, no grant to a runtime login beyond EXECUTE on the
 * read function, no FORCE removal. Self-check before commit: the exact owner / RLS / ACL / policy / function state, and
 * secureOwnerInvariantViolations() must be empty; anything else raises and rolls back.
 *
 * down(): drops both functions and both tables (the bind history goes with them). Every production process then refuses
 * to start (marker absent = fail closed) until the migration is re-applied and the database re-bound.
 */
export class DeploymentIdentity1786721230000 implements MigrationInterface {
  name = 'DeploymentIdentity1786721230000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'up');
    for (const sql of DEPLOYMENT_IDENTITY_UP_SQL) await queryRunner.query(sql);

    const [state] = (await queryRunner.query(DEPLOYMENT_IDENTITY_STATE_SQL)) as Array<Record<string, unknown>>;
    const problems = Object.entries(DEPLOYMENT_IDENTITY_EXPECTED_STATE)
      .filter(([key, expected]) => state?.[key] !== expected)
      .map(([key, expected]) => `${key}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(state?.[key])}`);
    if (problems.length) throw new Error(`${this.name}: unexpected state after create (rolled back):\n  ${problems.join('\n  ')}`);

    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.pinSearchPath(queryRunner);
    await this.preflight(queryRunner, 'down');
    for (const sql of DEPLOYMENT_IDENTITY_DOWN_SQL) await queryRunner.query(sql);
    const [row] = (await queryRunner.query(DEPLOYMENT_IDENTITY_GONE_SQL)) as Array<{ gone: boolean }>;
    if (row?.gone !== true) throw new Error(`${this.name}: marker objects remain after down() (rolled back).`);
  }

  /** Same as Phase 0b: this session resolves names in pg_catalog only; every object named here is core-qualified. */
  private async pinSearchPath(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
  }

  private async preflight(queryRunner: QueryRunner, direction: 'up' | 'down'): Promise<void> {
    const [f] = (await queryRunner.query(DEPLOYMENT_IDENTITY_PREFLIGHT_SQL)) as Array<{
      who: string;
      su: boolean;
      can_act: boolean;
      secure_bad: boolean | null;
      core_owner: string;
      exists_already: boolean;
    }>;
    const problems: string[] = [];
    if (!f) problems.push('cannot read the connecting identity');
    else {
      if (!f.su && !f.can_act) problems.push('it cannot act as rab_secure_owner (CF-41 bootstrap identity required)');
      if (f.secure_bad !== false) problems.push('rab_secure_owner must exist and be NOLOGIN, NOSUPERUSER, NOBYPASSRLS');
      if (f.core_owner !== 'rab_secure_owner') problems.push(`schema core is owned by ${f.core_owner}, not rab_secure_owner (Phase 0b first)`);
      if (direction === 'up' && f.exists_already) problems.push('a deployment identity object already exists');
    }
    if (problems.length) throw new Error(`${this.name}: refusing to run ${direction} as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }
}
