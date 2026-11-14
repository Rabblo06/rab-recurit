/**
 * The 21 workspace business tables. Every one carries workspace_id (checked against the template by provision-workspace-schema.ts).
 *
 * A leaf module with no imports on purpose: the runtime primitive `businessTables(manager)`
 * (engine/core-modules/tenant/business-tables.ts) types its keys from this list, and tools/check-workspace-table-qualified.cjs
 * and tools/check-sql-injection.cjs read it from this file's text. Keep it a single `as const` array literal of plain
 * lower-case names.
 */
export const WORKSPACE_TABLES = [
  'staff_profile', 'user_note', 'venue', 'venue_manager_staff', 'job_role', 'venue_role_rate', 'manager_venue', 'shift',
  'shift_request_staff', 'shift_assignment', 'job_offer', 'replacement_request', 'attendance', 'attendance_correction', 'shift_report', 'shift_staff_review',
  'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document',
] as const;

export type WorkspaceTable = (typeof WORKSPACE_TABLES)[number];
