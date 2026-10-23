import { WORKSPACE_SCHEMA_V1_TEMPLATE } from './workspace-schema-v1.template';
import { shiftTeamPolicy } from './shift-team-policy';
import { venueManagerStaffAssignmentSql } from './venue-manager-staff-assignment';
import { shiftReviewSignoffSql } from './shift-review-signoff';
import { shiftReviewWorkerScanSql } from './shift-review-worker-scan';
import { attendanceReviewSql } from './attendance-review';
import { venuePhotoSql } from './venue-photo';
import { payrollRecordSql } from './payroll-record';
import { payStatementSql } from './pay-statement';
import { approvedShiftStatementSql } from './approved-shift-statement';
import { payrollRunsSql } from './payroll-runs';
import { offerKindSql } from './offer-kind';
import { attendanceCheckInSql } from './attendance-check-in';

/**
 * FROZEN with migration ServerPathWorkspaceProvisioning1786719500000 (same convention as the other files in this folder:
 * never edited after merge). It composes the V1 workspace template, in exactly the order provision-workspace-schema.ts
 * `applyTemplate()` runs it, for a sentinel schema name that the database function `core.provision_workspace(uuid)`
 * replaces with the derived, regex-checked `workspace_<32 hex>` name. A later template change adds its own frozen module
 * and its own migration that re-creates the function with a new composition; it does not edit this file.
 *
 * Kept out of the migration file itself because TypeORM loads every export of a migration file as a migration class.
 */

/** A syntactically valid schema name no real workspace can have: the nil uuid, which the function refuses. */
export const SERVER_PATH_SENTINEL_SCHEMA = 'workspace_00000000000000000000000000000000';

/** V1_EXPECTED (provision-workspace-schema.ts) as of migration 1786719500000. */
export const SERVER_PATH_EXPECTED_V1 = { tables: 21, foreignKeys: 128, indexes: 90, policies: 39 } as const;

/** WORKSPACE_TABLES (provision-workspace-schema.ts) as of migration 1786719500000. */
export const SERVER_PATH_TABLES_V1 = [
  'staff_profile', 'user_note', 'venue', 'venue_manager_staff', 'job_role', 'venue_role_rate', 'manager_venue', 'shift',
  'shift_request_staff', 'shift_assignment', 'job_offer', 'replacement_request', 'attendance', 'attendance_correction', 'shift_report', 'shift_staff_review',
  'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document',
] as const;

/** The exact statement sequence `applyTemplate()` runs, for the sentinel schema. */
export function composeServerPathTemplateV1(): string {
  const s = SERVER_PATH_SENTINEL_SCHEMA;
  const parts = [
    WORKSPACE_SCHEMA_V1_TEMPLATE.split('__WS__').join(s),
    shiftTeamPolicy(s),
    venueManagerStaffAssignmentSql(s),
    shiftReviewSignoffSql(s),
    shiftReviewWorkerScanSql(s),
    attendanceReviewSql(s),
    venuePhotoSql(s),
    payrollRecordSql(s),
    payStatementSql(s),
    approvedShiftStatementSql(s),
    payrollRunsSql(s),
    offerKindSql(s),
    attendanceCheckInSql(s),
  ];
  // Each part is a complete statement list; the separator only guarantees a boundary (an empty statement is harmless).
  return parts.join(';\n');
}
