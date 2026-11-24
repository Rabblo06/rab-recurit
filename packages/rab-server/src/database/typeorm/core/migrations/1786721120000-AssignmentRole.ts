import { MigrationInterface, QueryRunner } from 'typeorm';
import { assignmentRoleSql } from '../../workspace-schema/v1/assignment-role';
import { EXPECTED_WORKSPACE_FINGERPRINTS } from '../../workspace-schema/v1/expected-fingerprints';
import { composeServerPathTemplateV1AssignmentRole, VERIFY_ASSIGNMENT_ROLE_SQL } from '../../workspace-schema/v1/server-path-template-assignment-role';
import { provisionWorkspaceFunctionV2Sql } from '../../workspace-schema/v1/provision-workspace-function-v2';
import { WorkspaceSchemaMigrator } from '../../workspace-schema/workspace-schema-migrator';
import { moduleChecksum, modulesThrough } from '../../workspace-schema/workspace-schema-modules';

/** Prepared for review, not production-approved. Existing RLS/ACLs and historical rates are unchanged. */
export class AssignmentRole1786721120000 implements MigrationInterface {
  name = 'AssignmentRole1786721120000';
  transaction = false;

  async up(q: QueryRunner): Promise<void> {
    const outer = q.isTransactionActive;
    if (!outer) await q.query('BEGIN');
    try {
      const [{ present }] = await q.query("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='core.shift_assignment'::regclass AND attname='job_role_id' AND NOT attisdropped) AS present");
      if (!present) await q.query(assignmentRoleSql('core'));
      await q.query(VERIFY_ASSIGNMENT_ROLE_SQL);
      const modules = modulesThrough(18).map(m => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
      await q.query(provisionWorkspaceFunctionV2Sql(composeServerPathTemplateV1AssignmentRole(), 'CREATE OR REPLACE', modules, EXPECTED_WORKSPACE_FINGERPRINTS[18], `db:provision_workspace@${this.name}`));
      if (!outer) await q.query('COMMIT');
    } catch (error) {
      if (!outer) await q.query('ROLLBACK');
      throw error;
    }
    const outcomes = await new WorkspaceSchemaMigrator(q).migrateAll({ throughVersion: 18, txMode: outer ? 'savepoint' : 'own', appVersion: `migration:${this.name}` });
    if (outcomes.some(o => o.status === 'FAILED' || o.status === 'REFUSED')) throw new Error('Assignment role migration incomplete; inspect workspace migration ledger before retrying.');
  }

  async down(): Promise<void> {
    throw new Error('Assignment roles carry scheduling/payroll history. Use a reviewed forward migration; automatic column deletion is not supported.');
  }
}
