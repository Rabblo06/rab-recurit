import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 4/5/6 follow-up — a real, confirmed gap on at least one local development database, not
 * theoretical: `crewflow_app` authenticates fine (the role/credential pair is correct) but lacks
 * column-level INSERT/UPDATE on `core.user_session.idle_expires_at` specifically — all 12 other
 * columns of `RefreshTokenService.issue()`'s own INSERT are correctly granted. Confirmed directly:
 * `has_table_privilege('crewflow_app', 'core.user_session', 'INSERT')` is false only because this
 * one column's grant is missing; the statement fails closed with `permission denied for table
 * user_session` (Postgres rejects the WHOLE INSERT when any one of its target columns lacks the
 * privilege), not merely silently omitting the column.
 *
 * Root cause, not guessed: `UserSessionIdleExpiryPrivilege1786685000000` granted this column to
 * `crewflow` only (`GRANT INSERT (idle_expires_at) ON core.user_session TO crewflow;`), timestamp-
 * ordered BEFORE `CrewflowAppRestrictedRuntimeRole1786687000000`'s own one-time grant-replication
 * logic — which in a correctly-provisioned database would copy this exact grant onto `crewflow_app`
 * automatically. Both migrations are correctly recorded as run, in the correct order, in
 * `core.migrations` on the affected database — this is state drift on a specific local environment
 * (most likely: the replication migration ran against a database snapshot taken momentarily before
 * the idle-expiry grant had been applied to `crewflow`, during this program's many local rebuild/
 * containment cycles), not a logic bug in either migration file, and not something a bootstrap
 * `yarn migration:run` from a clean database would ever reproduce.
 *
 * This migration is a narrow, idempotent catch-up: grant exactly the same two column privileges
 * `UserSessionIdleExpiryPrivilege` already granted to `crewflow`, now explicitly to `crewflow_app`
 * too — restoring, never widening, the already-reviewed intended grant. `GRANT` is safe to re-run
 * even where the grant already exists (no-op), so this migration is itself harmless on a database
 * where the replication already worked correctly.
 */
export class CrewflowAppUserSessionIdleExpiryGrant1786699000000 implements MigrationInterface {
  name = 'CrewflowAppUserSessionIdleExpiryGrant1786699000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`GRANT INSERT (idle_expires_at) ON core.user_session TO crewflow_app;`);
    await queryRunner.query(`GRANT UPDATE (idle_expires_at) ON core.user_session TO crewflow_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE INSERT (idle_expires_at), UPDATE (idle_expires_at) ON core.user_session FROM crewflow_app;`);
  }
}
