import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M10 lane C (D-item "registry write revoke"): removes table-level write privileges that `crewflow_app` received ONLY by
 * accident of the role split, on four core-only tables where no runtime code path writes directly.
 *
 * ROOT CAUSE. `CrewflowAppRestrictedRuntimeRole1786687000000` replicated `crewflow`'s table privileges onto
 * `crewflow_app` from `information_schema.table_privileges`. `crewflow` is the OWNER of these tables, so its ACL carries
 * every privilege (arwdDxt). The copy therefore re-granted, for every crewflow-owned core table, the SELECT/INSERT/UPDATE/
 * DELETE that earlier migrations had deliberately REVOKEd from the old runtime role `rab_app`. Four of those deliberate
 * revokes are on core-only tables (no workspace-schema counterpart, so no workspace template/fingerprint change):
 *
 *   table                         pre-split intent (rab_app)                 restored here
 *   workspace_schema_registry     SELECT only (1786674900000:60-61)            revoke INSERT, UPDATE, DELETE
 *   workspace_membership          SELECT, INSERT, UPDATE (1786674700000:68-69) revoke DELETE
 *   hws_backfill_checkpoint       SELECT, INSERT, UPDATE (1786677700000:61-62) revoke DELETE
 *   stored_file                   no DELETE (1786672600000:85)                 revoke DELETE
 *
 * EVIDENCE that crewflow_app never needs them (full inventory: docs/ultimate/LANE_C_DB_REPORT.md §2):
 *  - workspace_schema_registry: every write is (a) a SECURITY DEFINER lifecycle function owned by rab_secure_owner
 *    (register/mark_ready/mark_failed: EXECUTE crewflow only; mark_superseded: EXECUTE crewflow_app, runs as the owner),
 *    (b) `core.provision_workspace` (SECURITY DEFINER, owner crewflow), or (c) the migration identity — the
 *    WorkspaceSchemaMigrator refuses any role but crewflow/superuser, `core.record_workspace_schema_drift` is EXECUTE
 *    crewflow only, the TS provisioner runs on the provisioner's crewflow connection. No runtime source contains an
 *    INSERT/UPDATE/DELETE on the table and it has no TypeORM entity.
 *  - workspace_membership DELETE: no runtime DELETE; lifecycle changes go through suspend/reinstate (SECURITY DEFINER);
 *    there is no DELETE policy, so under FORCE RLS the privilege only ever matched zero rows (intent restored, no
 *    behaviour change). UPDATE stays: `workspace_membership_self_update` is a designed policy.
 *  - hws_backfill_checkpoint DELETE: the hws:backfill tool (runs as the runtime role) only SELECTs and upserts.
 *  - stored_file DELETE: files are tombstoned (status DELETED via UPDATE); no runtime DELETE, no ORM delete/remove on
 *    StoredFile. `file-storage-security.integration.spec.ts` already asserts this DELETE is "permission denied".
 *
 * FK actions (ON DELETE CASCADE / SET NULL from organisation/user) run as the referencing table's owner and never needed
 * these grants. SELECT is untouched everywhere; INSERT/UPDATE are untouched where listed.
 *
 * OUT OF SCOPE, reported not changed: the same copied-grant drift on WORKSPACE-scoped tables (attendance_correction
 * UPDATE/DELETE, shift_request_staff UPDATE) — those grants are part of every workspace schema's fingerprint, so
 * restoring them is a workspace-template module change (owner decision), not a core-only REVOKE.
 *
 * The REVOKE must be issued by the table owner (crewflow) or a superuser; a non-owner REVOKE is a silent no-op with a
 * WARNING, so the migration re-reads the catalog and refuses if any revoked privilege survives (table- or column-level).
 * Not production-approved (production-migration-approval.ts is deliberately unchanged — N1).
 */
export const CREWFLOW_APP_COPIED_WRITE_REVOKES_1786720020000: ReadonlyArray<{ table: string; privileges: readonly string[] }> = [
  { table: 'workspace_schema_registry', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'workspace_membership', privileges: ['DELETE'] },
  { table: 'hws_backfill_checkpoint', privileges: ['DELETE'] },
  { table: 'stored_file', privileges: ['DELETE'] },
];

export class CrewflowAppCopiedWriteGrantRevoke1786720020000 implements MigrationInterface {
  name = 'CrewflowAppCopiedWriteGrantRevoke1786720020000';

  async up(runner: QueryRunner): Promise<void> {
    await assertRuntimeRoleExists(runner);
    for (const { table, privileges } of CREWFLOW_APP_COPIED_WRITE_REVOKES_1786720020000) {
      await runner.query(`REVOKE ${privileges.join(', ')} ON core.${quoteIdent(table)} FROM crewflow_app`);
    }
    for (const { table, privileges } of CREWFLOW_APP_COPIED_WRITE_REVOKES_1786720020000) {
      for (const privilege of privileges) {
        // DELETE has no column-level form; INSERT/UPDATE are also checked per column (has_any_column_privilege is true
        // for a table-level grant too, so it covers both).
        const [row] = (await runner.query(
          privilege === 'DELETE'
            ? `SELECT has_table_privilege('crewflow_app', $1::regclass, 'DELETE') AS held,
                      has_table_privilege('crewflow_app', $1::regclass, 'SELECT') AS can_select`
            : `SELECT has_any_column_privilege('crewflow_app', $1::regclass, '${privilege}') AS held,
                      has_table_privilege('crewflow_app', $1::regclass, 'SELECT') AS can_select`,
          [`core.${table}`],
        )) as Array<{ held: boolean; can_select: boolean }>;
        if (row.held) {
          throw new Error(
            `${this.name}: crewflow_app still holds ${privilege} on core.${table} after REVOKE — the migration must run as the table owner (crewflow) or a superuser.`,
          );
        }
        if (!row.can_select) {
          throw new Error(`${this.name}: crewflow_app lost SELECT on core.${table}; refusing.`);
        }
      }
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await assertRuntimeRoleExists(runner);
    for (const { table, privileges } of CREWFLOW_APP_COPIED_WRITE_REVOKES_1786720020000) {
      await runner.query(`GRANT ${privileges.join(', ')} ON core.${quoteIdent(table)} TO crewflow_app`);
    }
  }
}

async function assertRuntimeRoleExists(runner: QueryRunner): Promise<void> {
  const [row] = (await runner.query(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crewflow_app') AS present`)) as Array<{
    present: boolean;
  }>;
  if (!row?.present) {
    throw new Error('CrewflowAppCopiedWriteGrantRevoke1786720020000: role crewflow_app does not exist; the role split has not run.');
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected identifier ${name}`);
  return name;
}
