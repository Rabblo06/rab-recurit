import { PermissionFlag } from '@rab/shared';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { assignmentTimeSql } from '../../scheduling/utils/assignment-time';
import { StaffProfile } from '../../staff/entities/staff-profile.entity';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { ListStaffReviewsDto, StaffReviewRange } from '../dto/list-staff-reviews.dto';
import {
  aggregateStaffReviews,
  REVIEW_CATEGORIES,
  ReviewCategory,
  ReviewerOption,
  reviewerOptions,
  reviewScore,
  StaffReviewAggregate,
  StaffReviewRow,
} from './staff-review-insights';

export interface StaffReviewSummary extends StaffReviewAggregate {
  staff: { id: string; name: string; roleName: string | null };
  filters: { reviewer: string | null; range: StaffReviewRange; from: string | null; to: string | null };
  reviewers: ReviewerOption[];
}

export interface StaffReviewDetail {
  id: string;
  staff: { id: string; name: string };
  shiftId: string;
  venueName: string;
  roleName: string;
  startsAt: string;
  endsAt: string;
  reviewer: { userId: string; name: string; role: string };
  submittedAt: string;
  updatedAt: string;
  score: number;
  ratings: Record<ReviewCategory, number>;
  feedback: string | null;
}

/**
 * Web "Staff reviews" tab for the Initial Manager who owns the staff member (owner brief 2026-10-18). Read-only.
 * Enforcement, every request:
 *   1. route: `PermissionGuard(STAFF_VIEW)` + `@ManagerApplication()` (mobile app tokens are refused outright);
 *   2. here: the permission is re-checked, and the staff profile must be the caller's own (`created_by`, same rule as
 *      the Notes/Timeline tabs) — anything else is 404;
 *   3. organisation + workspace bound transaction, and the query is pinned to the caller's own shifts
 *      (`shift.created_by`) and this staff member;
 *   4. `shift_staff_review_scope` FORCE RLS (tenant + shift creator / venue-linked Venue Manager).
 * Aggregation supersedes the 2026-10-17 "per shift only" display rule for this owner view alone; staff never see
 * reviews and Venue Managers get no aggregate.
 */
