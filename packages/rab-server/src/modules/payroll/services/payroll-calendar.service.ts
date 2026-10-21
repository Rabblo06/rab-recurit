import { PermissionFlag } from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { ImportCalendarDto } from '../dto/payroll-runs.dto';
import { PAYROLL_TIMEZONE } from './payroll-allocation';

export interface CalendarValidationReport {
  periodCount: number;
  /** Fatal: a period ends before it starts, payday before period end, or a start date repeated. */
  errors: string[];
  /** Fatal: two periods of the import share at least one day. */
  overlaps: Array<{ first: string; second: string }>;
  /** Informational: days not covered between consecutive periods. */
  gaps: Array<{ after: string; before: string; days: number }>;
  /** Informational: periods that are not 14 days long (e.g. the published February 2026 periods). */
  nonStandardLengths: Array<{ start: string; end: string; days: number }>;
}

export interface CalendarPeriodView { id: string; start: string; end: string; payday: string; note: string | null; needsConfirmation: boolean; days: number }
export interface CalendarView {
  id: string; year: number; version: number; source: string; timezone: string; status: 'active' | 'inactive'; notes: string | null; createdAt: string;
  periods: CalendarPeriodView[];
}

const DAY_MS = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export function validateCalendarPeriods(periods: ReadonlyArray<{ start: string; end: string; payday: string }>): CalendarValidationReport {
  const sorted = [...periods].sort((a, b) => a.start.localeCompare(b.start));
  const report: CalendarValidationReport = { periodCount: sorted.length, errors: [], overlaps: [], gaps: [], nonStandardLengths: [] };
  const seen = new Set<string>();
  for (const p of sorted) {
    if (Number.isNaN(Date.parse(`${p.start}T00:00:00Z`)) || Number.isNaN(Date.parse(`${p.end}T00:00:00Z`)) || Number.isNaN(Date.parse(`${p.payday}T00:00:00Z`))) {
      report.errors.push(`Invalid date in period starting ${p.start}.`); continue;
    }
    if (p.end < p.start) report.errors.push(`Period ${p.start} ends before it starts (${p.end}).`);
    if (p.payday < p.end) report.errors.push(`Payday ${p.payday} is before the end of period ${p.start}–${p.end}.`);
    if (seen.has(p.start)) report.errors.push(`Period start ${p.start} appears twice.`);
    seen.add(p.start);
    const length = days(p.start, p.end) + 1;
    if (length !== 14) report.nonStandardLengths.push({ start: p.start, end: p.end, days: length });
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.start <= prev.end) report.overlaps.push({ first: `${prev.start}–${prev.end}`, second: `${cur.start}–${cur.end}` });
    else if (days(prev.end, cur.start) > 1) report.gaps.push({ after: prev.end, before: cur.start, days: days(prev.end, cur.start) - 1 });
  }
  return report;
}

/**
 * Agency payment calendar (organisation-wide configuration). Layer 1: `payroll.calculate` (import) / `payroll.view`
 * (read) on the route; layer 2: the same flags re-checked here + Venue Managers refused + import only by the
 * organisation's current Initial Manager (owner decision 2026-10-21); layer 3: every query pinned to
 * the session's organisation; layer 4/5: `payroll_calendar*` RLS (read = organisation; write = a non-venue manager of
 * the organisation) and the GiST exclusion that makes overlapping active periods impossible.
 */
