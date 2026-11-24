import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import {
  STAFF_DOCUMENT_GUARD_POSTURE_SQL,
  STAFF_DOCUMENT_GUARD_V1_RESTORE_SQL,
  STAFF_DOCUMENT_GUARD_V2_SQL,
} from '../staff-document-guard-scan-binding-sql';

/**
 * Lane D follow-up (independent v2 re-review, Low; DRAFT — owner SQL review first): core.staff_document_guard() binds the
 * crewflow scan-column branch to the same conditions as core.staff_document_record_scan() — verdict `clean`, the bound
 * organisation + workspace, uploaded by the current user in this transaction — so `SET ROLE crewflow` alone no longer lets a
 * session write a scan verdict. Exact SQL and reasoning: ../staff-document-guard-scan-binding-sql.ts. Function body only;
 * StaffDocumentSchema1786722300000 is not edited. down() restores the approved v1 body byte for byte.
 */
export class StaffDocumentGuardScanBinding1786722320000 implements MigrationInterface {
  name = 'StaffDocumentGuardScanBinding1786722320000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.apply(queryRunner, STAFF_DOCUMENT_GUARD_V2_SQL, true);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.apply(queryRunner, STAFF_DOCUMENT_GUARD_V1_RESTORE_SQL, false);
  }

  private async apply(
    queryRunner: QueryRunner,
    sql: string,
    bound: boolean,
  ): Promise<void> {
    if (!queryRunner.isTransactionActive)
      throw new Error(`${this.name}: refusing to run outside a transaction.`);
    await queryRunner.query(
      `SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`,
    );
    await queryRunner.query(sql);
    const [f] = (await queryRunner.query(
      STAFF_DOCUMENT_GUARD_POSTURE_SQL,
    )) as Array<Record<string, unknown>>;
    const want = {
      owner: 'crewflow',
      definer: false,
      config: 'search_path=pg_catalog, pg_temp',
      app_execute: false,
      public_revoked: true,
      triggers: 3,
      bound,
    };
    const problems = Object.entries(want)
      .filter(([k, v]) => f?.[k] !== v)
      .map(
        ([k, v]) =>
          `${k}: expected ${JSON.stringify(v)}, found ${JSON.stringify(f?.[k])}`,
      );
    if (problems.length)
      throw new Error(
        `${this.name}: unexpected guard posture (rolled back): ${problems.join('; ')}`,
      );
    const violations = await secureOwnerInvariantViolations((q) =>
      queryRunner.query(q),
    );
    if (violations.length)
      throw new Error(
        `${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`,
      );
  }
}
