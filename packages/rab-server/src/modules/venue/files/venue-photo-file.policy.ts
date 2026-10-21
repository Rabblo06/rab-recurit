import { OfferStatus, ShiftAssignmentStatus, ShiftStatus } from '@rab/shared';
import { EntityManager } from 'typeorm';

import { FileKindPolicy } from '../../../engine/core-modules/storage/file-access.registry';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { Venue } from '../entities/venue.entity';
import { VenueService } from '../services/venue.service';

/**
 * LIVE work only (owner decision 2026-10-20). Declined, expired, rejected, withdrawn, cancelled, no-show and completed
 * work grants nothing.
 *  - Offer: `pending` (and only while `expires_at` is in the future: a lapsed pending offer is expired even before the
 *    expiry job flips its status), `staff_accepted`, `manager_confirmed`.
 *  - Its assignment must also be live: `offered`, `staff_accepted`, `confirmed`.
 *  - A direct assignment without a live offer counts only when `staff_accepted` or `confirmed` (an `offered` seat is
 *    live only through its unexpired offer above).
 *  - The shift must not be `cancelled` or `declined`.
 */
const LIVE_OFFER_STATUSES = [OfferStatus.STAFF_ACCEPTED, OfferStatus.MANAGER_CONFIRMED];
const LIVE_OFFER_ASSIGNMENT_STATUSES = [ShiftAssignmentStatus.OFFERED, ShiftAssignmentStatus.STAFF_ACCEPTED, ShiftAssignmentStatus.CONFIRMED];
const LIVE_ASSIGNMENT_STATUSES = [ShiftAssignmentStatus.STAFF_ACCEPTED, ShiftAssignmentStatus.CONFIRMED];
const DEAD_SHIFT_STATUSES = [ShiftStatus.CANCELLED, ShiftStatus.DECLINED];

/**
 * Who may read a VENUE_PHOTO file (`GET /rest/v1/files/:id`).
 *
 * Layer 4 (RLS, before this runs): `stored_file_tenant` admits the row only when its organisation AND workspace equal
 * the caller's bound context (a venue photo is always stored with the venue's non-NULL workspace_id). RLS on venue,
 * shift, job_offer and shift_assignment is workspace-wide, so the finer per-caller cut is this policy's job:
 *
 *  - The file must be the venue's CURRENT photo (`venue.photo_file_id = file.id`): a replaced or removed photo is
 *    tombstoned anyway, this also refuses any VENUE_PHOTO row not attached to the venue it names.
 *  - Staff app caller: only when the caller's OWN staff profile (resolved from ctx.userId, never a request value) has
 *    LIVE work at that venue (see the constants above). A Staff member who was never offered work there, or whose
 *    offer was declined/expired/withdrawn/rejected or whose seat was cancelled/completed, gets the same 404 as a
 *    missing file.
 *  - Any other (manager-application) caller: exactly the visibility `GET /venues/:id` applies
 *    (`VenueService.canViewVenueTx`: VENUE_VIEW + creator / assigned Venue Manager / delegated member rules).
 *
 * Every `false` is answered by FilesController as 404 (and audited as FILE_ACCESS_DENIED), never 403.
 */
export class VenuePhotoFilePolicy implements FileKindPolicy {
  constructor(private readonly venues: VenueService) {}

  async canRead(manager: EntityManager, ctx: AuthContext, file: StoredFile): Promise<boolean> {
    if (file.resourceType !== 'venue' || !ctx.organisationId) return false;
    const venue = await manager.findOne(Venue, { where: { id: file.resourceId, organisationId: ctx.organisationId } });
    if (!venue || venue.photoFileId !== file.id) return false;
    if (ctx.applicationTarget === 'staff_app') return this.staffHasLiveWorkAtVenue(manager, ctx, venue.id);
    return this.venues.canViewVenueTx(manager, ctx, venue);
  }

  private async staffHasLiveWorkAtVenue(manager: EntityManager, ctx: AuthContext, venueId: string): Promise<boolean> {
    const rows: unknown[] = await manager.query(
      `SELECT 1
         FROM staff_profile sp
        WHERE sp.user_id = $1 AND sp.organisation_id = $2
          AND (
            EXISTS (
              SELECT 1 FROM job_offer o
                JOIN shift_assignment sa ON sa.id = o.shift_assignment_id
                JOIN shift s ON s.id = sa.shift_id
               WHERE o.staff_profile_id = sp.id AND o.organisation_id = $2
                 AND s.venue_id = $3 AND s.status <> ALL($4::text[])
                 AND sa.status = ANY($5::text[])
                 AND ((o.status = $6 AND o.expires_at > now()) OR o.status = ANY($7::text[])))
            OR EXISTS (
              SELECT 1 FROM shift_assignment sa
                JOIN shift s ON s.id = sa.shift_id
               WHERE sa.staff_profile_id = sp.id AND sa.organisation_id = $2
                 AND s.venue_id = $3 AND s.status <> ALL($4::text[])
                 AND sa.status = ANY($8::text[]))
          )
        LIMIT 1`,
      [
        ctx.userId,
        ctx.organisationId,
        venueId,
        DEAD_SHIFT_STATUSES,
        LIVE_OFFER_ASSIGNMENT_STATUSES,
        OfferStatus.PENDING,
        LIVE_OFFER_STATUSES,
        LIVE_ASSIGNMENT_STATUSES,
      ],
    );
    return rows.length > 0;
  }
}
