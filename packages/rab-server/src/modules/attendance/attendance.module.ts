import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { ThrottlerRedisClientModule } from '../../engine/core-modules/throttler/throttler-redis-client.module';
import { AttendanceController } from './controllers/attendance.controller';
import { ShiftReportController } from './controllers/shift-report.controller';
import { AttendancePerUserThrottleGuard } from './guards/attendance-per-user-throttle.guard';
import { AttendanceQrService } from './services/attendance-qr.service';
import { AttendanceService } from './services/attendance.service';
import { QrImageService } from './services/qr-image.service';
import { QrTokenService } from './services/qr-token.service';
import { ShiftReportService } from './services/shift-report.service';

@Module({
  // Own JwtModule.register({}) — not re-exported by AuthModule (only
  // specific services are, see its own comment); QrTokenService always
  // passes its HKDF-derived secret explicitly per call, same convention as
  // AccessTokenService, so no shared default config is needed here either.
  // ThrottlerRedisClientModule: the same Redis-backed rate-limiter
  // infrastructure RabThrottlerModule already requires, reused (not
  // duplicated) by AttendancePerUserThrottleGuard.
  imports: [AuthModule, JwtModule.register({}), ThrottlerRedisClientModule],
  controllers: [AttendanceController, ShiftReportController],
  providers: [AttendanceService, AttendanceQrService, QrTokenService, QrImageService, ShiftReportService, AttendancePerUserThrottleGuard],
  exports: [AttendanceQrService, QrTokenService, QrImageService, ShiftReportService],
})
export class AttendanceModule {}
