import { createHash } from 'node:crypto';

import { approvedShiftStatementSql } from './v1/approved-shift-statement';
import { archiveColumnsSql } from './v1/archive-columns';
import { attendanceCheckInSql } from './v1/attendance-check-in';
import { attendanceMoneyChecksSql, attendanceMoneyPrecheckSql } from './v1/attendance-money-checks';
import { attendanceReviewSql } from './v1/attendance-review';
import { offerKindSql } from './v1/offer-kind';
import { payStatementSql } from './v1/pay-statement';
import { payrollEvidenceRestrictSql } from './v1/payroll-evidence-restrict';
import { payrollRecordSql } from './v1/payroll-record';
import { payrollRunsSql } from './v1/payroll-runs';
import { searchVectorsSql } from './v1/search-vectors';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import { shiftReviewSignoffSql } from './v1/shift-review-signoff';
import { shiftReviewWorkerScanSql } from './v1/shift-review-worker-scan';
import { shiftTeamPolicy } from './v1/shift-team-policy';
import { venueManagerStaffAssignmentSql } from './v1/venue-manager-staff-assignment';
import { venuePhotoSql } from './v1/venue-photo';
import { WORKSPACE_SCHEMA_V1_TEMPLATE } from './v1/workspace-schema-v1.template';

/**
 * Wave 2 lane S2 (B3): THE ordered list of workspace-schema modules — the single source of truth for what a
 * `workspace_<32 hex>` schema is made of, used by the TypeScript provisioner (`WORKSPACE_TEMPLATE_STEPS`), the
 * `WorkspaceSchemaMigrator` (existing schemas) and, through a frozen composition per release, `core.provision_workspace`.
 *
 * Rules (append-only, like migrations):
 *  - Never edit, reorder or remove an entry. Each entry's SQL lives in a frozen `v1/*.ts` file; its checksum (sha256 of
 *    the SQL rendered for the sentinel schema) is recorded in `core.workspace_schema_migration` when it is applied, and the
 *    migrator refuses a schema whose recorded checksum differs from the code (CHECKSUM_MISMATCH).
 *  - A new module = a new frozen `v1/*.ts` file + one entry here with the next `version` + a core migration that calls
 *    `WorkspaceSchemaMigrator.migrateAll({ throughVersion })` and re-creates `core.provision_workspace` with the new
 *    composition (see AttendanceMoneyChecks1786719810000 for the pattern) + the new expected fingerprint.
 *  - `version` is the module's 1-based ordinal; a workspace's `workspace_schema_registry.module_version` is the highest
 *    version applied. (`schema_version` stays the template MAJOR version, 1: SchemaResolverService routes only
 *    SUPPORTED_WORKSPACE_SCHEMA_VERSIONS = {1}, so bumping it per step would 404 every workspace on running images.)
 *
 * Versions 1–14 reproduce, in order, exactly what the hand-looped migrations 1786718100000 … 1786719700000 applied; an
 * existing workspace that matches the expected fingerprint for v14 is BASELINED at 14 rather than re-applied.
 */
export interface WorkspaceSchemaModule {
  /** Stable id, `v<major>.<3-digit version>-<slug>`. Recorded in the ledger. */
  readonly id: string;
  /** 1-based ordinal; equals the index in WORKSPACE_SCHEMA_MODULES + 1. */
  readonly version: number;
  /** The core migration that introduced the module (documentation and audit only). */
  readonly introducedBy: string;
  /** DDL for one schema. The schema name is a validated `workspace_<32 hex>` (or the sentinel), safe to inline. */
  readonly sql: (schemaName: string) => string;
  /** Optional data pre-check: a query returning one row `{ n }`; the module is refused (never applied) when n > 0. */
  readonly precheck?: (schemaName: string) => string;
}

