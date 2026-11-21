import type { WorkspaceUpgradeCommand } from '../workspace-upgrade-command';

/**
 * Release 0.7.0, workspace structure level 25 (M4 design §11 LOW finding, owner decision 2026-11-21: "a staff-own-or-manager
 * RLS predicate on attendance, following the payroll_record_select pattern"). DRAFT — NEW SQL, owner SQL review FIRST; never
 * edited after merge once approved. Depends on #175 (0.7.0 release registration), #177 (level 23) and #243 (level 24).
 *
 * The gap: `attendance_tenant` (template, FOR ALL) is tenant-only (organisation + workspace). Staff-to-staff isolation on
 * attendance was enforced only in the service (`ownStaffProfile`, `attendanceReadScopeCondition`), so a code path that forgot
 * it would let Staff A read or write Staff B's attendance in the same workspace (CLAUDE.md: the fifth enforcement layer).
 *
 * What it does: one `ALTER POLICY attendance_tenant ON <schema>.attendance USING (...) WITH CHECK (...)`, the same predicate on
 * both sides: the tenant binding (unchanged) AND one of
 *   - worker: `rab.actor_type = 'worker'` (the attendance monitor, post-shift lifecycle, final timesheet, statements; the same
 *     marker staff_profile_worker_scan / shift_staff_review_worker_scan accept; bound only by TenantContextService);
 *   - staff own: the row's staff profile belongs to the caller (`sp.user_id = core.current_uid()`), as payroll_record_select;
 *   - workspace manager: any manager_profile of THIS workspace that is not a Venue Manager (Manager, CEO), as
 *     payroll_record_select's payrollManager;
 *   - Venue Manager of the shift's venue (manager_venue of this workspace), as design Appendix A.1 venueManagerOfShift.
 * So nobody gains anything: every clause is narrower than the tenant-only policy it replaces. Custom workspace members never
 * hold attendance.view (MEMBER_ROLE_ALLOWED_PERMISSIONS) and see no attendance rows (they saw none through the services either).
 *   - An unset `rab.user_id` makes core.current_uid() NULL: no staff / manager clause can match (fail closed); no tenant context
 *     still matches nothing (the tenant line is unchanged).
 *   - FOR ALL, PERMISSIVE and TO PUBLIC are unchanged (ALTER POLICY ... USING / WITH CHECK rewrites only the two expressions);
 *     the policy count is unchanged, so core.verify_workspace_schema_v1 is unchanged.
 *   - Idempotent: re-running it stores the same expressions. A missing policy makes it fail (42704): the runner rolls the step
 *     back and blocks the workspace (fail closed). It drops nothing (`mayDrop` unset).
 *   - Lock: ACCESS EXCLUSIVE on this workspace's attendance for the catalog update only (no scan, no data change).
 * Policy sub-selects run under the caller's own RLS on staff_profile / manager_profile / shift / manager_venue; none of those
 * policies reads attendance, so there is no policy recursion. The same statement on `core.attendance` (the HWS-off copy) and
 * in core.provision_workspace (new workspaces) is in migration AttendanceStaffScopeRls1786722100000.
 * Twenty has no equivalent (no RLS): a Crewflow addition.
 */
export const ATTENDANCE_STAFF_SCOPE_TIMESTAMP = 1786722100000;

export const ATTENDANCE_POLICY = 'attendance_tenant';

function checkedSchema(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  return schema;
}

/** The tenant-only predicate of the template / core policy (what down() restores). */
const TENANT = 'organisation_id = core.current_org() AND workspace_id = core.current_workspace()';

/** The level-25 predicate for one schema (USING and WITH CHECK). */
export function attendanceScopePredicate(schema: string): string {
  const s = checkedSchema(schema);
  // sql-injection-reviewed: s is 'core' or a regex-validated `workspace_<32 hex>` name; everything else is constant text.
  return `${TENANT}
    AND (
      current_setting('rab.actor_type', true) = 'worker'
      OR EXISTS (
        SELECT 1 FROM "${s}".staff_profile sp
        WHERE sp.id = attendance.staff_profile_id AND sp.user_id = core.current_uid()
          AND sp.organisation_id = core.current_org() AND sp.workspace_id = core.current_workspace()
      )
      OR EXISTS (
        SELECT 1 FROM core.manager_profile mp
        WHERE mp.user_id = core.current_uid() AND mp.organisation_id = core.current_org()
          AND mp.workspace_id = core.current_workspace() AND mp.type <> 'venue'
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

/** The command body (and the core / provision statement): tenant AND (worker OR staff own OR manager OR venue manager). */
export function attendanceStaffScopeSql(schema: string): string {
  return alterSql(schema, attendanceScopePredicate(schema));
}

/** down() only (core): the tenant-only predicate back. */
export function attendanceTenantOnlySql(schema: string): string {
  return alterSql(schema, TENANT);
}

/**
 * Expected `core.workspace_schema_fingerprint_v2` of a level-25 workspace per PostgreSQL major. Measured, never derived: a
 * level-24 workspace + this command, a workspace built by the TypeScript provisioner and one built by the level-25
 * core.provision_workspace must all equal it (ws-attendance-staff-scope.integration.spec.ts `[l25-fp]`; the per-major
 * `generate-workspace-fingerprints.ts` ci run prints `MISMATCH (measured …)` for an undeclared or wrong value). An undeclared
 * major makes AttendanceStaffScopeRls1786722100000 refuse (exit 66): fail closed.
 */
export const ATTENDANCE_STAFF_SCOPE_FINGERPRINTS_V2: Readonly<Partial<Record<16 | 17 | 18, string>>> = Object.freeze({
  16: '0000000000000000000000000000000000000000000000000000000000000016',
  17: '0000000000000000000000000000000000000000000000000000000000000017',
  18: '0000000000000000000000000000000000000000000000000000000000000018',
});

export const ATTENDANCE_STAFF_SCOPE_PROVISION_LITERAL = 'db:provision_workspace@AttendanceStaffScopeRls1786722100000';

export const ATTENDANCE_STAFF_SCOPE: WorkspaceUpgradeCommand = Object.freeze({
  kind: 'workspace',
  name: 'AttendanceStaffScope',
  timestamp: ATTENDANCE_STAFF_SCOPE_TIMESTAMP,
  sql: attendanceStaffScopeSql,
  structure: Object.freeze({
    level: 25,
    fingerprints: ATTENDANCE_STAFF_SCOPE_FINGERPRINTS_V2,
    provisionFunctionLiteral: ATTENDANCE_STAFF_SCOPE_PROVISION_LITERAL,
  }),
});
