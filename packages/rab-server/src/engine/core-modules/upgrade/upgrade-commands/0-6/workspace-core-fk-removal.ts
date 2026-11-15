import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';

/**
 * Release 0.6.0, workspace structure level 22 (OWNER-DB-ULTIMATE Part D, owner decision 0a option (b), 2026-11-14): DRAFT for
 * owner SQL review (docs/plans/phase-x3/WS-COMMANDS.md "FOR OWNER REVIEW — 0a"); never run anywhere but throwaway databases until
 * approved. Drops every foreign key from a workspace schema's tables to core."user", core.organisation and core.manager_workspace
 * (72 per schema: 31 + 21 + 20). Twenty creates foreign keys only inside the same workspace schema
 * (twentyhq/twenty @ eedb0a73 workspace-schema-foreign-key-manager.service.ts:32); re-implemented, not copied.
 *
 * Why (C1-STATUS.md §5): a DELETE / key UPDATE of one core row must run the RI check on every referencing table of EVERY
 * workspace schema in one transaction (~31 relation locks per schema for core."user"), which exhausts the lock table from a few
 * hundred workspaces (`out of shared memory`, max_locks_per_transaction). Without these constraints a core delete touches no
 * workspace table.
 *
 * What replaces them:
 *   - organisation_id / workspace_id: already bound on every write by FORCE RLS (`organisation_id = core.current_org() AND
 *     workspace_id = core.current_workspace()`) and the per-table `<table>_workspace_bound` CHECK; the bound values come from the
 *     verified session, never the client;
 *   - user references: checked by the service layer on every write path that sets one from anything but the verified actor
 *     (CoreReferenceService.assertUsersOfOrganisationTx), and the actor columns come from the verified session;
 *   - the periodic orphan check (Worker, report-only) lists rows pointing at a missing core row.
 * The ON DELETE CASCADE / SET NULL actions these constraints carried no longer run (WS-COMMANDS.md §0a.5: owner decision).
 *
 * FROZEN once approved. Idempotent (`DROP CONSTRAINT IF EXISTS`); declares `mayDrop` (it drops catalog objects).
 */
export const WORKSPACE_CORE_FK_REMOVAL_TIMESTAMP = 1786721490000;