@Injectable()
export class PayrollCalendarService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly resourceScope: ResourceScopeService,
    private readonly audit: AuditService,
  ) {}

  private async assertFlag(m: EntityManager, ctx: AuthContext, flag: typeof PermissionFlag.PAYROLL_CALCULATE | typeof PermissionFlag.PAYROLL_VIEW): Promise<void> {
    if (!(await this.permissions.userHasPermissionTx(m, ctx, flag))) throw new ForbiddenException('Permission required.');
    if ((await this.resourceScope.resolveTx(m, ctx)).kind === 'venue') throw new ForbiddenException('Permission required.');
  }

  /**
   * The organisation's CURRENT Initial Manager (owner decision 2026-10-21: only they import/replace the agency calendar).
   * Read through the caller's own manager_profile row (RLS shows a user their own profile).
   */
  async isInitialManager(m: EntityManager, ctx: AuthContext): Promise<boolean> {
    const rows = await m.query(
      `SELECT 1 FROM core.manager_profile WHERE user_id = $1 AND organisation_id = $2 AND type = 'internal' AND is_initial_manager AND superseded_at IS NULL`,
      [ctx.userId, ctx.organisationId]);
    return rows.length > 0;
  }

  /** `canManage`: display hint for the web (import button) — the import itself re-checks everything. */
  async list(ctx: AuthContext): Promise<{ calendars: CalendarView[]; canManage: boolean }> {
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_VIEW);
      const canManage = (await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.PAYROLL_CALCULATE)) && (await this.isInitialManager(m, ctx));
      return { calendars: await this.load(m, ctx.organisationId!, null), canManage };
    });
  }

  /** Active calendars (`id` null) or one calendar by id. */
  private async load(m: EntityManager, organisationId: string, id: string | null): Promise<CalendarView[]> {
    const cals = await m.query(
      `SELECT c.id, c.year, c.version, c.source, c.timezone, c.status, c.notes, c.created_at FROM core.payroll_calendar c
        WHERE c.organisation_id = $1 AND (($2::uuid IS NULL AND c.status = 'active') OR c.id = $2::uuid) ORDER BY c.year, c.version`, [organisationId, id]);
    if (!cals.length) return [];
    const periods = await m.query(
      `SELECT id, calendar_id, to_char(period_start, 'YYYY-MM-DD') AS start, to_char(period_end, 'YYYY-MM-DD') AS "end",
              to_char(payday, 'YYYY-MM-DD') AS payday, note, needs_confirmation
         FROM core.payroll_calendar_period WHERE organisation_id = $1 AND calendar_id = ANY($2::uuid[]) ORDER BY period_start`,
      [organisationId, cals.map((c: { id: string }) => c.id)]);
    return cals.map((c: Record<string, unknown>) => ({
      id: c.id as string, year: Number(c.year), version: Number(c.version), source: c.source as string, timezone: c.timezone as string,
      status: c.status as 'active' | 'inactive', notes: (c.notes as string) ?? null, createdAt: new Date(c.created_at as string).toISOString(),
      periods: periods.filter((p: { calendar_id: string }) => p.calendar_id === c.id).map((p: Record<string, unknown>) => ({
        id: p.id as string, start: p.start as string, end: p.end as string, payday: p.payday as string, note: (p.note as string) ?? null,
        needsConfirmation: Boolean(p.needs_confirmation), days: days(p.start as string, p.end as string) + 1,
      })),
    }));
  }

  /**
   * Validates, then (unless dryRun) stores the calendar as a NEW version: the previous active version of that year is
   * deactivated (kept, never edited or deleted — runs keep pointing at its periods). Overlaps inside the import, or with
   * another year's active periods, are refused (409); gaps and non-14-day periods are reported, not refused.
   */
  async import(ctx: AuthContext, dto: ImportCalendarDto): Promise<{ applied: boolean; report: CalendarValidationReport; calendar: CalendarView | null }> {
    const report = validateCalendarPeriods(dto.periods);
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_CALCULATE);
      // Owner decision 2026-10-21: payroll.calculate alone is not enough — only the organisation's Initial Manager may
      // import or replace the agency calendar (RLS write policies enforce the same designation).
      if (!(await this.isInitialManager(m, ctx))) throw new ForbiddenException('Only the Initial Manager can import or replace the payment calendar.');
      if (report.errors.length) throw new BadRequestException({ statusCode: 400, message: report.errors[0], report });
      if (report.overlaps.length) throw new ConflictException({ statusCode: 409, message: 'Calendar periods overlap; nothing was imported.', report });
      if (dto.dryRun) return { applied: false, report, calendar: null };
      const org = ctx.organisationId!;
      await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`payroll_calendar:${org}`]);
      const [prev] = await m.query(`SELECT id, version FROM core.payroll_calendar WHERE organisation_id = $1 AND year = $2 AND status = 'active' FOR UPDATE`, [org, dto.year]);
      if (prev) {
        await m.query(`UPDATE core.payroll_calendar_period SET active = false WHERE organisation_id = $1 AND calendar_id = $2`, [org, prev.id]);
        await m.query(`UPDATE core.payroll_calendar SET status = 'inactive', deactivated_at = now() WHERE id = $1 AND organisation_id = $2`, [prev.id, org]);
      }
      const [{ v }] = await m.query(`SELECT COALESCE(max(version), 0) + 1 AS v FROM core.payroll_calendar WHERE organisation_id = $1 AND year = $2`, [org, dto.year]);
      const [cal] = await m.query(
        `INSERT INTO core.payroll_calendar (organisation_id, year, version, source, timezone, status, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7) RETURNING id`,
        [org, dto.year, v, dto.source.trim(), PAYROLL_TIMEZONE, dto.notes?.trim() || null, ctx.userId]);
      try {
        await m.query('SAVEPOINT calendar_periods');
        for (const p of [...dto.periods].sort((a, b) => a.start.localeCompare(b.start))) {
          await m.query(
            `INSERT INTO core.payroll_calendar_period (organisation_id, calendar_id, period_start, period_end, payday, note, needs_confirmation, active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
            [org, cal.id, p.start, p.end, p.payday, p.note?.trim() || null, p.needsConfirmation ?? false]);
        }
      } catch (error) {
        if ((error as { code?: string }).code === '23P01') {
          throw new ConflictException({ statusCode: 409, message: 'These periods overlap another active payroll calendar of this organisation; nothing was imported.', report });
        }
        throw error;
      }
      await this.audit.record(m, ctx, AuditAction.PAYROLL_CALENDAR_IMPORTED, {
        entityType: 'payroll_calendar', entityId: cal.id,
        metadata: { year: dto.year, version: Number(v), periods: dto.periods.length, source: dto.source.trim(), replacedVersion: prev ? Number(prev.version) : null,
          gaps: report.gaps.length, nonStandardLengths: report.nonStandardLengths.length },
      });
      const [calendar] = await this.load(m, org, cal.id);
      return { applied: true, report, calendar: calendar! };
    });
  }
}
