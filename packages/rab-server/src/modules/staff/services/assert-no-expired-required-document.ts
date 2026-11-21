import {
  STAFF_DOCUMENT_TYPE_LABELS,
  StaffDocumentOfferBlock,
  StaffDocumentTypeType,
} from '@rab/shared';
import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  effectiveRequiredTypes,
  HELD_STATUSES,
  londonDate,
} from './staff-document-rules';

/**
 * Lane D offer block: a staff member whose REQUIRED document has expired cannot receive a NEW offer. Called once, from the
 * canonical eligibility check (assertStaffEligibleForOffer), which every offer-creation path funnels through — single send,
 * bulk send, create-and-send, Venue Manager request approval and the replacement workflow — so the bulk path cannot bypass
 * it. Existing offers and confirmed shifts are NOT revoked (brief).
 *
 * Rule (every part an ASSUMPTION flagged for the owner):
 *   - required types = the organisation's configuration, default DEFAULT_REQUIRED_STAFF_DOCUMENT_TYPES (Right to Work);
 *   - a type is satisfied when the staff member holds (pending or verified) at least one document of it with no expiry
 *     date or an expiry date on or after the check date; it BLOCKS only when every held document of it has expired;
 *   - a type with no held document does NOT block (missing evidence is a separate owner decision; existing staff have no
 *     uploaded documents yet);
 *   - the check date is the London date of the assignment start, or today if that is earlier, so an offer for a shift
 *     after the document expires is refused too.
 * Runs on the caller's tenant-bound EntityManager: RLS on core.staff_document applies (the sending manager, a non-venue
 * manager of the workspace, or the Worker marker, can read the rows).
 */
export async function assertNoExpiredRequiredDocument(
  manager: EntityManager,
  staff: {
    userId: string;
    organisationId: string;
    workspaceId?: string | null;
  },
  assignmentStartsAt: Date,
): Promise<void> {
  const required = (await effectiveRequiredTypes(manager, staff.organisationId))
    .filter((r) => r.required)
    .map((r) => r.documentType);
  if (required.length === 0 || !staff.workspaceId) return;
  const today = londonDate(new Date());
  const shiftDay = londonDate(assignmentStartsAt);
  const onDate = shiftDay > today ? shiftDay : today;
  const rows: Array<{
    document_type: StaffDocumentTypeType;
    valid: boolean;
    latest: string | null;
  }> = await manager.query(
    `SELECT document_type,
            bool_or(expires_on IS NULL OR expires_on >= $4::date) AS valid,
            to_char(max(expires_on), 'YYYY-MM-DD') AS latest
       FROM core.staff_document
      WHERE organisation_id = $1 AND workspace_id = $2 AND staff_user_id = $3
        AND status = ANY ($5::text[]) AND document_type = ANY ($6::text[])
      GROUP BY document_type`,
    [
      staff.organisationId,
      staff.workspaceId,
      staff.userId,
      onDate,
      [...HELD_STATUSES],
      required,
    ],
  );
  const expired = rows
    .filter((r) => !r.valid)
    .sort((a, b) => a.document_type.localeCompare(b.document_type));
  if (expired.length === 0) return;
  const detail = expired
    .map(
      (r) =>
        `${STAFF_DOCUMENT_TYPE_LABELS[r.document_type] ?? r.document_type} (expired ${r.latest})`,
    )
    .join(', ');
  throw new ConflictException({
    statusCode: 409,
    code: StaffDocumentOfferBlock.REQUIRED_DOCUMENT_EXPIRED,
    // The bulk-send result carries only the message, so the code is in the text too.
    message: `Required document expired (${StaffDocumentOfferBlock.REQUIRED_DOCUMENT_EXPIRED}): ${detail}. Upload a current document before sending an offer.`,
    documentTypes: expired.map((r) => r.document_type),
  });
}
