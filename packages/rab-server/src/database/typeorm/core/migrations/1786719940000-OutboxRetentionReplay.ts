import { MigrationInterface, QueryRunner } from 'typeorm';

import { OUTBOX_RETENTION_DOWN_SQL, OUTBOX_RETENTION_UP_SQL } from '../outbox-retention-sql';

/**
 * Waves 4+5 lane DB5 — G6 outbox retention purge + audited FAILED-email replay, for the OPS lane. Dev/test only:
 * deliberately NOT in production-migration-approval.ts (N1). Contract: docs/evidence/w45-db5/CONTRACT.md §5.
 * SQL and design: ../outbox-retention-sql.ts.
 *
 *  - `core.purge_terminal_{email_outbox,push_delivery,realtime_event,worker_event}(p_retention interval, p_batch integer)`:
 *    SECURITY DEFINER (owner crewflow; FORCE RLS still binds it to the bound tenant), terminal rows only, retention
 *    validated against a per-table floor; partial expression index per table for the purge scan.
 *  - `REVOKE DELETE` on those four tables from crewflow_app (no runtime code deletes from them; FK cascades are unaffected).
 *  - `core.replay_failed_email(uuid, boolean)`: SECURITY INVOKER, FAILED → RETRY with a generation bump + audit row.
 *
 * Retention VALUES are an owner decision (G6); nothing here deletes anything by itself. Runs as the bootstrap identity
 * (or crewflow). No existing row is changed.
 */
export class OutboxRetentionReplay1786719940000 implements MigrationInterface {
  name = 'OutboxRetentionReplay1786719940000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertAuthority(queryRunner);
    await queryRunner.query(OUTBOX_RETENTION_UP_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertAuthority(queryRunner);
    await queryRunner.query(OUTBOX_RETENTION_DOWN_SQL);
  }

  private async assertAuthority(queryRunner: QueryRunner): Promise<void> {
    const [{ ok }] = await queryRunner.query(`SELECT pg_has_role(current_user, 'crewflow', 'USAGE') AS ok`);
    if (!ok) throw new Error(`${this.name} must run as crewflow or the bootstrap identity (the outbox table owner)`);
  }
}
