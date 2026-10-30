/**
 * Migration identity sequence (CF-41). Which database role may run pending migrations, decided before any DDL runs.
 *
 * Evidence (two clusters built from migrations only, 2026-10-15):
 *   - Phase A, the historical chain up to the role split (CrewflowSingleCredentialRoleArchitecture1786682000000), must be
 *     run by the database owner role `rab_owner` created by postgres-init/01-roles.sql. Run instead by a superuser, the
 *     split has nothing to reassign and `crewflow` / `crewflow_app` end with NO privileges on ~37 business tables: the
 *     application cannot work, and no later migration can repair it.
 *   - Phase B, the split and everything after it, needs the privileged bootstrap identity: 27 of the 40 later migrations
 *     alter or re-own objects owned by `rab_secure_owner`. Run as the ordinary `crewflow`, 21 fail with raw PostgreSQL
 *     errors and 3 "succeed" while granting nothing (a WARNING only), which then breaks every login.
 *
 * So the runner refuses up front, with an explanation, instead of failing (or silently half-succeeding) mid-chain.
 * Bootstrap identity = a superuser (local/disposable), or a non-superuser that can act as both `rab_secure_owner` and
 * `crewflow` (for example a managed-Postgres owner role granted those memberships for the migration job only).
 */
export const ROLE_SPLIT_MIGRATION = 'CrewflowSingleCredentialRoleArchitecture1786682000000';

export interface MigrationIdentityFacts {
  currentUser: string;
  isSuperuser: boolean;
  /** core.migrations exists and records ROLE_SPLIT_MIGRATION. */
  roleSplitApplied: boolean;
  /** Can act as both owner roles (pg_has_role USAGE). Always true for a superuser. */
  canActAsOwnerRoles: boolean;
  pendingMigrations: number;
  /**
   * Pending migrations that sort BEFORE the role split (phase A work still to do). Zero once phase A is complete and the
   * split itself is next — the boundary where the bootstrap identity must take over.
   */
  pendingBeforeRoleSplit: number;
}

export class MigrationIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationIdentityError';
  }
}

/** Pure decision. Throws MigrationIdentityError when the identity is wrong for the pending work. */
export function assertMigrationIdentity(facts: MigrationIdentityFacts): void {
  if (facts.pendingMigrations === 0) return;
  if (!facts.roleSplitApplied) {
    // A superuser is refused only while phase A work remains. Once every pre-split migration is applied, the next one is
    // the split itself, which REQUIRES the bootstrap identity (it re-owns objects to rab_secure_owner).
    if (facts.isSuperuser && facts.pendingBeforeRoleSplit > 0) {
      throw new MigrationIdentityError(
        `Refusing to run ${facts.pendingBeforeRoleSplit} phase-A migration(s) as superuser "${facts.currentUser}": the chain before ${ROLE_SPLIT_MIGRATION} ` +
          `must be run by the database owner role rab_owner (postgres-init/01-roles.sql). A superuser-built chain leaves crewflow and ` +
          `crewflow_app without table privileges, which no later migration repairs. Run phase A as rab_owner; the runner stops at the ` +
          `role split, then run phase B with the bootstrap identity.`,
      );
    }
    return; // Phase A as the owner role; the role-split migration itself refuses a non-bootstrap identity.
  }
  if (!facts.isSuperuser && !facts.canActAsOwnerRoles) {
    throw new MigrationIdentityError(
      `Refusing to run ${facts.pendingMigrations} pending migration(s) as "${facts.currentUser}": migrations after ${ROLE_SPLIT_MIGRATION} need ` +
        `the privileged bootstrap identity (a superuser, or a role that can act as both rab_secure_owner and crewflow). The ordinary ` +
        `crewflow credential cannot run them: they either fail or grant nothing. Point the one-off migration step's own ` +
        `PG_DATABASE_URL (packages/rab-docker/.env.migrate) at the bootstrap connection — never the API or worker environment.`,
    );
  }
}

export const MIGRATION_IDENTITY_FACTS_QUERY = `
SELECT current_user AS "currentUser",
       r.rolsuper AS "isSuperuser",
       (to_regclass('core.migrations') IS NOT NULL) AS "hasLedger",
       (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rab_secure_owner') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crewflow')
         AND (r.rolsuper OR (pg_has_role(current_user, 'rab_secure_owner', 'USAGE') AND pg_has_role(current_user, 'crewflow', 'USAGE')))) AS "canActAsOwnerRoles"
  FROM pg_roles r WHERE r.rolname = current_user`;