export const WORKSPACE_SCHEMA_MODULES: readonly WorkspaceSchemaModule[] = [
  { id: 'v1.001-template', version: 1, introducedBy: 'WorkspaceSchemaRegistry1786674900000 (template; regenerated through WorkspaceSchemaCrewflowAppUsageGrant1786688000000)', sql: (s) => WORKSPACE_SCHEMA_V1_TEMPLATE.split('__WS__').join(s) },
  { id: 'v1.002-shift-team-policy', version: 2, introducedBy: 'ShiftTeamReadScope1786718100000', sql: shiftTeamPolicy },
  { id: 'v1.003-venue-manager-staff-assignment', version: 3, introducedBy: 'VenueManagerStaffAssignment1786718200000', sql: venueManagerStaffAssignmentSql },
  { id: 'v1.004-shift-review-signoff', version: 4, introducedBy: 'ShiftReviewSignoff1786718300000', sql: shiftReviewSignoffSql },
  { id: 'v1.005-shift-review-worker-scan', version: 5, introducedBy: 'ShiftReviewWorkerScan1786718400000', sql: shiftReviewWorkerScanSql },
  { id: 'v1.006-attendance-review', version: 6, introducedBy: 'AttendanceReview1786718500000', sql: attendanceReviewSql },
  { id: 'v1.007-venue-photo', version: 7, introducedBy: 'VenuePhoto1786718700000', sql: venuePhotoSql },
  { id: 'v1.008-payroll-record', version: 8, introducedBy: 'PayrollRecord1786718800000', sql: payrollRecordSql },
  { id: 'v1.009-pay-statement', version: 9, introducedBy: 'PayStatement1786719000000', sql: payStatementSql },
  { id: 'v1.010-approved-shift-statement', version: 10, introducedBy: 'ApprovedShiftStatement1786719100000', sql: approvedShiftStatementSql },
  { id: 'v1.011-payroll-runs', version: 11, introducedBy: 'PayrollCalendarRunsPayslips1786719200000', sql: payrollRunsSql },
  { id: 'v1.012-offer-kind', version: 12, introducedBy: 'OfferKind1786719400000', sql: offerKindSql },
  { id: 'v1.013-attendance-check-in', version: 13, introducedBy: 'AttendanceCheckIn1786719450000', sql: attendanceCheckInSql },
  { id: 'v1.014-payroll-evidence-restrict', version: 14, introducedBy: 'PayrollEvidenceRestrict1786719700000', sql: payrollEvidenceRestrictSql },
  {
    id: 'v1.015-attendance-money-checks',
    version: 15,
    introducedBy: 'AttendanceMoneyChecks1786719810000',
    sql: attendanceMoneyChecksSql,
    precheck: attendanceMoneyPrecheckSql,
  },
  { id: 'v1.016-archive-columns', version: 16, introducedBy: 'ArchiveAndSearchSchema1786719920000', sql: archiveColumnsSql },
  { id: 'v1.017-search-vectors', version: 17, introducedBy: 'ArchiveAndSearchSchema1786719920000', sql: searchVectorsSql },
];

/** The newest module version this code knows. A workspace is "current" only at exactly this module_version. */
export const LATEST_WORKSPACE_MODULE_VERSION = WORKSPACE_SCHEMA_MODULES[WORKSPACE_SCHEMA_MODULES.length - 1]!.version;

/** Highest version the hand-looped migrations applied before the ledger existed: what a backfill may baseline. */
export const BASELINE_WORKSPACE_MODULE_VERSION = 14;

/** sha256 (hex) of the module's SQL rendered for the sentinel schema. Stable for frozen modules. */
export function moduleChecksum(module: WorkspaceSchemaModule): string {
  return createHash('sha256').update(module.sql(SERVER_PATH_SENTINEL_SCHEMA), 'utf8').digest('hex');
}

/** Modules 1..throughVersion, in order. Throws on an unknown version (fail closed). */
export function modulesThrough(throughVersion: number): readonly WorkspaceSchemaModule[] {
  if (!Number.isInteger(throughVersion) || throughVersion < 1 || throughVersion > LATEST_WORKSPACE_MODULE_VERSION) {
    throw new Error(`unknown workspace module version ${throughVersion} (this code knows 1..${LATEST_WORKSPACE_MODULE_VERSION})`);
  }
  return WORKSPACE_SCHEMA_MODULES.slice(0, throughVersion);
}

/** The composition of modules 1..throughVersion for the sentinel schema, joined like the frozen server-path compositions. */
export function composeModulesForSentinel(throughVersion: number): string {
  return modulesThrough(throughVersion)
    .map((m) => m.sql(SERVER_PATH_SENTINEL_SCHEMA))
    .join(';\n');
}
