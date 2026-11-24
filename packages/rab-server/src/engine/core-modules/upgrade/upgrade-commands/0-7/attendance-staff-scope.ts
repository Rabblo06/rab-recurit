/**
 * M4 design §11 LOW finding (owner decision 2026-11-21: "a staff-own-or-manager RLS predicate on attendance, following the
 * payroll_record_select pattern"). DRAFT — NEW SQL, owner SQL review FIRST; never edited after merge once approved.
 *
 * THE predicate, in one place, for every copy of `attendance`:
 *   - `core.attendance` (HWS off: production today): migration AttendanceStaffScopeRls1786722100000;
 *   - every `workspace_<hex>.attendance` (HWS on): the 0.7.0 workspace command that follows the 0.7.0 release chain
 *     (#175 / #177 / #243). It imports these builders from this sibling file (command files may import siblings only).
 * No command object lives here yet, so nothing is registered and the workspace structure level does not move.
 *
 * The gap: `attendance_tenant` (FOR ALL) is tenant-only (organisation + workspace). Staff-to-staff isolation on attendance was
 * enforced only in the service (`ownStaffProfile`, `attendanceReadScopeCondition`), so a code path that forgot it would let
 * Staff A read or write Staff B's attendance in the same workspace (CLAUDE.md: the fifth enforcement layer).
 *
 * The statement: `ALTER POLICY attendance_tenant ON <schema>.attendance USING (P) WITH CHECK (P)`, P = the unchanged tenant
 * binding AND one of (in this order: the two uncorrelated tests first, so the planner can evaluate them once per statement)
 *   - worker: `rab.actor_type = 'worker'` (the attendance monitor, post-shift lifecycle, final timesheet, statements; the same
 *     marker staff_profile_worker_scan / shift_staff_review_worker_scan accept; bound only by TenantContextService);
 *   - workspace manager: a manager_profile of THIS workspace that is not a Venue Manager (Manager, CEO), as
 *     payroll_record_select's payrollManager;
 *   - staff own: the row's staff profile belongs to the caller (`sp.user_id = core.current_uid()`), as payroll_record_select;
 *   - Venue Manager of the shift's venue (manager_venue of this workspace), as design Appendix A.1 venueManagerOfShift.
 * Every clause is narrower than the tenant-only policy it replaces, so nobody gains a row. Custom workspace members never hold
 * attendance.view (MEMBER_ROLE_ALLOWED_PERMISSIONS) and see no attendance rows (they saw none through the services either).
 *   - An unset `rab.user_id` makes core.current_uid() NULL: no staff / manager clause can match (fail closed); no tenant context
 *     still matches nothing (the tenant line is unchanged).
 *   - FOR ALL, PERMISSIVE and TO PUBLIC are unchanged (ALTER POLICY ... USING / WITH CHECK rewrites only the two expressions);
 *     the policy count is unchanged. Idempotent: re-running stores the same expressions.
 * Policy sub-selects run under the caller's own RLS on staff_profile / manager_profile / shift / manager_venue; none of those
 * policies reads attendance, so there is no policy recursion. Twenty has no equivalent (no RLS): a Crewflow addition.
 */
export const ATTENDANCE_POLICY = 'attendance_tenant';

function checkedSchema(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  return schema;
}

/** The tenant-only predicate of the template / core policy before this change (what a down() restores). */
const TENANT = 'organisation_id = core.current_org() AND workspace_id = core.current_workspace()';

/** The staff-own-or-manager predicate for one schema (USING and WITH CHECK). */
export function attendanceScopePredicate(schema: string): string {
  const s = checkedSchema(schema);
  // sql-injection-reviewed: s is 'core' or a regex-validated `workspace_<32 hex>` name; everything else is constant text.
  return `${TENANT}
    AND (
      current_setting('rab.actor_type', true) = 'worker'
      OR EXISTS (
        SELECT 1 FROM core.manager_profile mp
        WHERE mp.user_id = core.current_uid() AND mp.organisation_id = core.current_org()
          AND mp.workspace_id = core.current_workspace() AND mp.type <> 'venue'
      )
      OR EXISTS (
        SELECT 1 FROM "${s}".staff_profile sp
        WHERE sp.id = attendance.staff_profile_id AND sp.user_id = core.current_uid()
          AND sp.organisation_id = core.current_org() AND sp.workspace_id = core.current_workspace()
      )
      OR EXISTS (
        SELECT 1 FROM "${s}".shift s
        JOIN "${s}".manager_venue mv ON mv.venue_id = s.venue_id
        JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
        WHERE s.id = attendance.shift_id
          AND s.organisation_id = core.current_org() AND s.workspace_id = core.current_workspace()
          AND mv.organisation_id = core.current_org() AND mv.workspace_id = core.current_workspace()
          AND mp.user_id = core.current_uid() AND mp.type = 'venue'
          AND mp.organisation_id = core.current_org() AND mp.workspace_id = core.current_workspace()
      )
    )`;
}

function alterSql(schema: string, predicate: string): string {
  const s = checkedSchema(schema);
  // sql-injection-reviewed: s is 'core' or a regex-validated `workspace_<32 hex>` name; predicate is built from constants above.
  return `ALTER POLICY ${ATTENDANCE_POLICY} ON "${s}".attendance USING (
    ${predicate}
  ) WITH CHECK (
    ${predicate}
  )`;
}

/** tenant AND (worker OR staff own OR workspace manager OR venue manager of the shift), on both expressions. */
export function attendanceStaffScopeSql(schema: string): string {
  return alterSql(schema, attendanceScopePredicate(schema));
}

/** down() only: the tenant-only predicate back. */
export function attendanceTenantOnlySql(schema: string): string {
  return alterSql(schema, TENANT);
}

/**
 * Security review of #305 (Low): attendance_correction had only the tenant policy, so staff could read each other's
 * corrections. The correction policy now also requires the parent attendance to be visible to the caller: the sub-select
 * runs under the attendance policy above, so a correction inherits exactly its attendance's readers (staff own, workspace
 * manager, Venue Manager of the shift, worker). Same expression for USING and WITH CHECK (only those who may act on the
 * attendance may insert its correction).
 */
export const ATTENDANCE_CORRECTION_POLICY = 'attendance_correction_tenant';

function correctionAlterSql(schema: string, predicate: string): string {
  const s = checkedSchema(schema);
  // sql-injection-reviewed: s is 'core' or a regex-validated `workspace_<32 hex>` name; predicate is built from constants here.
  return `ALTER POLICY ${ATTENDANCE_CORRECTION_POLICY} ON "${s}".attendance_correction USING (
    ${predicate}
  ) WITH CHECK (
    ${predicate}
  )`;
}

export function attendanceCorrectionScopePredicate(schema: string): string {
  const s = checkedSchema(schema);
  // sql-injection-reviewed: s is 'core' or a regex-validated `workspace_<32 hex>` name.
  return `${TENANT}
    AND EXISTS (SELECT 1 FROM "${s}".attendance a WHERE a.id = attendance_correction.attendance_id)`;
}

/** tenant AND the parent attendance is visible to the caller (so the attendance predicate applies), on both expressions. */
export function attendanceCorrectionScopeSql(schema: string): string {
  return correctionAlterSql(schema, attendanceCorrectionScopePredicate(schema));
}

/** down() only: the tenant-only correction predicate back. */
export function attendanceCorrectionTenantOnlySql(schema: string): string {
  return correctionAlterSql(schema, TENANT);
}
