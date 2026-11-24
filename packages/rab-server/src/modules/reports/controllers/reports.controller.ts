import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { CreateReportExportDto } from '../dto/create-report-export.dto';
import { DownloadReportExportDto } from '../dto/download-report-export.dto';
import { ReportExportService } from '../services/report-export.service';

/**
 * Owner decision 29, reports page v1. Transport only: `ReportExportService` re-checks every flag, the scope and the
 * stored pay / hours decision, and pins every query to the session's own organisation, workspace and user (404 outside
 * them). `@ManagerApplication()`: a mobile (staff / venue manager app) session is refused outright. Each route names
 * an action; no status is ever accepted.
 */
@Controller('rest/v1/reports')
@UseGuards(JwtAuthGuard)
@ManagerApplication()
export class ReportsController {
  constructor(private readonly exports: ReportExportService) {}

  @Get('exports')
  @UseGuards(PermissionGuard(PermissionFlag.REPORT_VIEW), RequireWorkspaceGuard)
  list(@AuthUser() ctx: AuthContext) {
    return this.exports.list(ctx);
  }

  /** Start a background export (202: the Worker builds it; an in-app notice says when it is ready). */
  @Post('exports')
  @HttpCode(202)
  @UseGuards(PermissionGuard(PermissionFlag.REPORT_EXPORT), RequireWorkspaceGuard)
  requestExport(@AuthUser() ctx: AuthContext, @Body() dto: CreateReportExportDto) {
    return this.exports.request(ctx, dto);
  }

  /** A single-use download link for a ready export, valid for 60 seconds. */
  @Post('exports/:id/link')
  @HttpCode(201)
  @UseGuards(PermissionGuard(PermissionFlag.REPORT_EXPORT), RequireWorkspaceGuard)
  issueLink(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.exports.issueLink(ctx, id);
  }

  /** Uses the link: the file, once. */
  @Post('exports/:id/download')
  @HttpCode(200)
  @UseGuards(PermissionGuard(PermissionFlag.REPORT_EXPORT), RequireWorkspaceGuard)
  async download(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DownloadReportExportDto, @Res() res: Response) {
    const { filename, csv } = await this.exports.download(ctx, id, dto.token);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(csv);
  }
}
