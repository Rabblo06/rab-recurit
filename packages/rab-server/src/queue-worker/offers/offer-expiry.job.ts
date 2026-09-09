import { NotificationType, OfferStatus } from '@rab/shared';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../../engine/core-modules/audit/audit.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { JobOffer } from '../../modules/offer/entities/job-offer.entity';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { runScopedForOrg } from '../shared/scoped-job';

/**
 * Proactive offer expiry — `OfferService.staffAccept()` already expires a
 * stale `PENDING` offer LAZILY, the moment a staff member happens to touch
 * it past `expiresAt` (offer.service.ts:512-531). An offer nobody ever
 * touches again just sits `PENDING` forever with a past `expiresAt` —
 * this job is that same transition, run proactively on a periodic scan
 * instead of waiting for a request that may never come. Deliberately
 * replicates `staffAccept`'s exact side effects (status → EXPIRED, same
 * `AuditAction.OFFER_EXPIRED` action/entity shape, same
 * `assignment.assignedBy` notification with `NotificationType.OFFER_EXPIRED`)
 * rather than inventing a parallel expiry behaviour — one offer-lifecycle
 * definition, exercised from two trigger points.
 *
 * Same owner-scan + `rab_app`-scoped-mutation two-phase shape as the other
 * new operational jobs — see `shift-monitor.job.ts`'s doc comment.
 */
export interface OfferExpiryResult {
  expired: number;
}

interface ScanCandidate {
  offer_id: string;
  organisation_id: string;
  workspace_id: string | null;
}

export async function runOfferExpiryCycle(
  ownerDataSource: DataSource,
  tenantContext: TenantContextService,
  notificationService: NotificationService,
  auditService: AuditService,
): Promise<OfferExpiryResult> {
  const candidates = await ownerDataSource.transaction(async (manager) => {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext('rab_offer_expiry'))`);
    await manager.query(`ALTER TABLE core.job_offer DISABLE ROW LEVEL SECURITY;`);
    try {
      return await manager.query<ScanCandidate[]>(`
        SELECT id AS offer_id, organisation_id, workspace_id
        FROM core.job_offer
        WHERE status = 'pending' AND expires_at < now()
        ORDER BY expires_at ASC
        LIMIT 500
      `);
    } finally {
      await manager.query(`ALTER TABLE core.job_offer ENABLE ROW LEVEL SECURITY;`);
    }
  });

  let expired = 0;
  for (const candidate of candidates) {
    const didExpire = await runScopedForOrg(tenantContext, candidate.organisation_id, candidate.workspace_id, async (manager) => {
      const offer = await manager.findOne(JobOffer, { where: { id: candidate.offer_id } });
      if (!offer || offer.status !== OfferStatus.PENDING || offer.expiresAt.getTime() >= Date.now()) return false;

      await manager.update(JobOffer, offer.id, { status: OfferStatus.EXPIRED });
      await auditService.record(manager, { organisationId: candidate.organisation_id, userId: '' }, AuditAction.OFFER_EXPIRED_BY_WORKER, {
        entityType: 'offer',
        entityId: offer.id,
        metadata: { offerBatchId: offer.offerBatchId },
        actorUserId: null,
      });

      const assignment = await manager.findOne(ShiftAssignment, { where: { id: offer.shiftAssignmentId } });
      if (assignment?.assignedBy) {
        await notificationService.notify(manager, {
          organisationId: candidate.organisation_id,
          userId: assignment.assignedBy,
          type: NotificationType.OFFER_EXPIRED,
          title: 'Offer expired',
          message: 'A shift offer expired before the staff member responded.',
          relatedEntityType: 'offer',
          relatedEntityId: offer.id,
        });
      }
      return true;
    });
    if (didExpire) expired += 1;
  }

  return { expired };
}
