import {
  PermissionFlag,
  REPORT_EXPORT_LINK_TTL_SECONDS,
  REPORT_EXPORT_MAX_PERIOD_DAYS,
  REPORT_EXPORTS_PER_USER_PER_HOUR,
  REPORT_KEYS,
  ReportExportErrorType,
  ReportExportStatusType,
  ReportExportSummary,
  ReportKey,
  ReportKeyType,
  reportIsPayOnly,
  reportTakesPeriod,
} from '@rab/shared';
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScope, ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { businessTables } from '../../../engine/core-modules/tenant/business-tables';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { FieldPolicyService } from '../../identity/member-access/field-policy.service';
import { CreateReportExportDto } from '../dto/create-report-export.dto';

/** The columns this service reads back; never `csv_content` except in `download`, never the token hash. */
const SUMMARY_COLUMNS = `id, report_key, to_char(period_from, 'YYYY-MM-DD') AS period_from, to_char(period_to, 'YYYY-MM-DD') AS period_to,
  venue_id, payroll_run_id, include_pay, include_hours, scope_kind, scope_owner_user_id, scope_venue_ids, status, error_code,
  row_count, created_at, ready_at, file_expires_at`;

interface ExportRow {
  id: string;
  report_key: ReportKeyType;
  period_from: string | null;
  period_to: string | null;
  venue_id: string | null;
  payroll_run_id: string | null;
  include_pay: boolean;
  include_hours: boolean;
  scope_kind: 'owner' | 'venue';
  scope_owner_user_id: string | null;
  scope_venue_ids: string[];
  status: ReportExportStatusType;
  error_code: ReportExportErrorType | null;
  row_count: number | null;
  created_at: Date;
  ready_at: Date | null;
  file_expires_at: Date | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const NOT_FOUND = 'Report export not found.';

function toSummary(r: ExportRow): ReportExportSummary {
  return {
    id: r.id,
    reportKey: r.report_key,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    venueId: r.venue_id,
    payrollRunId: r.payroll_run_id,
    includePay: r.include_pay,
    status: r.status,
    errorCode: r.error_code,
    rowCount: r.row_count,
    createdAt: iso(r.created_at)!,
    readyAt: iso(r.ready_at),
    fileExpiresAt: iso(r.file_expires_at),
  };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function isRealDate(value: string): boolean {
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/**
 * Owner decision 29: reports page v1, the request / list / link / download half (the Worker builds the file).
 *
 * Every method re-checks its permission here (layer 2), not only in the controller's PermissionGuard: `report.view`
 * lists one's own exports; `report.export` starts one, issues its link and downloads it. organisationId / workspaceId
 * come from the verified session only; every query is also pinned to them, and the RLS policies of core.report_export
 * (requester only) are the database backstop. A row outside the caller's own exports is a 404, never a 403.
 *
 * Who sees what (the decision's table): a Venue Manager only their own venues, never pay (and never the payroll run
 * summary: 403, they categorically lack it); pay columns only with payroll.view AND the field policy leaving the pay
 * field visible; hours columns only while the field policy leaves worked time visible. The decision is stored on the
 * row when the export is asked for (the Worker builds exactly that) and RE-CHECKED when the link is issued and when the
 * file is downloaded: a lost venue or a lost pay / hours permission refuses the download.
 */
@Injectable()
export class ReportExportService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly resourceScope: ResourceScopeService,
    private readonly fieldPolicy: FieldPolicyService,
    private readonly audit: AuditService,
  ) {}

  async request(ctx: AuthContext, dto: CreateReportExportDto): Promise<ReportExportSummary> {
    this.resourceScope.assertHasWorkspace(ctx);
    const params = this.validate(dto);
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.permissions.assertPermissionTx(m, ctx, PermissionFlag.REPORT_VIEW);
      await this.permissions.assertPermissionTx(m, ctx, PermissionFlag.REPORT_EXPORT);
      const scope = await this.resourceScope.resolveTx(m, ctx);
      const t = businessTables(m);

      if (scope.kind === 'venue') {
        if (reportIsPayOnly(params.reportKey)) throw new ForbiddenException('Permission required.');
        if (scope.venueIds.length === 0 || (params.venueId && !scope.venueIds.includes(params.venueId))) throw new NotFoundException('Venue not found.');
      } else if (params.venueId) {
        const [venue] = await m.query(`SELECT 1 FROM ${t.venue} WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3`, [params.venueId, ctx.organisationId, ctx.workspaceId]);
        if (!venue) throw new NotFoundException('Venue not found.');
      }
      if (params.payrollRunId) {
        const [run] = await m.query(`SELECT 1 FROM ${t.payroll_run} WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3`, [params.payrollRunId, ctx.organisationId, ctx.workspaceId]);
        if (!run) throw new NotFoundException('Payroll run not found.');
      }

      const columns = await this.columnsFor(m, ctx, scope, params.reportKey);
      if (reportIsPayOnly(params.reportKey) && !columns.includePay) throw new ForbiddenException('Permission required.');
      if (params.reportKey === ReportKey.WEEKLY_HOURS_PER_STAFF && !columns.includeHours) throw new ForbiddenException('Permission required.');

      // Per-user hourly limit. The transaction-scoped advisory lock serialises one user's concurrent requests, so two
      // parallel calls cannot both pass the count (fail closed: a lock or count error fails the request).
      await m.query(`SELECT pg_advisory_xact_lock(hashtextextended('report_export:' || $1::text, 0))`, [ctx.userId]);
      const [{ n }] = await m.query(
        `SELECT count(*)::int AS n FROM core.report_export
          WHERE organisation_id = $1 AND workspace_id = $2 AND requested_by = $3 AND created_at > now() - interval '1 hour'`,
        [ctx.organisationId, ctx.workspaceId, ctx.userId],
      );
      if (n >= REPORT_EXPORTS_PER_USER_PER_HOUR) {
        throw new HttpException(
          { statusCode: HttpStatus.TOO_MANY_REQUESTS, code: 'REPORT_EXPORT_RATE_LIMITED', message: `You can start ${REPORT_EXPORTS_PER_USER_PER_HOUR} exports an hour. Try again later.` },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const [row] = await m.query<ExportRow[]>(
        `INSERT INTO core.report_export (organisation_id, workspace_id, requested_by, report_key, period_from, period_to, venue_id, payroll_run_id,
                                         include_pay, include_hours, scope_kind, scope_owner_user_id, scope_venue_ids)
         VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11, $12, $13::uuid[])
         RETURNING ${SUMMARY_COLUMNS}`,
        [
          ctx.organisationId, ctx.workspaceId, ctx.userId, params.reportKey, params.periodFrom, params.periodTo, params.venueId, params.payrollRunId,
          columns.includePay, columns.includeHours, scope.kind,
          scope.kind === 'owner' ? scope.ownerUserId : null,
          scope.kind === 'venue' ? (params.venueId ? [params.venueId] : scope.venueIds) : [],
        ],
      );
      await this.audit.record(m, ctx, AuditAction.REPORT_EXPORT_REQUESTED, {
        entityType: 'report_export',
        entityId: row!.id,
        metadata: {
          reportKey: params.reportKey, periodFrom: params.periodFrom, periodTo: params.periodTo, venueId: params.venueId,
          payrollRunId: params.payrollRunId, includePay: columns.includePay, includeHours: columns.includeHours, scope: scope.kind,
        },
      });
      return toSummary(row!);
    });
  }

  /** The caller's own exports, newest first (at most 50). */
  async list(ctx: AuthContext): Promise<{ data: ReportExportSummary[] }> {
    this.resourceScope.assertHasWorkspace(ctx);
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.permissions.assertPermissionTx(m, ctx, PermissionFlag.REPORT_VIEW);
      const rows = await m.query<ExportRow[]>(
        `SELECT ${SUMMARY_COLUMNS} FROM core.report_export
          WHERE organisation_id = $1 AND workspace_id = $2 AND requested_by = $3
          ORDER BY created_at DESC, id DESC LIMIT 50`,
        [ctx.organisationId, ctx.workspaceId, ctx.userId],
      );
      return { data: rows.map(toSummary) };
    });
  }

  /**
   * Issues the single-use download link for a ready file: 32 random bytes, returned once, stored only as SHA-256. The
   * database fixes its issue time and 60-second lifetime and replaces any earlier link for this export.
   */
  async issueLink(ctx: AuthContext, id: string): Promise<{ token: string; expiresInSeconds: number }> {
    this.resourceScope.assertHasWorkspace(ctx);
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.permissions.assertPermissionTx(m, ctx, PermissionFlag.REPORT_EXPORT);
      const row = await this.ownRow(m, ctx, id);
      await this.assertStillAllowed(m, ctx, row);
      const token = randomBytes(32).toString('base64url');
      const [rows] = (await m.query(
        `UPDATE core.report_export SET download_token_hash = $4
          WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3 AND requested_by = $5 AND status = 'ready' AND file_expires_at > now()
          RETURNING id`,
        [id, ctx.organisationId, ctx.workspaceId, sha256(token), ctx.userId],
      )) as [Array<{ id: string }>, number];
      if (!rows.length) throw new NotFoundException(NOT_FOUND);
      await this.audit.record(m, ctx, AuditAction.REPORT_EXPORT_LINK_ISSUED, { entityType: 'report_export', entityId: id, metadata: { reportKey: row.report_key } });
      return { token, expiresInSeconds: REPORT_EXPORT_LINK_TTL_SECONDS };
    });
  }

  /**
   * Downloads the file once: the permission and scope re-check first, then the link is burnt (one UPDATE that matches
   * only an unused, unexpired link of a ready, undeleted file); anything else is a 404. Audited.
   */
  async download(ctx: AuthContext, id: string, token: string): Promise<{ filename: string; csv: string }> {
    this.resourceScope.assertHasWorkspace(ctx);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException(NOT_FOUND);
    return this.tenantContext.runInWorkspaceContext(ctx, async (m) => {
      await this.permissions.assertPermissionTx(m, ctx, PermissionFlag.REPORT_EXPORT);
      const row = await this.ownRow(m, ctx, id);
      await this.assertStillAllowed(m, ctx, row);
      const [rows] = (await m.query(
        `UPDATE core.report_export SET download_token_used_at = clock_timestamp(), download_count = download_count + 1
          WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3 AND requested_by = $4
            AND download_token_hash = $5 AND download_token_used_at IS NULL AND download_token_expires_at > clock_timestamp()
            AND status = 'ready' AND file_expires_at > now()
          RETURNING csv_content`,
        [id, ctx.organisationId, ctx.workspaceId, ctx.userId, sha256(token)],
      )) as [Array<{ csv_content: string }>, number];
      if (!rows.length) throw new NotFoundException('This download link has expired or was already used. Ask for a new one.');
      await this.audit.record(m, ctx, AuditAction.REPORT_EXPORT_DOWNLOADED, {
        entityType: 'report_export',
        entityId: id,
        metadata: { reportKey: row.report_key, includePay: row.include_pay, rowCount: row.row_count },
      });
      const suffix = row.period_from ? `${row.period_from}-to-${row.period_to}` : `run-${row.payroll_run_id}`;
      return { filename: `${row.report_key}-${suffix}.csv`, csv: rows[0]!.csv_content };
    });
  }

  // ------------------------------------------------------------------------------------------------------------ helpers

  private validate(dto: CreateReportExportDto): {
    reportKey: ReportKeyType; periodFrom: string | null; periodTo: string | null; venueId: string | null; payrollRunId: string | null;
  } {
    if (!REPORT_KEYS.includes(dto.reportKey)) throw new BadRequestException('Unknown report.');
    if (reportTakesPeriod(dto.reportKey)) {
      if (!dto.periodFrom || !dto.periodTo || dto.payrollRunId) throw new BadRequestException('Choose a period (from and to) for this report.');
      if (!isRealDate(dto.periodFrom) || !isRealDate(dto.periodTo)) throw new BadRequestException('Use real dates (YYYY-MM-DD).');
      const days = daysBetween(dto.periodFrom, dto.periodTo);
      if (days < 0) throw new BadRequestException('The period ends before it starts.');
      if (days + 1 > REPORT_EXPORT_MAX_PERIOD_DAYS) throw new BadRequestException(`A report covers at most ${REPORT_EXPORT_MAX_PERIOD_DAYS} days.`);
      return { reportKey: dto.reportKey, periodFrom: dto.periodFrom, periodTo: dto.periodTo, venueId: dto.venueId ?? null, payrollRunId: null };
    }
    if (!dto.payrollRunId || dto.periodFrom || dto.periodTo || dto.venueId) throw new BadRequestException('Choose a payroll run for this report.');
    return { reportKey: dto.reportKey, periodFrom: null, periodTo: null, venueId: null, payrollRunId: dto.payrollRunId };
  }

  /** Which optional columns this caller may have, from the live permission and field policy (never the client). */
  private async columnsFor(m: EntityManager, ctx: AuthContext, scope: ResourceScope, reportKey: ReportKeyType): Promise<{ includePay: boolean; includeHours: boolean }> {
    const payroll = reportKey === ReportKey.PAYROLL_RUN_SUMMARY;
    const policy = await this.fieldPolicy.resolveTx(m, ctx, payroll ? 'payroll_record' : 'attendance');
    const showsPay = payroll || reportKey === ReportKey.HOURS_AND_PAY_BY_VENUE;
    const showsHours = payroll || reportKey === ReportKey.HOURS_AND_PAY_BY_VENUE || reportKey === ReportKey.WEEKLY_HOURS_PER_STAFF;
    const includePay =
      showsPay &&
      scope.kind === 'owner' &&
      (await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.PAYROLL_VIEW)) &&
      this.fieldPolicy.isVisible(policy, payroll ? 'amount' : 'earnings');
    const includeHours = showsHours && this.fieldPolicy.isVisible(policy, 'workedTime');
    return { includePay, includeHours };
  }

  private async ownRow(m: EntityManager, ctx: AuthContext, id: string): Promise<ExportRow> {
    const [row] = await m.query<ExportRow[]>(
      `SELECT ${SUMMARY_COLUMNS} FROM core.report_export WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3 AND requested_by = $4`,
      [id, ctx.organisationId, ctx.workspaceId, ctx.userId],
    );
    if (!row) throw new NotFoundException(NOT_FOUND);
    return row;
  }

  /**
   * The stored decision must still hold for the caller NOW: the same scope (a Venue Manager still assigned to every
   * stored venue; an owner-scoped export still the same owner), and pay / hours columns only while still allowed.
   */
  private async assertStillAllowed(m: EntityManager, ctx: AuthContext, row: ExportRow): Promise<void> {
    const scope = await this.resourceScope.resolveTx(m, ctx);
    if (row.scope_kind === 'venue') {
      if (scope.kind !== 'venue' || !row.scope_venue_ids.every((v) => scope.venueIds.includes(v))) throw new NotFoundException(NOT_FOUND);
    } else if (scope.kind !== 'owner' || scope.ownerUserId !== row.scope_owner_user_id) {
      throw new NotFoundException(NOT_FOUND);
    }
    if (row.include_pay || row.include_hours) {
      const now = await this.columnsFor(m, ctx, scope, row.report_key);
      if ((row.include_pay && !now.includePay) || (row.include_hours && !now.includeHours)) {
        throw new ForbiddenException('Your access to the figures in this export has changed. Run the export again.');
      }
    }
  }
}