@Injectable()
export class StaffReviewInsightsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
  ) {}

  async summary(ctx: AuthContext, staffProfileId: string, dto: ListStaffReviewsDto = {}): Promise<StaffReviewSummary> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await this.ownedProfile(manager, ctx, staffProfileId);
      const range = dto.range ?? 'all';
      const window = await this.window(manager, ctx, range, dto.from ?? null, dto.to ?? null);
      const rows = await this.rows(manager, ctx, staffProfileId, window, null);
      const [identity] = await manager.query(
        `SELECT u.first_name || ' ' || u.last_name AS name, jr.name AS role_name
           FROM core."user" u LEFT JOIN job_role jr ON jr.id = $2 WHERE u.id = $1`,
        [profile.userId, profile.jobRoleId ?? null],
      );
      const venueManagers: Array<{ userId: string; name: string; venues: string[] }> = await manager.query(
        `SELECT mp.user_id AS "userId", u.first_name || ' ' || u.last_name AS name,
                coalesce(array_agg(DISTINCT v.name) FILTER (WHERE v.name IS NOT NULL), '{}') AS venues
           FROM core.manager_profile mp JOIN core."user" u ON u.id = mp.user_id
           LEFT JOIN manager_venue mv ON mv.manager_profile_id = mp.id
           LEFT JOIN venue v ON v.id = mv.venue_id
          WHERE mp.organisation_id = $1 AND mp.workspace_id = $2 AND mp.type = 'venue' AND u.status = 'active'
          GROUP BY mp.user_id, u.first_name, u.last_name`,
        [ctx.organisationId, ctx.workspaceId],
      );
      return {
        staff: { id: staffProfileId, name: identity?.name ?? 'Staff member', roleName: identity?.role_name ?? null },
        filters: { reviewer: dto.reviewer ?? null, range, from: dto.from ?? null, to: dto.to ?? null },
        reviewers: reviewerOptions(rows, venueManagers),
        ...aggregateStaffReviews(rows, dto.reviewer ?? null),
      };
    });
  }

  async detail(ctx: AuthContext, staffProfileId: string, reviewId: string): Promise<StaffReviewDetail> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await this.ownedProfile(manager, ctx, staffProfileId);
      const [row] = await this.rows(manager, ctx, staffProfileId, { from: null, to: null }, reviewId);
      if (!row) throw new NotFoundException('Review not found.');
      const [people] = await manager.query(
        `SELECT (SELECT first_name || ' ' || last_name FROM core."user" WHERE id = $1) AS staff_name,
                (SELECT type FROM core.manager_profile WHERE user_id = $2 AND organisation_id = $3 LIMIT 1) AS reviewer_type`,
        [profile.userId, row.reviewerUserId, ctx.organisationId],
      );
      return {
        id: row.id,
        staff: { id: staffProfileId, name: people?.staff_name ?? 'Staff member' },
        shiftId: row.shiftId,
        venueName: row.venueName,
        roleName: row.roleName,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        reviewer: { userId: row.reviewerUserId, name: row.reviewerName, role: people?.reviewer_type === 'venue' ? 'Venue manager' : 'Manager' },
        submittedAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        score: Math.round(reviewScore(row) * 10) / 10,
        ratings: Object.fromEntries(REVIEW_CATEGORIES.map((c) => [c, row[c]])) as Record<ReviewCategory, number>,
        feedback: row.feedback,
      };
    });
  }

  private async ownedProfile(manager: EntityManager, ctx: AuthContext, id: string): Promise<StaffProfile> {
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.STAFF_VIEW))) throw new ForbiddenException('Permission required.');
    const profile = await manager.findOne(StaffProfile, { where: { id } });
    if (!profile || profile.organisationId !== ctx.organisationId || profile.createdBy !== ctx.userId) {
      throw new NotFoundException('Staff member not found.');
    }
    return profile;
  }

  /** Shift-date window in the organisation's timezone; `to` is exclusive (custom `to` is an inclusive calendar date). */
  private async window(manager: EntityManager, ctx: AuthContext, range: StaffReviewRange, from: string | null, to: string | null) {
    if (range === 'all') return { from: null, to: null };
    const [w] = await manager.query(
      `WITH tz AS (SELECT coalesce((SELECT timezone FROM core.organisation WHERE id = $1), 'Europe/London') AS tz)
       SELECT date_trunc('month', now() AT TIME ZONE tz.tz) AT TIME ZONE tz.tz AS this_month,
              (date_trunc('month', now() AT TIME ZONE tz.tz) - interval '1 month') AT TIME ZONE tz.tz AS last_month,
              CASE WHEN $2::date IS NULL THEN NULL ELSE $2::date::timestamp AT TIME ZONE tz.tz END AS custom_from,
              CASE WHEN $3::date IS NULL THEN NULL ELSE ($3::date + 1)::timestamp AT TIME ZONE tz.tz END AS custom_to
         FROM tz`,
      [ctx.organisationId, from, to],
    );
    if (range === 'this_month') return { from: w.this_month as Date, to: null };
    if (range === 'last_month') return { from: w.last_month as Date, to: w.this_month as Date };
    return { from: (w.custom_from as Date | null) ?? null, to: (w.custom_to as Date | null) ?? null };
  }

  private async rows(
    manager: EntityManager,
    ctx: AuthContext,
    staffProfileId: string,
    window: { from: Date | null; to: Date | null },
    reviewId: string | null,
  ): Promise<StaffReviewRow[]> {
    const t = assignmentTimeSql();
    const raw = await manager.query(
      `SELECT r.id, r.shift_id AS "shiftId", r.reviewer_user_id AS "reviewerUserId",
              ru.first_name || ' ' || ru.last_name AS "reviewerName", v.name AS "venueName", jr.name AS "roleName",
              ${t.start} AS "startsAt", ${t.end} AS "endsAt",
              r.grooming, r.attitude, r.skills, r.attendance, r.time_keeping AS "timeKeeping", r.feedback,
              r.created_at AS "createdAt", r.updated_at AS "updatedAt"
         FROM shift_staff_review r
         JOIN shift s ON s.id = r.shift_id
         JOIN shift_assignment sa ON sa.shift_id = r.shift_id AND sa.staff_profile_id = r.staff_profile_id
         JOIN venue v ON v.id = s.venue_id
         JOIN job_role jr ON jr.id = s.job_role_id
         JOIN core."user" ru ON ru.id = r.reviewer_user_id
        WHERE r.organisation_id = $1 AND r.staff_profile_id = $2 AND s.created_by = $3
          AND ($4::uuid IS NULL OR r.id = $4)
          AND ($5::timestamptz IS NULL OR ${t.start} >= $5)
          AND ($6::timestamptz IS NULL OR ${t.start} < $6)
        ORDER BY ${t.start} DESC, r.id`,
      [ctx.organisationId, staffProfileId, ctx.userId, reviewId, window.from, window.to],
    );
    return raw.map((r: any) => ({
      ...r,
      startsAt: new Date(r.startsAt),
      endsAt: new Date(r.endsAt),
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt),
    }));
  }
}
