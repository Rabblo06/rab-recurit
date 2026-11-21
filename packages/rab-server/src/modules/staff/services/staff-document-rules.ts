import {
  calendarDaysBetween,
  DEFAULT_REQUIRED_STAFF_DOCUMENT_TYPES,
  londonCalendarDate,
  REQUIRABLE_STAFF_DOCUMENT_TYPES,
  StaffDocumentScanStatus,
  StaffDocumentStatus,
  StaffDocumentTypeType,
} from '@rab/shared';
import { EntityManager } from 'typeorm';

/**
 * Pure / query helpers shared by StaffDocumentService, the offer block (assert-no-expired-required-document.ts) and the
 * Worker's expiry alerts. Every query runs on the CALLER's tenant-bound EntityManager, so FORCE RLS on core.staff_document /
 * core.staff_document_requirement still applies underneath the explicit predicates.
 */

/** Today's date in Europe/London as YYYY-MM-DD (expiry dates are calendar dates, not instants). */
export const londonDate = londonCalendarDate;

/** Whole days from `from` to `to` (YYYY-MM-DD). */
export const daysBetween = calendarDaysBetween;

/** ASSUMPTION (flagged): a document is valid up to AND including its expiry date; expired from the day after. */
export function isExpiredOn(expiresOn: string | null, onDate: string): boolean {
  return expiresOn !== null && expiresOn < onDate;
}

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * The organisation's REQUIRED types: DEFAULT_REQUIRED_STAFF_DOCUMENT_TYPES (OWNER DECISION; recommended Right to Work) with
 * the organisation's own rows in core.staff_document_requirement applied on top. Unknown types in old rows are ignored.
 */
export async function effectiveRequiredTypes(
  manager: EntityManager,
  organisationId: string,
): Promise<
  Array<{
    documentType: StaffDocumentTypeType;
    required: boolean;
    source: 'default' | 'organisation';
  }>
> {
  const rows: Array<{ document_type: string; required: boolean }> =
    await manager.query(
      `SELECT document_type, required FROM core.staff_document_requirement WHERE organisation_id = $1`,
      [organisationId],
    );
  const overrides = new Map(rows.map((r) => [r.document_type, r.required]));
  return REQUIRABLE_STAFF_DOCUMENT_TYPES.map((documentType) =>
    overrides.has(documentType)
      ? {
          documentType,
          required: overrides.get(documentType)!,
          source: 'organisation' as const,
        }
      : {
          documentType,
          required:
            DEFAULT_REQUIRED_STAFF_DOCUMENT_TYPES.includes(documentType),
          source: 'default' as const,
        },
  );
}

/** Statuses that count as "holding" a document (pending review counts; rejected / revoked do not). ASSUMPTION (flagged). */
export const HELD_STATUSES: readonly string[] = [
  StaffDocumentStatus.PENDING,
  StaffDocumentStatus.VERIFIED,
];

/** A file is shown (download / verification) only once a real scanner said clean and the document is not revoked. */
export function isFileVisible(status: string, scanStatus: string): boolean {
  return (
    scanStatus === StaffDocumentScanStatus.CLEAN &&
    status !== StaffDocumentStatus.REVOKED
  );
}
