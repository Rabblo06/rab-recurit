import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2/P3 overnight mandate, Checkpoint 2 audit finding — a real, confirmed gap, not theoretical.
 *
 * `AccountLifecycleSchema1786666200000` (the migration that created `core.audit_log`) correctly
 * revoked UPDATE/DELETE from `rab_app` in the same migration that created the table, exactly as
 * CLAUDE.md's own non-negotiable rule requires ("No update/delete route may ever be added for it,
 * at the application layer or the database grant"). `CrewflowSingleCredentialRoleArchitecture1786682000000`
 * later made `crewflow` the OWNER of `audit_log` (along with the other 35 ordinary business
 * tables) — but a table's OWNER is not bound by an ACL entry revoked from a DIFFERENT role name;
 * the original REVOKE, written against `rab_app`, never carried over. Confirmed live: `crewflow`
 * currently has UPDATE, DELETE, AND TRUNCATE on `core.audit_log` via ownership (TRUNCATE is new
 * exposure beyond even what `rab_app` ever had — `rab_app`'s own default-privilege grant never
 * included it) — meaning the one credential this application's entire runtime connects as today
 * can silently rewrite or erase its own audit trail, defeating the whole point of an insert-only
 * audit log.
 *
 * `REVOKE` against a table's OWNER is not a no-op: Postgres removes the privilege from the ACL,
 * and the owner no longer has it UNLESS they explicitly re-GRANT it to themselves — a conscious,
 * auditable act, never silent default access. This is the correct, available fix; ownership itself
 * is not revoked or transferred (DDL authority, a separate finding — see the Checkpoint 2 restricted
 * `crewflow_app` role work — is not addressed by this migration alone).
 */
export class AuditLogCrewflowOwnerRevoke1786686000000 implements MigrationInterface {
  name = 'AuditLogCrewflowOwnerRevoke1786686000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON core.audit_log FROM crewflow;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`GRANT UPDATE, DELETE, TRUNCATE ON core.audit_log TO crewflow;`);
  }
}
