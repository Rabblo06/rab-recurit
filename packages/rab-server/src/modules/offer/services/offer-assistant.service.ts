import { OfferStatus, OfferStatusType, PermissionFlag } from '@rab/shared';
import { ForbiddenException, Injectable } from '@nestjs/common';

import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { beginAssistantRead } from '../../../engine/utils/assistant-read.util';
import { assignmentTimeSql } from '../../scheduling/utils/assignment-time';
import { offerReadScopeCondition } from './offer.service';

export interface AssistantOfferPipeline {
  byStatus: Record<OfferStatusType, number>;
  total: number;
  awaitingStaffResponse: number;
  awaitingManagerConfirmation: number;
  /** Pending offers whose `expires_at` falls within the next 24 hours (server time). */
  expiringWithin24h: number;
  /** Pending offers sent more than 24 hours ago. */
  pendingOver24h: number;
  /** Median of (responded_at − sent_at) in whole minutes over the offers that have a response; null when none. */
  medianResponseMinutes: number | null;
}

/**
 * AI Phase 3 `get_offer_pipeline` read model (docs/ai/PHASE3_TWENTY_PLAN.md §4). READ-ONLY, COUNTS ONLY: offers on
 * assignments STARTING in [from, to), in the caller's offer read scope (`offerReadScopeCondition`, the ONE manager-facing
 * offer scope `list()` uses — never a copy). No staff, shift or offer identity, no decline / rejection reason and no
 * estimated pay is ever selected. Layer 2: `schedule.view` re-checked here (403), as on `GET /offers`. Own READ ONLY
 * tenant transaction (crewflow_app, RLS bound), 5 s per statement.
 */
@Injectable()
export class OfferAssistantService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly resourceScope: ResourceScopeService,
  ) {}

  async assistantOfferPipeline(ctx: AuthContext, range: { from: Date; to: Date }): Promise<AssistantOfferPipeline> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await beginAssistantRead(manager);
      if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.SCHEDULE_VIEW))) throw new ForbiddenException('Permission required.');
      const byStatus = Object.fromEntries(Object.values(OfferStatus).map((status) => [status, 0])) as Record<OfferStatusType, number>;
      const out: AssistantOfferPipeline = { byStatus, total: 0, awaitingStaffResponse: 0, awaitingManagerConfirmation: 0, expiringWithin24h: 0, pendingOver24h: 0, medianResponseMinutes: null };
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'venue' && scope.venueIds.length === 0) return out;
      const params: unknown[] = [];
      const nextParam = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };
      const start = assignmentTimeSql().start;
      const where = [offerReadScopeCondition(scope, ctx, nextParam), `${start} >= ${nextParam(range.from)}`, `${start} < ${nextParam(range.to)}`].join(' AND ');
      const rows: Array<{ status: string; n: number; expiring: number; stale: number }> = await manager.query(
        `SELECT o.status, count(*)::int AS n,
                count(*) FILTER (WHERE o.status = 'pending' AND o.expires_at >= now() AND o.expires_at < now() + interval '24 hours')::int AS expiring,
                count(*) FILTER (WHERE o.status = 'pending' AND o.sent_at < now() - interval '24 hours')::int AS stale
           FROM job_offer o
           JOIN shift_assignment sa ON sa.id = o.shift_assignment_id
           JOIN shift s ON s.id = sa.shift_id
          WHERE ${where}
          GROUP BY o.status`,
        params,
      );
      for (const r of rows) {
        if (!(r.status in byStatus)) continue;
        byStatus[r.status as OfferStatusType] = Number(r.n);
        out.total += Number(r.n);
        out.expiringWithin24h += Number(r.expiring);
        out.pendingOver24h += Number(r.stale);
      }
      const [median] = await manager.query(
        `SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (o.responded_at - o.sent_at)) / 60))::int AS minutes
           FROM job_offer o
           JOIN shift_assignment sa ON sa.id = o.shift_assignment_id
           JOIN shift s ON s.id = sa.shift_id
          WHERE ${where} AND o.responded_at IS NOT NULL AND o.responded_at >= o.sent_at`,
        params,
      );
      out.awaitingStaffResponse = byStatus[OfferStatus.PENDING];
      out.awaitingManagerConfirmation = byStatus[OfferStatus.STAFF_ACCEPTED];
      out.medianResponseMinutes = median?.minutes === null || median?.minutes === undefined ? null : Number(median.minutes);
      return out;
    });
  }
}
