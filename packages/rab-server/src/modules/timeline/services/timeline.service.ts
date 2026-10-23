import { PermissionFlag, PermissionFlagType } from '@rab/shared';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { PayrollService } from '../../payroll/services/payroll.service';
import { SchedulingService } from '../../scheduling/services/scheduling.service';
import { StaffService } from '../../staff/services/staff.service';
import { TIMELINE_METADATA_KEYS, TIMELINE_MONEY_KEYS, TIMELINE_STEPS } from '../constants/timeline-steps';
import { TimelineQueryDto } from '../dto/timeline-query.dto';

export interface TimelineItem {
  id: string;
  action: string;
  /** Presentation key of the lifecycle step (`TIMELINE_STEPS`), or null for other activity. Display only. */
  step: string | null;
  entityType: string | null;
  entityId: string | null;
  actor: { fullName: string } | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TimelinePage {
  items: TimelineItem[];
  /** Pass back as `cursor` for the next (older) page; null when there is none. */
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which audit rows belong to one entity's timeline: (entity_type, entity_id) pairs, plus optional person columns. */
interface TimelineScope {
  entities: Array<{ type: string; ids: string[] }>;
  subjectUserId?: string;
  showMoney: boolean;
}

/** `createdAtUs` is the row's created_at with MICROSECOND precision (as PostgreSQL stores it), so no row is skipped. */
export function encodeCursor(createdAtUs: string, id: string): string {
  return Buffer.from(`${createdAtUs}|${id}`, 'utf8').toString('base64url');
}

/** Strict: an ISO timestamp and a uuid, nothing else (400 otherwise — never silently "first page"). */
export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const invalid = () => new BadRequestException({ code: 'INVALID_TIMELINE_CURSOR', message: 'The timeline cursor is not valid.' });
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw invalid();
  }
  const [iso, id, ...rest] = decoded.split('|');
  if (rest.length || !iso || !id || !UUID.test(id) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(iso)) throw invalid();
  if (Number.isNaN(new Date(iso).getTime())) throw invalid();
  return { createdAt: iso, id };
}

/** Allowlisted, primitive-only metadata; money keys only for a payroll-capable caller. */
export function sanitiseTimelineMetadata(metadata: unknown, showMoney: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return out;
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    const allowed = TIMELINE_METADATA_KEYS.has(key) || (showMoney && TIMELINE_MONEY_KEYS.has(key));
    if (!allowed) continue;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, 500);
    else if (Array.isArray(value) && value.length <= 20 && value.every((v) => ['string', 'number', 'boolean'].includes(typeof v))) out[key] = value;
  }
  return out;
}

/**
 * Wave 5 — read-only, per-entity activity timelines derived from the immutable `core.audit_log` (no new write path, no
 * merging, no mutable timeline table). Five layers:
 *   1. route PermissionGuard (per entity type);
 *   2. this service re-checks the same flag AND the record's visibility through the OWNING service's own read rule
 *      (`SchedulingService.get`, `StaffService.get`, the attendance list scope, `PayrollService.canAccessPayroll`) —
 *      404 for anything outside the caller's tenant / workspace / venue / ownership scope;
 *   3. the audit query is pinned to `organisation_id = ctx.organisationId` and to entity ids resolved from rows the
 *      caller can read (workspace search_path + RLS);
 *   4. `audit_log` RLS (organisation) underneath;
 *   5. related rows are resolved under the caller's own workspace RLS (attendance / payroll_record staff-own / venue
 *      predicates).
 * Pay never leaks through it: payroll_record events are included and money metadata is shown only when the caller may
 * access payroll (`payroll.view`, never venue-scoped). Metadata is allowlisted. Keyset pagination on (created_at, id).
 */
