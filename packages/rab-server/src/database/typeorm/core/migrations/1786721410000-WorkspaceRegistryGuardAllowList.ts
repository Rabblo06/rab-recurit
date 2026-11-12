import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  REGISTRY_GUARD_ALLOWLIST_SQL,
  REGISTRY_GUARD_DENYLIST_SQL,
  REGISTRY_GUARD_STATE_SQL,
  RegistryGuardState,
  registryGuardProblems,
} from '../registry-guard-allowlist-sql';
import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { BOOTSTRAP_IDENTITY_SQL, BootstrapIdentityFacts, bootstrapIdentityProblems } from '../worker-dispatch-pointer-sql';

/**
 * M-T2 (Twenty Mode Option A; owner-approved as a new forward migration, M0 §5.3 / D9): the workspace-registry
 * versioning guard becomes an ALLOW-list (crewflow, rab_secure_owner, superuser) instead of a deny-list of crewflow_app.
 * Exact SQL and reasoning in ../registry-guard-allowlist-sql.ts; the matching code change is
 * workspace-schema-migrator.ts (SET LOCAL ROLE crewflow before its registry writes).
 *
 * Runs in both modes. Separated mode: crewflow_app was already refused and still is; crewflow and the registry definers
 * still pass; the separated migration identity acting as itself (a member of crewflow, not crewflow) is now refused on the
 * six versioning columns unless it SETs ROLE crewflow, which the migrator does. Twenty mode: crewflow_owner is refused on
 * normal paths (G-10).
 *
 * Identity: the CF-41 bootstrap identity (can act as rab_secure_owner and crewflow) or a superuser — it replaces a
 * crewflow-owned function in core. Self-checks: the end state is the allow-list body, owner crewflow, INVOKER, pinned
 * search_path, trigger enabled, no PUBLIC EXECUTE; secure-owner invariants hold. down() restores the deny-list body.
 */
export class WorkspaceRegistryGuardAllowList1786721410000 implements MigrationInterface {
  name = 'WorkspaceRegistryGuardAllowList1786721410000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    const [before] = (await queryRunner.query(REGISTRY_GUARD_STATE_SQL)) as RegistryGuardState[];
    const start = registryGuardProblems(before, 'deny');
    if (start.length) throw new Error(`${this.name}: unexpected starting state (nothing changed): ${start.join('; ')}`);
    await queryRunner.query(REGISTRY_GUARD_ALLOWLIST_SQL);
    const [after] = (await queryRunner.query(REGISTRY_GUARD_STATE_SQL)) as RegistryGuardState[];
    const end = registryGuardProblems(after, 'allow');
    if (end.length) throw new Error(`${this.name}: self-check failed (rolled back): ${end.join('; ')}`);
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    await queryRunner.query(REGISTRY_GUARD_DENYLIST_SQL);
    const [after] = (await queryRunner.query(REGISTRY_GUARD_STATE_SQL)) as RegistryGuardState[];
    const end = registryGuardProblems(after, 'deny');
    if (end.length) throw new Error(`${this.name}: down self-check failed (rolled back): ${end.join('; ')}`);
  }

  private async preflight(queryRunner: QueryRunner): Promise<void> {
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const problems = bootstrapIdentityProblems(f);
    if (problems.length) throw new Error(`${this.name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }
}

/** Same as Phase 0b: this session resolves names in pg_catalog only; every object named here is core-qualified. */
async function pinSearchPath(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}
