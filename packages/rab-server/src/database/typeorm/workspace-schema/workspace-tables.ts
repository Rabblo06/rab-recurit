/**
 * The 23 workspace business tables. Every one carries workspace_id (checked against the template by provision-workspace-schema.ts).
 *
 * A leaf module with no imports on purpose: the runtime primitive `businessTables(manager)`
 * (engine/core-modules/tenant/business-tables.ts) types its keys from this list, and tools/check-workspace-table-qualified.cjs
 * and tools/check-sql-injection.cjs read it from this file's text. Keep it a single `as const` array literal of plain
 * lower-case names.
 *
 * The first 21 are the frozen template's (WORKSPACE_TEMPLATE_TABLES below); attendance_break and attendance_sync_receipt are
 * added by workspace structure level 27 (WorkspaceAttendanceBreaksReceipts1786722150000, the first structure level that adds
 * tables), after the C3 cutover (owner decision 44: HWS_CUTOVER_TABLE_LIST stays the 21 template tables).
 */
export const WORKSPACE_TABLES = [
  'staff_profile', 'user_note', 'venue', 'venue_manager_staff', 'job_role', 'venue_role_rate', 'manager_venue', 'shift',
  'shift_request_staff', 'shift_assignment', 'job_offer', 'replacement_request', 'attendance', 'attendance_correction', 'shift_report', 'shift_staff_review',
  'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document', 'attendance_break', 'attendance_sync_receipt',
] as const;

export type WorkspaceTable = (typeof WORKSPACE_TABLES)[number];

/**
 * The 21 tables the frozen workspace template (modules 1..20) creates, in template order: what both provisioners bind with a
 * `<table>_workspace_bound` CHECK right after the template (before any structure level), what the module-version counts
 * describe, and what the C3 cutover copies. Frozen: a later structure level that adds a table adds it to WORKSPACE_TABLES
 * only, and binds it itself.
 */
export const WORKSPACE_TEMPLATE_TABLES = [
  'staff_profile', 'user_note', 'venue', 'venue_manager_staff', 'job_role', 'venue_role_rate', 'manager_venue', 'shift',
  'shift_request_staff', 'shift_assignment', 'job_offer', 'replacement_request', 'attendance', 'attendance_correction', 'shift_report', 'shift_staff_review',
  'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document',
] as const satisfies readonly WorkspaceTable[];

/** The tables a structure level above the template adds, with that level (the table exists from that level on). */
export const WORKSPACE_STRUCTURE_LEVEL_TABLES: Readonly<Record<string, number>> = Object.freeze({
  attendance_break: 27,
  attendance_sync_receipt: 27,
});
