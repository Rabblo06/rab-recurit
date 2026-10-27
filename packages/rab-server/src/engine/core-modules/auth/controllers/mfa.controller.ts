import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';

import { AuthUser } from '../../../decorators/auth-user.decorator';
import { PlatformAdminGuard } from '../../../guards/platform-admin.guard';
import { AuthContext } from '../../tenant/auth-context.interface';
import { RateLimitRequired } from '../../throttler/rab-throttler.guard';
import { AdminMfaResetDto, MfaCodeDto, MfaEnrolmentStartDto, MfaStepUpDto } from '../dto/mfa.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ManagerApplication } from '../guards/manager-application.decorator';
import { MobileApplication } from '../guards/mobile-application.decorator';
import { MfaManagementService } from '../services/mfa-management.service';
import { StepUpReauthService } from '../services/step-up-reauth.service';

const MFA_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/**
 * Wave 4 lane MFA — the signed-in user's own second factor and the reusable step-up. Transport only: every rule is in
 * `MfaManagementService` / `StepUpReauthService`.
 *
 * Account security step 1 (P2): 2FA is optional for EVERY role on EVERY app, so the self-service routes (status, enrol
 * start/confirm, regenerate recovery codes, disable) are reachable from manager_web AND from both mobile apps
 * (`@MobileApplication()` — JwtAuthGuard default-denies a mobile credential on any route without it; manager_web is
 * allowed on every route that is not `@ManagerApplication`). Composition in JwtAuthGuard: `@ManagerApplication` on a
 * handler refuses every non-web target, so it is used ONLY on the step-up route (a browser-dialog flow; the mobile apps
 * need no step-up). Cookie (web) requests remain CSRF-checked by JwtAuthGuard (trusted Origin on every unsafe method);
 * mobile requests use a Bearer token, which is not CSRF-able. Throttles unchanged (10/min/IP + per-user code bucket).
 * The secret is generated server-side and never logged; the enrolment response includes the otpauth:// URI so a phone can
 * hand it to an authenticator app on the same device.
 */
@Controller('rest/v1/auth')
@UseGuards(JwtAuthGuard)
export class MfaController {
  constructor(
    private readonly mfa: MfaManagementService,
    private readonly stepUp: StepUpReauthService,
  ) {}

  @Get('mfa')
  @MobileApplication()
  status(@AuthUser() ctx: AuthContext) {
    return this.mfa.status(ctx);
  }

  @Post('mfa/enrolment')
  @MobileApplication()
  @HttpCode(HttpStatus.OK)
  @Throttle(MFA_THROTTLE)
  @RateLimitRequired()
  startEnrolment(@AuthUser() ctx: AuthContext, @Body() dto: MfaEnrolmentStartDto) {
    return this.mfa.startEnrolment(ctx, { currentPassword: dto.currentPassword });
  }

  @Post('mfa/enrolment/confirm')
  @MobileApplication()
  @HttpCode(HttpStatus.OK)
  @Throttle(MFA_THROTTLE)
  @RateLimitRequired()
  confirmEnrolment(@AuthUser() ctx: AuthContext, @Body() dto: MfaCodeDto) {
    return this.mfa.confirmEnrolment(ctx, dto.code);
  }

  @Post('mfa/recovery-codes')
  @MobileApplication()
  @HttpCode(HttpStatus.OK)
  @Throttle(MFA_THROTTLE)
  @RateLimitRequired()
  regenerate(@AuthUser() ctx: AuthContext, @Body() dto: MfaStepUpDto) {
    return this.mfa.regenerateRecoveryCodes(ctx, { currentPassword: dto.currentPassword, code: dto.code });
  }

  @Post('mfa/disable')
  @MobileApplication()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(MFA_THROTTLE)
  @RateLimitRequired()
  async disable(@AuthUser() ctx: AuthContext, @Body() dto: MfaStepUpDto): Promise<void> {
    await this.mfa.disable(ctx, { currentPassword: dto.currentPassword, code: dto.code });
  }

  /**
   * Reusable "sudo mode": password (+ current code when enrolled) → a short grant for this session (`assertRecentStepUp`).
   * Step 1 (P6): with no password, it completes a fresh SSO re-authentication (+ the code when enrolled). Web only.
   */
  @Post('step-up')
  @ManagerApplication()
  @HttpCode(HttpStatus.OK)
  @Throttle(MFA_THROTTLE)
  @RateLimitRequired()
  stepUpNow(@AuthUser() ctx: AuthContext, @Body() dto: MfaStepUpDto) {
    return this.stepUp.stepUp(ctx, { currentPassword: dto.currentPassword, code: dto.code });
  }
}

/**
 * Platform administrators only (PlatformAdminGuard here, and again inside `MfaManagementService.adminReset`), manager web
 * only. Account security step 1 (P4): a required `reason`; proof = the admin's password inline (+ own code only if the
 * admin is enrolled) or a fresh step-up grant of this session; a per-admin rate limit (ADMIN_MFA_RESET_LIMIT).
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
  async reset(@AuthUser() ctx: AuthContext, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: AdminMfaResetDto, @Res({ passthrough: true }) response: Response) {
    try {
      return await this.mfa.adminReset(ctx, userId, { reason: dto.reason, currentPassword: dto.currentPassword, code: dto.code });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        const body = error.getResponse() as { retryAfter?: number };
        if (body.retryAfter) response.setHeader('Retry-After', body.retryAfter);
      }
      throw error;
    }
  }
}
