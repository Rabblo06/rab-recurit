import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AuthUser } from '../../../decorators/auth-user.decorator';
import { PlatformAdminGuard } from '../../../guards/platform-admin.guard';
import { AuthContext } from '../../tenant/auth-context.interface';
import { RateLimitRequired } from '../../throttler/rab-throttler.guard';
import { MfaCodeDto, MfaEnrolmentStartDto, MfaStepUpDto } from '../dto/mfa.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ManagerApplication } from '../guards/manager-application.decorator';
import { MfaManagementService } from '../services/mfa-management.service';
import { StepUpReauthService } from '../services/step-up-reauth.service';

const MFA_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/**
 * Wave 4 lane MFA — the signed-in user's own second factor and the reusable step-up. Manager web sessions only (a
 * mobile-app credential is refused by JwtAuthGuard: no @MobileApplication). Every unsafe call is cookie-CSRF-checked by
 * JwtAuthGuard (trusted Origin). Transport only: every rule is in `MfaManagementService` / `StepUpReauthService`.
 */
@ManagerApplication()
@Controller('rest/v1/auth')
@UseGuards(JwtAuthGuard)
export class MfaController {
  constructor(
    private readonly mfa: MfaManagementService,
    private readonly stepUp: StepUpReauthService,
  ) {}

  @Get('mfa')
  status(@AuthUser() ctx: AuthContext) {
    return this.mfa.status(ctx);
  }

  @Post('mfa/enrolment')
  @HttpCode(HttpStatus.OK)
  @Throttle(MFA_THROTTLE)
  @RateLimitRequired()
  startEnrolment(@AuthUser() ctx: AuthContext, @Body() dto: MfaEnrolmentStartDto) {
    return this.mfa.startEnrolment(ctx, dto.currentPassword);
  }

  @Post('mfa/enrolment/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle(MFA_THROTTLE)
  @RateLimitRequired()
  confirmEnrolment(@AuthUser() ctx: AuthContext, @Body() dto: MfaCodeDto) {
    return this.mfa.confirmEnrolment(ctx, dto.code);
  }

  @Post('mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  @Throttle(MFA_THROTTLE)
  @RateLimitRequired()
  regenerate(@AuthUser() ctx: AuthContext, @Body() dto: MfaStepUpDto) {
    return this.mfa.regenerateRecoveryCodes(ctx, dto);
  }

  @Post('mfa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(MFA_THROTTLE)
  @RateLimitRequired()
  async disable(@AuthUser() ctx: AuthContext, @Body() dto: MfaStepUpDto): Promise<void> {
    await this.mfa.disable(ctx, dto);
  }

  /** Reusable "sudo mode": password (+ current code when enrolled) → a short grant for this session (`assertRecentStepUp`). */
  @Post('step-up')
  @HttpCode(HttpStatus.OK)
  @Throttle(MFA_THROTTLE)
  @RateLimitRequired()
  stepUpNow(@AuthUser() ctx: AuthContext, @Body() dto: MfaStepUpDto) {
    return this.stepUp.stepUp(ctx, dto);
  }
}

/**
 * Platform administrators only (PlatformAdminGuard here, and again inside `MfaManagementService.adminReset`). Resetting
 * ANOTHER user's second factor needs the admin's own password + own current code in the same request.
 */
@ManagerApplication()
@Controller('rest/v1/admin/users')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class MfaAdminController {
  constructor(private readonly mfa: MfaManagementService) {}

  @Post(':userId/mfa/reset')
  @HttpCode(HttpStatus.OK)
  @Throttle(MFA_THROTTLE)
  @RateLimitRequired()
  reset(@AuthUser() ctx: AuthContext, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: MfaStepUpDto) {
    return this.mfa.adminReset(ctx, userId, dto);
  }
}
