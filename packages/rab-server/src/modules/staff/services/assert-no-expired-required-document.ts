import {
  STAFF_DOCUMENT_TYPE_LABELS,
  StaffDocumentOfferBlock,
  StaffDocumentTypeType,
} from '@rab/shared';
import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { effectiveRequiredTypes, londonDate } from './staff-document-rules';

/**
 * Lane D offer block: a staff member whose REQUIRED document has expired cannot receive a NEW offer. Called once, from the
 * canonical eligibility check (assertStaffEligibleForOffer), which every offer-creation path funnels through — single send,
 * bulk send, create-and-send, Venue Manager request approval and the replacement workflow — so the bulk path cannot bypass
 * it. Existing offers and confirmed shifts are NOT revoked (brief).
 *
 * Independent security review (2026-11-24):
 *   H1 — the documents are read through core.staff_document_offer_block(), a SECURITY DEFINER pinned to the bound
 *        organisation + workspace, NOT through the caller's RLS. A caller whose own policies show no document rows (a CEO,
 *        a custom-role Venue Manager whose manager_profile is bound elsewhere) used to see "nothing expired" and the offer
 *        went out: the check failed open. It now answers the same for every caller; no tenant bound = an error.
 *   H2 — once a required document has expired, only a VERIFIED valid replacement lifts the block; a pending upload (which a
 *        staff member can make themselves, with any expiry date) never does. Owner decision 83, as updated by the review.
 * Other rules (owner decisions): required types = the organisation's configuration, default Right to Work (decision 32); a
 * type never held at all does not block; the check date is the London date of the assignment start, or today if earlier.
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
  if (required.length === 0) return;
  const today = londonDate(new Date());
  const shiftDay = londonDate(assignmentStartsAt);
  const onDate = shiftDay > today ? shiftDay : today;
  const blocked: Array<{
    document_type: StaffDocumentTypeType;
    expired_on: string;
  }> = await manager.query(
    `SELECT document_type, to_char(expired_on, 'YYYY-MM-DD') AS expired_on FROM core.staff_document_offer_block($1, $2::text[], $3::date)`,
    [staff.userId, required, onDate],
  );
  if (blocked.length === 0) return;
  const detail = blocked
    .map(
      (r) =>
        `${STAFF_DOCUMENT_TYPE_LABELS[r.document_type] ?? r.document_type} (expired ${r.expired_on})`,
    )
    .join(', ');
  throw new ConflictException({
    statusCode: 409,
    code: StaffDocumentOfferBlock.REQUIRED_DOCUMENT_EXPIRED,
    // The bulk-send result carries only the message, so the code is in the text too.
    message: `Required document expired (${StaffDocumentOfferBlock.REQUIRED_DOCUMENT_EXPIRED}): ${detail}. A current document must be uploaded and verified before an offer can be sent.`,
    documentTypes: blocked.map((r) => r.document_type),
  });
}