/** table → the constraints dropped (the exact definitions the frozen template created, for review and the orphan check). */
export const WORKSPACE_CORE_FOREIGN_KEYS: Readonly<Record<string, ReadonlyArray<readonly [name: string, definition: string]>>> = Object.freeze({
  attendance: [
    ['attendance_clock_in_by_fkey', 'FOREIGN KEY (clock_in_by) REFERENCES core."user"(id)'],
    ['attendance_clock_out_by_fkey', 'FOREIGN KEY (clock_out_by) REFERENCES core."user"(id)'],
    ['attendance_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['attendance_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  attendance_correction: [
    ['attendance_correction_corrected_by_fkey', 'FOREIGN KEY (corrected_by) REFERENCES core."user"(id)'],
    ['attendance_correction_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['attendance_correction_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  job_offer: [
    ['job_offer_confirmed_by_fkey', 'FOREIGN KEY (confirmed_by) REFERENCES core."user"(id)'],
    ['job_offer_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES core."user"(id) ON DELETE SET NULL'],
    ['job_offer_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['job_offer_rejected_by_fkey', 'FOREIGN KEY (rejected_by) REFERENCES core."user"(id)'],
    ['job_offer_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  job_role: [
    ['job_role_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES core."user"(id)'],
    ['job_role_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['job_role_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  manager_venue: [
    ['manager_venue_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['manager_venue_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  payroll_record: [
    ['payroll_record_approved_by_fkey', 'FOREIGN KEY (approved_by) REFERENCES core."user"(id)'],
    ['payroll_record_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['payroll_record_rejected_by_fkey', 'FOREIGN KEY (rejected_by) REFERENCES core."user"(id)'],
    ['payroll_record_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  payroll_run: [
    ['payroll_run_finalised_by_fkey', 'FOREIGN KEY (finalised_by) REFERENCES core."user"(id)'],
    ['payroll_run_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['payroll_run_prepared_by_fkey', 'FOREIGN KEY (prepared_by) REFERENCES core."user"(id)'],
    ['payroll_run_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  payroll_run_line: [
    ['payroll_run_line_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['payroll_run_line_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  payslip: [
    ['payslip_net_recorded_by_fkey', 'FOREIGN KEY (net_recorded_by) REFERENCES core."user"(id)'],
    ['payslip_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['payslip_paid_by_fkey', 'FOREIGN KEY (paid_by) REFERENCES core."user"(id)'],
    ['payslip_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  payslip_document: [
    ['payslip_document_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['payslip_document_uploaded_by_fkey', 'FOREIGN KEY (uploaded_by) REFERENCES core."user"(id)'],
    ['payslip_document_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  replacement_request: [
    ['replacement_request_approved_by_fkey', 'FOREIGN KEY (approved_by) REFERENCES core."user"(id) ON DELETE SET NULL'],
    ['replacement_request_notified_user_id_fkey', 'FOREIGN KEY (notified_user_id) REFERENCES core."user"(id) ON DELETE SET NULL'],
    ['replacement_request_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['replacement_request_rejected_by_fkey', 'FOREIGN KEY (rejected_by) REFERENCES core."user"(id) ON DELETE SET NULL'],
    ['replacement_request_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  shift: [
    ['shift_approved_by_fkey', 'FOREIGN KEY (approved_by) REFERENCES core."user"(id)'],
    ['shift_cancelled_by_fkey', 'FOREIGN KEY (cancelled_by) REFERENCES core."user"(id)'],
    ['shift_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES core."user"(id)'],
    ['shift_declined_by_fkey', 'FOREIGN KEY (declined_by) REFERENCES core."user"(id)'],
    ['shift_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['shift_requested_by_fkey', 'FOREIGN KEY (requested_by) REFERENCES core."user"(id)'],
    ['shift_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  shift_assignment: [
    ['shift_assignment_assigned_by_fkey', 'FOREIGN KEY (assigned_by) REFERENCES core."user"(id)'],
    ['shift_assignment_attendance_reviewed_by_fkey', 'FOREIGN KEY (attendance_reviewed_by) REFERENCES core."user"(id)'],
    ['shift_assignment_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['shift_assignment_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  shift_report: [
    ['shift_report_finalised_by_fkey', 'FOREIGN KEY (finalised_by) REFERENCES core."user"(id)'],
    ['shift_report_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['shift_report_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  shift_request_staff: [
    ['shift_request_staff_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
  ],
  shift_staff_review: [
    ['shift_staff_review_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['shift_staff_review_reviewer_user_id_fkey', 'FOREIGN KEY (reviewer_user_id) REFERENCES core."user"(id)'],
    ['shift_staff_review_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  staff_profile: [
    ['staff_profile_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES core."user"(id) ON DELETE SET NULL'],
    ['staff_profile_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['staff_profile_user_id_fkey', 'FOREIGN KEY (user_id) REFERENCES core."user"(id) ON DELETE CASCADE'],
    ['staff_profile_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  user_note: [
    ['user_note_author_user_id_fkey', 'FOREIGN KEY (author_user_id) REFERENCES core."user"(id) ON DELETE SET NULL'],
    ['user_note_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['user_note_subject_user_id_fkey', 'FOREIGN KEY (subject_user_id) REFERENCES core."user"(id) ON DELETE CASCADE'],
    ['user_note_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id) ON DELETE CASCADE'],
  ],
  venue: [
    ['venue_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES core."user"(id)'],
    ['venue_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['venue_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  venue_manager_staff: [
    ['venue_manager_staff_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id)'],
    ['venue_manager_staff_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
  venue_role_rate: [
    ['venue_role_rate_organisation_id_fkey', 'FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE'],
    ['venue_role_rate_workspace_id_fkey', 'FOREIGN KEY (workspace_id) REFERENCES core.manager_workspace(id)'],
  ],
});

/** The command body for one validated `workspace_<32 hex>` schema: one ALTER TABLE per table, every drop guarded. */
export function workspaceCoreFkRemovalSql(schemaName: string): string {
  return Object.entries(WORKSPACE_CORE_FOREIGN_KEYS)
    // sql-injection-reviewed: schemaName is the runner-derived, regex-validated `workspace_<32 hex>` name; table and constraint names are constants of this file.
    .map(([table, fks]) => `ALTER TABLE ${schemaName}.${table} ${fks.map(([name]) => `DROP CONSTRAINT IF EXISTS ${name}`).join(', ')}`)
    .join(';\n');
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The frozen workspace template WITHOUT the 72 workspace → core constraints, for `core.provision_workspace` at level 22+ (a new
 * workspace never gets them). Creating and then dropping them in the provisioning transaction is not equivalent: DROP CONSTRAINT
 * of a foreign key takes ACCESS EXCLUSIVE on the referenced table (core."user", core.organisation, core.manager_workspace) until
 * commit, which blocks every request reading those tables while a workspace is created, and deadlocks concurrent creates (CI:
 * server-path-provisioning-api, 40P01). Pure text transformation of the constant template, fail closed:
 *   - an `ALTER TABLE <t> ADD CONSTRAINT <name> <definition>;` statement is removed whole;
 *   - an inline `CONSTRAINT <name> <definition>` item of a CREATE TABLE is removed with its line (and, for the last item, the
 *     comma of the item before it);
 *   - every one of the 72 must be removed exactly once, and no reference to the three core tables may remain; otherwise it throws.
 * `DROP CONSTRAINT IF EXISTS <name>` statements of later modules stay (no-ops). The result builds the same catalog as the 20
 * modules + level 21 + this command's drops (the declared level-22 fingerprint proves it on every provision).
 */
export function withoutWorkspaceCoreForeignKeys(template: string): string {
  let out = template;
  for (const fks of Object.values(WORKSPACE_CORE_FOREIGN_KEYS)) {
    for (const [name, definition] of fks) {
      // The definition as pg_get_constraintdef printed it; any whitespace run of the template may stand for its single spaces.
      const def = escapeRegExp(definition).replace(/ /g, '\\s+');
      // sql-injection-reviewed: a regular expression over the constant template, never SQL that runs; name / definition are constants of this file.
      const statement = new RegExp(`(?:^|\\n)ALTER TABLE [^;\\n]+ ADD CONSTRAINT "?${name}"?\\s+${def};[ \\t]*(?=\\n|$)`, 'g');
      const inline = new RegExp(`\\n[ \\t]*CONSTRAINT ${name}\\s+${def}(,?)(?=\\n)`, 'g');
      const statements = out.match(statement)?.length ?? 0;
      const inlines = out.match(inline)?.length ?? 0;
      if (statements + inlines !== 1) throw new Error(`level-22 template: constraint ${name} found ${statements + inlines} times, expected exactly once`);
      if (statements === 1) {
        out = out.replace(statement, '');
        continue;
      }
      const LAST = '\u0000';
      out = out.replace(inline, (_match, comma: string) => (comma ? '' : LAST));
      // It was the last item of its CREATE TABLE: the item before it loses its trailing comma.
      out = out.replace(new RegExp(`,([ \\t]*)${LAST}`), '$1');
      if (out.includes(LAST)) throw new Error(`level-22 template: constraint ${name} is the last item but no item precedes it`);
    }
  }
  if (/REFERENCES\s+core\.("user"|organisation|manager_workspace)(?![a-z_])/.test(out)) throw new Error('level-22 template: a workspace -> core reference remains');
  return out;
}

/**
 * Expected `core.workspace_schema_fingerprint_v2` of a level-22 workspace per PostgreSQL major. DRAFT: 16 was measured on a
 * throwaway postgres:16 owner-login ci-db (two level-21 workspaces + this command, identical) only so the draft can be tested on
 * throwaway databases; 17 / 18 are generated after the owner approves the SQL. Until declared, WorkspaceCoreForeignKeyRemoval
 * 1786721490000 refuses on that major (exit 66, nothing applied): fail closed.
 */
export const WORKSPACE_CORE_FK_REMOVAL_FINGERPRINTS_V2: Readonly<Partial<Record<16 | 17 | 18, string>>> = Object.freeze({
  16: 'a75b598e3c29bb33797022cfa90dadd0fad3ae2f230b13462169680ccc1a8389',
});

export const WORKSPACE_CORE_FK_REMOVAL_PROVISION_LITERAL = 'db:provision_workspace@WorkspaceCoreForeignKeyRemoval1786721490000';

export const WORKSPACE_CORE_FK_REMOVAL: WorkspaceUpgradeCommand = Object.freeze({
  kind: 'workspace',
  name: 'DropWorkspaceCoreForeignKeys',
  timestamp: WORKSPACE_CORE_FK_REMOVAL_TIMESTAMP,
  sql: workspaceCoreFkRemovalSql,
  structure: Object.freeze({
    level: 22,
    fingerprints: WORKSPACE_CORE_FK_REMOVAL_FINGERPRINTS_V2,
    provisionFunctionLiteral: WORKSPACE_CORE_FK_REMOVAL_PROVISION_LITERAL,
    mayDrop: true,
  }),
});
