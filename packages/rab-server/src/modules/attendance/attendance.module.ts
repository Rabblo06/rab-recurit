import { Module, OnModuleInit } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { PermissionsService } from '../../engine/core-modules/permissions/permissions.service';
import { FileAccessRegistry } from '../../engine/core-modules/storage/file-access.registry';
import { FileKind } from '../../engine/core-modules/storage/file-kinds';
import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { ThrottlerRedisClientModule } from '../../engine/core-modules/throttler/throttler-redis-client.module';
import { PayrollModule } from '../payroll/payroll.module';
import { ReportFilePolicy } from './files/report-file.policy';
import { AttendanceController } from './controllers/attendance.controller';
import { ShiftReportController } from './controllers/shift-report.controller';
import { StaffReviewsController } from './controllers/staff-reviews.controller';
import { AttendancePerUserThrottleGuard } from './guards/attendance-per-user-throttle.guard';
import { AttendanceQrService } from './services/attendance-qr.service';
import { AttendanceService } from './services/attendance.service';
import { QrImageService } from './services/qr-image.service';
import { QrTokenService } from './services/qr-token.service';
import { ShiftReportService } from './services/shift-report.service';
import { ShiftReviewService } from './services/shift-review.service';
import { StaffReviewInsightsService } from './services/staff-review-insights.service';
import { ShiftTeamService } from './services/shift-team.service';

@Module({
  // Own JwtModule.register({}) — not re-exported by AuthModule (only
  // specific services are, see its own comment); QrTokenService always
  // passes its HKDF-derived secret explicitly per call, same convention as
  // AccessTokenService, so no shared default config is needed here either.
  // ThrottlerRedisClientModule: the same Redis-backed rate-limiter
  // infrastructure RabThrottlerModule already requires, reused (not
  // duplicated) by AttendancePerUserThrottleGuard.
  imports: [AuthModule, JwtModule.register({}), ThrottlerRedisClientModule, PayrollModule],
  controllers: [AttendanceController, ShiftReportController, StaffReviewsController],
  providers: [AttendanceService, AttendanceQrService, QrTokenService, QrImageService, ShiftReportService, ShiftReviewService, StaffReviewInsightsService, ShiftTeamService, AttendancePerUserThrottleGuard],
  exports: [AttendanceQrService, QrTokenService, QrImageService, ShiftReportService],
})
export class AttendanceModule implements OnModuleInit {
  constructor(
    private readonly registry: FileAccessRegistry,
    private readonly permissions: PermissionsService,
    private readonly shiftReports: ShiftReportService,
  ) {}

  onModuleInit(): void {
    // Report PDFs are evidence: stricter than "same organisation". See ReportFilePolicy.
    this.registry.register([FileKind.SHIFT_ROSTER_PDF, FileKind.FINAL_TIMESHEET_PDF], new ReportFilePolicy(this.permissions, this.shiftReports));
  }}
