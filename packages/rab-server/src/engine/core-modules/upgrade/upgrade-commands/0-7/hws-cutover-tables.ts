/**
 * Part C3: the 21 workspace-business tables, frozen for the cutover (equal to WORKSPACE_TABLES, provision-workspace-schema.ts,
 * and to core.hws_cutover_source_sql's closed list; hws-cutover.spec.ts proves both). Command files may not import them
 * (source guard), hence the copy here.
 */
export const HWS_CUTOVER_TABLE_LIST = [
  'staff_profile', 'user_note', 'venue', 'venue_manager_staff', 'job_role', 'venue_role_rate', 'manager_venue', 'shift',
  'shift_request_staff', 'shift_assignment', 'job_offer', 'replacement_request', 'attendance', 'attendance_correction', 'shift_report', 'shift_staff_review',
  'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document',
] as const;

/**
 * FK-safe copy order (parents first): WORKSPACE_TABLE_COPY_ORDER (backfill/fk-graph.ts, Kahn's algorithm over the reviewed
 * workspace→workspace edges, alphabetical within a level). hws-cutover.spec.ts proves it equal.
 */
export const HWS_CUTOVER_COPY_ORDER = [
  'job_role', 'payroll_run', 'user_note', 'venue', 'manager_venue', 'shift', 'staff_profile', 'venue_role_rate', 'payslip',
  'shift_assignment', 'shift_report', 'shift_request_staff', 'venue_manager_staff', 'attendance', 'job_offer', 'payslip_document',
  'shift_staff_review', 'attendance_correction', 'payroll_record', 'replacement_request', 'payroll_run_line',
] as const;

/** Constraints a READY workspace schema carries NOT VALID today (HWS-AUDIT §3.3; owner decision pending: VALIDATE in C3 or not). */
export const HWS_CUTOVER_KNOWN_NOT_VALID: readonly string[] = ['staff_profile_workspace_required'];
