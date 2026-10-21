import { PermissionFlag } from '@rab/shared';
import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { BulkApprovePayrollDto, ListPayrollRecordsDto, PayrollPeriodQueryDto, RejectPayrollRecordDto } from '../dto/payroll-record.dto';
import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { MobileApplication } from '../../../engine/core-modules/auth/guards/mobile-application.decorator';
import { PayrollService } from '../services/payroll.service';
import { PayrollCalendarService } from '../services/payroll-calendar.service';
import { PayrollRunService } from '../services/payroll-run.service';
import { ImportCalendarDto, MarkPaidDto, PayslipNetDto, PrepareRunDto } from '../dto/payroll-runs.dto';
import { PAYSLIP_MAX_BYTES, singleImageUploadOptions } from '../../../engine/core-modules/storage/upload-limits';

/**
 * Manager console payroll approval. Transport only: `PayrollService` re-checks the permission, the workspace and the
 * Venue Manager exclusion, and pins every query to the caller's own workspace (404 outside it). `@ManagerApplication()`:
 * a mobile (staff / venue manager app) session is refused outright.
 */
@Controller('rest/v1/payroll')
@UseGuards(JwtAuthGuard)
@ManagerApplication()
export class PayrollController {
  constructor(
    private readonly payroll: PayrollService,
    private readonly calendar: PayrollCalendarService,
    private readonly runs: PayrollRunService,
  ) {}

  // ------------------------------------------------------------- agency payment calendar (organisation-wide)

  @Get('calendar')
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_VIEW))
  listCalendar(@AuthUser() ctx: AuthContext) {
    return this.calendar.list(ctx);
  }

  /** `payroll.calculate`: the payroll-administration flag (Initial/Internal Managers by default); see PayrollCalendarService. */
  @Post('calendar/import')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_CALCULATE))
  importCalendar(@AuthUser() ctx: AuthContext, @Body() dto: ImportCalendarDto) {
    return this.calendar.import(ctx, dto);
  }

  // ------------------------------------------------------------- payroll runs (per workspace and period)

  @Get('runs')
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_VIEW), RequireWorkspaceGuard)
  listRuns(@AuthUser() ctx: AuthContext) {
    return this.runs.listPeriods(ctx);
  }

  @Post('runs/prepare')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_CALCULATE), RequireWorkspaceGuard)
  prepareRun(@AuthUser() ctx: AuthContext, @Body() dto: PrepareRunDto) {
    return this.runs.prepare(ctx, dto.periodId);
  }

  @Get('runs/:runId')
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_VIEW), RequireWorkspaceGuard)
  runDetail(@AuthUser() ctx: AuthContext, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.runs.detail(ctx, runId);
  }

  @Post('runs/:runId/finalise')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_APPROVE), RequireWorkspaceGuard)
  finaliseRun(@AuthUser() ctx: AuthContext, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.runs.finalise(ctx, runId);
  }

  @Get('runs/:runId/export')
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_VIEW), RequireWorkspaceGuard)
  async exportRun(@AuthUser() ctx: AuthContext, @Param('runId', ParseUUIDPipe) runId: string, @Res() res: Response) {
    const { filename, csv } = await this.runs.exportCsv(ctx, runId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(csv);
  }

  /** Provider's official payslip PDF (multipart `file`, PDF only, ≤10 MB, no other field). */
  @Post('runs/:runId/payslips/:staffProfileId/document')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_CALCULATE), RequireWorkspaceGuard)
  @UseInterceptors(FileInterceptor('file', singleImageUploadOptions(PAYSLIP_MAX_BYTES)))
  uploadPayslip(
    @AuthUser() ctx: AuthContext,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @UploadedFile() file?: { buffer: Buffer },
  ) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    return this.runs.uploadPayslip(ctx, runId, staffProfileId, file.buffer);
  }

  @Put('runs/:runId/payslips/:staffProfileId/net')
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_CALCULATE), RequireWorkspaceGuard)
  setNet(@AuthUser() ctx: AuthContext, @Param('runId', ParseUUIDPipe) runId: string, @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string, @Body() dto: PayslipNetDto) {
    return this.runs.setNet(ctx, runId, staffProfileId, dto.netPence ?? null);
  }

  @Post('runs/:runId/payslips/:staffProfileId/mark-paid')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_MARK_PAID), RequireWorkspaceGuard)
  markPaid(@AuthUser() ctx: AuthContext, @Param('runId', ParseUUIDPipe) runId: string, @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string, @Body() dto: MarkPaidDto) {
    return this.runs.markPaid(ctx, runId, staffProfileId, dto.paymentReference);
  }

  /** Re-queue a failed Approved Shift Statement (same durable outbox path; audited). */
  @Post('records/:id/statement/retry')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_APPROVE), RequireWorkspaceGuard)
  retryStatement(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.retryStatement(ctx, id);
  }

  @Get('records')
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_VIEW), RequireWorkspaceGuard)
  list(@AuthUser() ctx: AuthContext, @Query() dto: ListPayrollRecordsDto) {
    return this.payroll.list(ctx, dto);
  }

  /** Month read model for the Payroll page (attendance of this workspace + payroll record, verified figures only). */
  @Get('period')
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_VIEW), RequireWorkspaceGuard)
  period(@AuthUser() ctx: AuthContext, @Query() dto: PayrollPeriodQueryDto) {
    return this.payroll.period(ctx, dto.month);
  }

  /** Per-id results: `{ approved: PayrollRecordView[], blocked: [{ id, reason, message }] }`; see `PayrollService.bulkApprove`. */
  @Post('records/bulk-approve')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_APPROVE), RequireWorkspaceGuard)
  bulkApprove(@AuthUser() ctx: AuthContext, @Body() dto: BulkApprovePayrollDto) {
    return this.payroll.bulkApprove(ctx, dto.ids);
  }

  @Post('records/:id/approve')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_APPROVE), RequireWorkspaceGuard)
  approve(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.approve(ctx, id);
  }

  @Post('records/:id/reject')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_APPROVE), RequireWorkspaceGuard)
  reject(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectPayrollRecordDto) {
    return this.payroll.reject(ctx, id, dto.reason);
  }
}

/**
 * Staff app: the caller own Approved Shift Statements (newest approval first). Separate class because the console controller is
 * `@ManagerApplication()`; this one is available ONLY to a `staff_app` session (CF-08 default-deny for every other app).
 * The PDF itself downloads through `GET /rest/v1/files/:fileId/download` (ShiftStatementFilePolicy).
 */
@Controller('rest/v1/payroll/me')
@UseGuards(JwtAuthGuard)
export class StaffShiftStatementsController {
  constructor(
    private readonly payroll: PayrollService,
    private readonly runs: PayrollRunService,
  ) {}

  /** The caller's own official payslips (upcoming / processing / available / paid), newest payday first. */
  @MobileApplication('staff_app')
  @Get('payslips')
  @UseGuards(PermissionGuard(PermissionFlag.PAYSLIP_VIEW_OWN), RequireWorkspaceGuard)
  payslips(@AuthUser() ctx: AuthContext) {
    return this.runs.listMine(ctx);
  }

  @MobileApplication('staff_app')
  @Get('statements')
  @UseGuards(PermissionGuard(PermissionFlag.PAYSLIP_VIEW_OWN), RequireWorkspaceGuard)
  statements(@AuthUser() ctx: AuthContext, @Query() pagination: PaginationDto) {
    return this.payroll.listMine(ctx, pagination);
  }
}
