import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import { Response } from 'express';

import { AuthUser } from '../../../decorators/auth-user.decorator';
import { resolveClientIp } from '../../../utils/client-ip.util';
import { EnvironmentService } from '../../environment/environment.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { RateLimitRequired } from '../../throttler/rab-throttler.guard';
import { WorkspaceHostRequest } from '../../workspace-host/workspace-host.types';
import { authCookieModeFromEnv, authCookieName, authCookieSetOptions, clearLegacyAuthCookieIfPresent, presentedWebSessionTokens } from '../constants/auth-cookie-policy';
import { CredentialRequestProvenanceGuard } from '../guards/credential-request-provenance.guard';
import { AuthenticatedRequest, JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ManagerApplication } from '../guards/manager-application.decorator';
import { AuthService } from '../services/auth.service';
import { LoginHandoffService } from './login-handoff.service';

export class LoginHandoffExchangeDto {
  @IsString()
  @MaxLength(128)
  token!: string;
}

const HANDOFF_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/**
 * Wave 4 lane MFA — cross-host login handoff transport (see `LoginHandoffService` for the full flow). Both routes
 * refuse an untrusted or missing `Origin` (login CSRF / cross-site exchange). The exchange route is JSON-only and
 * pre-auth; its only credential is the single-use token in the body, and its audience is the request's own workspace
 * host, never a field.
 */
@Controller('rest/v1/auth/login-handoff')
export class LoginHandoffController {
  private readonly logger = new Logger(LoginHandoffController.name);

  constructor(
    private readonly handoffs: LoginHandoffService,
    private readonly authService: AuthService,
    private readonly env: EnvironmentService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ManagerApplication()
  @UseGuards(JwtAuthGuard)
  @Throttle(HANDOFF_THROTTLE)
  @RateLimitRequired()
  create(@AuthUser() ctx: AuthContext, @Req() req: AuthenticatedRequest & WorkspaceHostRequest) {
    this.assertTrustedOrigin(req);
    return this.handoffs.create(ctx, req.workspaceHost);
  }

  /**
   * Lane D (M10-3): "Continue as j***@example.com?" — pre-auth, read-only (never consumes or extends the token), JSON
   * only with a trusted Origin (CredentialRequestProvenanceGuard + the check below), per-IP throttled, one uniform 401
   * for every failure. The token is in the POST body (never a URL / log line), exactly as for the exchange.
   */
  @Post('peek')
  @HttpCode(HttpStatus.OK)
  @Throttle(HANDOFF_THROTTLE)
  @RateLimitRequired()
  @UseGuards(CredentialRequestProvenanceGuard)
  peek(@Body() dto: LoginHandoffExchangeDto, @Req() req: AuthenticatedRequest & WorkspaceHostRequest) {
    this.assertTrustedOrigin(req);
    return this.handoffs.peek(dto.token, req.workspaceHost);
  }

  @Post('exchange')
  @HttpCode(HttpStatus.OK)
  @Throttle(HANDOFF_THROTTLE)
  @RateLimitRequired()
  @UseGuards(CredentialRequestProvenanceGuard)
  async exchange(@Body() dto: LoginHandoffExchangeDto, @Req() req: AuthenticatedRequest & WorkspaceHostRequest, @Res({ passthrough: true }) res: Response) {
    this.assertTrustedOrigin(req);
    const result = await this.handoffs.exchange(dto.token, req.workspaceHost, { ip: resolveClientIp(req, this.env.trustedProxyCidrs), userAgent: req.headers['user-agent'] });
    // Session fixation: whatever session cookie THIS host already presented is ended; the browser only keeps the new one.
    for (const presented of presentedWebSessionTokens(req, authCookieModeFromEnv(this.env))) {
      try {
        await this.authService.revokeSupersededWebSession(presented);
      } catch (error) {
        this.logger.warn(`supersede_previous_session_failed reason=${(error as Error).name}`);
      }
    }
    const mode = authCookieModeFromEnv(this.env);
    res.cookie(authCookieName('refresh', mode), result.refreshToken, authCookieSetOptions('refresh', mode, Math.max(0, result.refreshExpiresAt.getTime() - Date.now())));
    clearLegacyAuthCookieIfPresent(req, res, 'refresh', mode);
    if (result.webSessionToken) {
      res.cookie(authCookieName('session', mode), result.webSessionToken, authCookieSetOptions('session', mode, Math.max(0, result.sessionExpiresAt.getTime() - Date.now())));
      clearLegacyAuthCookieIfPresent(req, res, 'session', mode);
    }
    // No token, id or credential in the body — the session lives only in the HttpOnly cookies.
    return { mustResetPassword: result.mustResetPassword, sessionExpiresAt: result.sessionExpiresAt.toISOString() };
  }

  private assertTrustedOrigin(req: AuthenticatedRequest): void {
    if (!this.env.isTrustedOrigin(req.headers.origin)) throw new ForbiddenException('Untrusted origin.');
  }
}
