import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crewflow Platform Admin Panel (Phase A plan §4 migration 2): an index for the Audit tab's action-filtered, keyset-paged
 * timeline (`core.admin_list_audit_events`, AdminPanelReadFunctions1786720100000).
 *
 * Deviation from the plan, on purpose: the plan proposed `(action, created_at DESC, id DESC)` for a global page. The
 * function cannot read `audit_log` globally (FORCE RLS, `organisation_id = current_org()`), so it reads ONE organisation at
 * a time with `organisation_id = $org AND action = ANY($allowlist) ORDER BY created_at DESC, id DESC LIMIT n`. The index
 * that serves that predicate is `(organisation_id, action, created_at DESC, id DESC)`; without it the read walks
 * `audit_log_org_time_idx` over every audited event of the organisation to find the rare admin ones.
 *
 * `transaction = false` → CREATE INDEX CONCURRENTLY, so audit writers (every audited action in the product) are never
 * blocked. Same failure handling as AuditLogTimelineIndex1786719950000: an INVALID leftover from a failed build is dropped
 * and rebuilt; when TypeORM forces a transaction (migration:revert) the plain locking form is used.
 * Dev/test only: NOT in production-migration-approval.ts (N1).
 */
const INDEX = 'audit_log_org_action_created_idx';

export class AuditLogOrganisationActionIndex1786720110000 implements MigrationInterface {
  name = 'AuditLogOrganisationActionIndex1786720110000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertAuthority(queryRunner);
    const cc = queryRunner.isTransactionActive ? '' : 'CONCURRENTLY ';
    await queryRunner.query(`SET lock_timeout = '60s'`);
    try {
      if ((await this.state(queryRunner)) === 'INVALID') await queryRunner.query(`DROP INDEX ${cc}IF EXISTS core.${INDEX}`);
      if ((await this.state(queryRunner)) === 'ABSENT') {
        await queryRunner.query(`CREATE INDEX ${cc}${INDEX} ON core.audit_log (organisation_id, action, created_at DESC, id DESC)`);
      }
      if ((await this.state(queryRunner)) !== 'VALID') throw new Error(`${this.name}: ${INDEX} is not valid after the build`);
    } finally {
      await queryRunner.query('RESET lock_timeout');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertAuthority(queryRunner);
    const cc = queryRunner.isTransactionActive ? '' : 'CONCURRENTLY ';
    await queryRunner.query(`DROP INDEX ${cc}IF EXISTS core.${INDEX}`);
  }

  private async state(queryRunner: QueryRunner): Promise<'ABSENT' | 'VALID' | 'INVALID'> {
    const rows: Array<{ valid: boolean; ready: boolean }> = await queryRunner.query(
      `SELECT i.indisvalid AS valid, i.indisready AS ready FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'core' AND c.relname = $1`,
      [INDEX],
    );
    if (rows.length === 0) return 'ABSENT';
    return rows[0]!.valid && rows[0]!.ready ? 'VALID' : 'INVALID';
  }

  private async assertAuthority(queryRunner: QueryRunner): Promise<void> {
    const [{ ok }] = await queryRunner.query(`SELECT pg_has_role(current_user, 'crewflow', 'USAGE') AS ok`);
    if (!ok) throw new Error(`${this.name} must run as crewflow or the bootstrap identity (core.audit_log owner)`);
  }
}