@Injectable()
export class TimelineService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly resourceScope: ResourceScopeService,
    private readonly scheduling: SchedulingService,
    private readonly staff: StaffService,
    private readonly payroll: PayrollService,
  ) {}

  private async assertFlag(m: EntityManager, ctx: AuthContext, flag: PermissionFlagType): Promise<void> {
    if (!(await this.permissions.userHasPermissionTx(m, ctx, flag))) throw new ForbiddenException('Permission required.');
  }

  private async isDelegated(m: EntityManager, ctx: AuthContext): Promise<boolean> {
    const scope = await this.resourceScope.resolveTx(m, ctx);
    return scope.kind === 'owner' && scope.delegated;
  }

  private async ids(m: EntityManager, sql: string, params: unknown[]): Promise<string[]> {
    const rows = await m.query<Array<{ id: string }>>(sql, params);
    return rows.map((r) => r.id);
  }

  /** Shift: the shift itself + its seats, offers, attendance, report, replacement requests, reviews (+ payroll records). */
  async forShift(ctx: AuthContext, shiftId: string, query: TimelineQueryDto): Promise<TimelinePage> {
    if (!UUID.test(shiftId)) throw new NotFoundException('Shift not found.');
    await this.scheduling.get(ctx, shiftId); // the shift's own read rule; 404 out of scope
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.SCHEDULE_VIEW);
      // A custom workspace-member may read the shift, but never offers / attendance / payroll — only the shift's own rows.
      if (await this.isDelegated(m, ctx)) return this.page(m, ctx, { entities: [{ type: 'shift', ids: [shiftId] }], showMoney: false }, query);
      const showMoney = await this.payroll.canAccessPayroll(m, ctx, PermissionFlag.PAYROLL_VIEW);
      const p = [shiftId];
      const entities: TimelineScope['entities'] = [
        { type: 'shift', ids: [shiftId] },
        { type: 'shift_assignment', ids: await this.ids(m, `SELECT id FROM shift_assignment WHERE shift_id = $1`, p) },
        { type: 'offer', ids: await this.ids(m, `SELECT o.id FROM job_offer o JOIN shift_assignment sa ON sa.id = o.shift_assignment_id WHERE sa.shift_id = $1`, p) },
        { type: 'attendance', ids: await this.ids(m, `SELECT id FROM attendance WHERE shift_id = $1`, p) },
        { type: 'shift_report', ids: await this.ids(m, `SELECT id FROM shift_report WHERE shift_id = $1`, p) },
        { type: 'replacement_request', ids: await this.ids(m, `SELECT id FROM replacement_request WHERE shift_id = $1`, p) },
        { type: 'shift_staff_review', ids: await this.ids(m, `SELECT id FROM shift_staff_review WHERE shift_id = $1`, p) },
      ];
      if (showMoney) entities.push({ type: 'payroll_record', ids: await this.ids(m, `SELECT id FROM payroll_record WHERE shift_id = $1`, p) });
      return this.page(m, ctx, { entities, showMoney }, query);
    });
  }

  /** Offer: the offer, its seat, and the attendance / payroll record that came from that seat. */
  async forOffer(ctx: AuthContext, offerId: string, query: TimelineQueryDto): Promise<TimelinePage> {
    if (!UUID.test(offerId)) throw new NotFoundException('Offer not found.');
    const shiftId = await this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      if (await this.isDelegated(m, ctx)) throw new NotFoundException('Offer not found.'); // offers are not a member object
      const [row] = await m.query<Array<{ shift_id: string }>>(
        `SELECT sa.shift_id FROM job_offer o JOIN shift_assignment sa ON sa.id = o.shift_assignment_id WHERE o.id = $1 AND o.organisation_id = $2`,
        [offerId, ctx.organisationId],
      );
      if (!row) throw new NotFoundException('Offer not found.');
      return row.shift_id;
    });
    try {
      await this.scheduling.get(ctx, shiftId); // visible offer ⇔ visible shift
    } catch (error) {
      if (error instanceof NotFoundException) throw new NotFoundException('Offer not found.');
      throw error;
    }
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.SCHEDULE_VIEW);
      const showMoney = await this.payroll.canAccessPayroll(m, ctx, PermissionFlag.PAYROLL_VIEW);
      const seat = await this.ids(m, `SELECT shift_assignment_id AS id FROM job_offer WHERE id = $1`, [offerId]);
      const entities: TimelineScope['entities'] = [
        { type: 'offer', ids: [offerId] },
        { type: 'shift_assignment', ids: seat },
        { type: 'attendance', ids: await this.ids(m, `SELECT id FROM attendance WHERE shift_assignment_id = ANY($1::uuid[])`, [seat]) },
      ];
      if (showMoney) {
        entities.push({
          type: 'payroll_record',
          ids: await this.ids(m, `SELECT pr.id FROM payroll_record pr JOIN attendance a ON a.id = pr.attendance_id WHERE a.shift_assignment_id = ANY($1::uuid[])`, [seat]),
        });
      }
      return this.page(m, ctx, { entities, showMoney }, query);
    });
  }

  /**
   * Staff member: the person's own activity and activity about them (actor / target), their profile's archive events,
   * and their bookings (offers, seats, attendance, payroll records). Visibility = `StaffService.get` (strict owner, or a
   * custom member within their role — who then sees only the profile's own rows).
   */
  async forStaff(ctx: AuthContext, staffProfileId: string, query: TimelineQueryDto): Promise<TimelinePage> {
    if (!UUID.test(staffProfileId)) throw new NotFoundException('Staff member not found.');
    await this.staff.get(ctx, staffProfileId);
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.STAFF_VIEW);
      const [profile] = await m.query<Array<{ user_id: string }>>(`SELECT user_id FROM staff_profile WHERE id = $1`, [staffProfileId]);
      if (!profile) throw new NotFoundException('Staff member not found.');
      if (await this.isDelegated(m, ctx)) {
        return this.page(m, ctx, { entities: [{ type: 'staff_profile', ids: [staffProfileId] }], showMoney: false }, query);
      }
      const showMoney = await this.payroll.canAccessPayroll(m, ctx, PermissionFlag.PAYROLL_VIEW);
      const p = [staffProfileId];
      const entities: TimelineScope['entities'] = [
        { type: 'staff_profile', ids: [staffProfileId] },
        { type: 'offer', ids: await this.ids(m, `SELECT id FROM job_offer WHERE staff_profile_id = $1`, p) },
        { type: 'shift_assignment', ids: await this.ids(m, `SELECT id FROM shift_assignment WHERE staff_profile_id = $1`, p) },
        { type: 'attendance', ids: await this.ids(m, `SELECT id FROM attendance WHERE staff_profile_id = $1`, p) },
      ];
      if (showMoney) entities.push({ type: 'payroll_record', ids: await this.ids(m, `SELECT id FROM payroll_record WHERE staff_profile_id = $1`, p) });
      return this.page(m, ctx, { entities, subjectUserId: profile.user_id, showMoney }, query);
    });
  }

  /** Attendance: same scope rule as the manager attendance list (Venue Manager: assigned venues; Manager: own staff). */
  async forAttendance(ctx: AuthContext, attendanceId: string, query: TimelineQueryDto): Promise<TimelinePage> {
    if (!UUID.test(attendanceId)) throw new NotFoundException('Attendance not found.');
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.ATTENDANCE_VIEW);
      const scope = await this.resourceScope.resolveTx(m, ctx);
      if (scope.kind === 'owner' && scope.delegated) throw new NotFoundException('Attendance not found.');
      const [row] = await m.query<Array<{ shift_assignment_id: string; venue_id: string; created_by: string | null }>>(
        `SELECT a.shift_assignment_id, s.venue_id, sp.created_by
           FROM attendance a JOIN shift s ON s.id = a.shift_id JOIN staff_profile sp ON sp.id = a.staff_profile_id
          WHERE a.id = $1 AND a.organisation_id = $2`,
        [attendanceId, ctx.organisationId],
      );
      const visible = !!row && (scope.kind === 'venue' ? scope.venueIds.includes(row.venue_id) : row.created_by === ctx.userId);
      if (!visible) throw new NotFoundException('Attendance not found.');
      const showMoney = await this.payroll.canAccessPayroll(m, ctx, PermissionFlag.PAYROLL_VIEW);
      const entities: TimelineScope['entities'] = [
        { type: 'attendance', ids: [attendanceId] },
        { type: 'shift_assignment', ids: [row!.shift_assignment_id] },
      ];
      if (showMoney) entities.push({ type: 'payroll_record', ids: await this.ids(m, `SELECT id FROM payroll_record WHERE attendance_id = $1`, [attendanceId]) });
      return this.page(m, ctx, { entities, showMoney }, query);
    });
  }

  /** Payroll record: payroll access (payroll.view, never venue-scoped) + the record in the caller's own workspace. */
  async forPayrollRecord(ctx: AuthContext, recordId: string, query: TimelineQueryDto): Promise<TimelinePage> {
    if (!UUID.test(recordId)) throw new NotFoundException('Payroll record not found.');
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.payroll.assertPayrollAccess(m, ctx, PermissionFlag.PAYROLL_VIEW);
      const [row] = await m.query<Array<{ attendance_id: string }>>(
        `SELECT attendance_id FROM payroll_record WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3`,
        [recordId, ctx.organisationId, ctx.workspaceId],
      );
      if (!row) throw new NotFoundException('Payroll record not found.');
      const entities: TimelineScope['entities'] = [
        { type: 'payroll_record', ids: [recordId] },
        { type: 'attendance', ids: [row.attendance_id] },
      ];
      return this.page(m, ctx, { entities, showMoney: true }, query);
    });
  }

  private async page(m: EntityManager, ctx: AuthContext, scope: TimelineScope, query: TimelineQueryDto): Promise<TimelinePage> {
    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const params: unknown[] = [ctx.organisationId];
    const ors: string[] = [];
    for (const e of scope.entities) {
      if (e.ids.length === 0) continue;
      params.push(e.type, e.ids);
      ors.push(`(al.entity_type = $${params.length - 1} AND al.entity_id = ANY($${params.length}::uuid[]))`);
    }
    if (scope.subjectUserId) {
      params.push(scope.subjectUserId);
      ors.push(`al.target_user_id = $${params.length}`, `al.actor_user_id = $${params.length}`);
    }
    if (ors.length === 0) return { items: [], nextCursor: null };
    // Pay-domain events never reach a caller without payroll access, whichever branch matched them.
    const moneySql = scope.showMoney
      ? ''
      : ` AND (al.entity_type IS NULL OR al.entity_type <> ALL(ARRAY['payroll_record','payroll_run','payslip','payroll_calendar','payroll_calendar_period']))`;
    let cursorSql = '';
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorSql = ` AND (al.created_at, al.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(limit + 1);
    const rows = await m.query<Array<Record<string, unknown>>>(
      `SELECT al.id, al.action, al.metadata, al.entity_type, al.entity_id, al.created_at,
              to_char(al.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_us,
              u.first_name AS actor_first_name, u.last_name AS actor_last_name
         FROM core.audit_log al
         LEFT JOIN core."user" u ON u.id = al.actor_user_id
        WHERE al.organisation_id = $1 AND (${ors.join(' OR ')})${moneySql}${cursorSql}
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT $${params.length}`,
      params,
    );
    const pageRows = rows.slice(0, limit);
    const items: TimelineItem[] = pageRows.map((r) => {
      const action = r.action as string;
      // A payroll_record row is only ever in scope for a payroll-capable caller (see entities above).
      return {
        id: r.id as string,
        action,
        step: TIMELINE_STEPS[action] ?? null,
        entityType: (r.entity_type as string) ?? null,
        entityId: (r.entity_id as string) ?? null,
        actor: r.actor_first_name ? { fullName: `${r.actor_first_name} ${r.actor_last_name}` } : null,
        metadata: sanitiseTimelineMetadata(r.metadata, scope.showMoney),
        createdAt: new Date(r.created_at as string).toISOString(),
      };
    });
    const last = pageRows[pageRows.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.created_at_us as string, last.id as string) : null };
  }
}
