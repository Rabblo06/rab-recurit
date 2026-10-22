import { APPLICATION_TARGETS, ApplicationTarget } from '../application-access';
import { CredentialRequestProvenanceGuard } from '../guards/credential-request-provenance.guard';
import { Logger, Body, Controller, HttpException, ForbiddenException, Get, HttpCode, HttpStatus, Post, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PermissionFlag } from '@rab/shared';
import { PermissionsService } from '../../permissions/permissions.service';
import { Response } from 'express';

import { AuthUser } from '../../../decorators/auth-user.decorator';
import { resolveClientIp } from '../../../utils/client-ip.util';
import { EnvironmentService } from '../../environment/environment.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import {
  buildRefreshCookieOptions,
  clearRefreshCookieOptions,
  CLIENT_PLATFORM_HEADER,
  MOBILE_PLATFORM_VALUE,
  REFRESH_COOKIE_NAME,
} from '../constants/refresh-cookie.constants';
import { buildWebSessionCookieOptions, clearWebSessionCookieOptions, WEB_SESSION_COOKIE_NAME } from '../constants/web-session-cookie.constants';
import { ActivateAccountDto } from '../dto/activate-account.dto';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import { LoginDto } from '../dto/login.dto';
import { RefreshDto } from '../dto/refresh.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';
import { SetPasswordDto } from '../dto/set-password.dto';
import { AuthenticatedRequest, JwtAuthGuard } from '../guards/jwt-auth.guard';
import { AuthService, AuthTokens, LoginResult } from '../services/auth.service';
import { OrganisationAuthProvidersService } from '../services/organisation-auth-providers.service';
import { MobileApplication } from '../guards/mobile-application.decorator';
import { RateLimitRequired } from '../../throttler/rab-throttler.guard';

function requestMeta(request: AuthenticatedRequest, trustedProxyCidrs: readonly string[]) {
  // SEC-03 / PHASE 11 EDGE-01: login_history's ip column is a security/
  // forensic record — a raw `request.ip` would otherwise record the same
  // shared proxy address for every login in production, making it useless
  // for distinguishing callers. Uses the SAME trusted-proxy check as the
  // rate limiter (`RabThrottlerModule`) — see `resolveClientIp`'s doc
  // comment — so the audit IP and the rate-limit identity never disagree.
  return { ip: resolveClientIp(request, trustedProxyCidrs), userAgent: request.headers['user-agent'] };
}

/**
 * 5 req/min/IP — tight enough to blunt credential stuffing and forgot/reset-
 * password abuse, loose enough that a genuine user mistyping their password
 * a few times in a row never sees it. IP-scoped, on top of (not instead of)
 * `AuthService.login`'s per-(email, IP) / account-wide attempt limiter (LoginAttemptLimiterService) — see RabThrottlerModule.
 */
const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

/**
 * `AuthController` is the one place Web's HttpOnly refresh cookie and
 * Mobile's body-based refresh token diverge — `AuthService` itself stays
 * transport-agnostic (still always computes and returns a real
 * `refreshToken` string; this controller decides whether that value becomes
 * a `Set-Cookie` header (Web, the default) or stays in the JSON body
 * (Mobile, opted in via `CLIENT_PLATFORM_HEADER`).
 */
@Controller('rest/v1/auth')
export class AuthController {
  private readonly supersedeLogger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly env: EnvironmentService,
    private readonly permissions: PermissionsService,
    private readonly organisationAuthProviders: OrganisationAuthProvidersService,
  ) {}

  /**
   * P1C.1B — Twenty-style public, pre-auth provider config (FULL-ARCHITECTURE-UPGRADE-PLAN.md
   * §33.7.8). Booleans only — no secrets, no Redis URL, no client secret, no APP_SECRET, no
   * session hash, no JWT signing details, ever. `org` is an optional organisation SLUG (never a
   * client-supplied organisationId/UUID — resolved through the narrow pre-auth
   * `auth_find_organisation_by_slug` lookup, same pattern as every other pre-auth function in
   * this codebase); an unknown slug returns the SAME shape as no slug at all (system-only), so
   * this endpoint can never be used to enumerate which slugs exist.
   *
   * Dynamic-domain-display checkpoint — `domain` added here rather than a new endpoint: the
   * frontend already fetches this one early and caches it (`CreateWorkspaceScreen.tsx`/Settings →
   * Domains both need the configured workspace base domain before they can render a preview URL,
   * same "needed before anything else" timing `authProviders` already has). Presentation-only data
   * — a scheme and an optional host[:port], never a secret, never anything RLS/auth-relevant.
   * `workspaceBaseDomain` is `null` when `WORKSPACE_BASE_DOMAIN` isn't configured (the honest
   * local-dev default — see that env var's own doc comment for why this is never guessed from
   * `APP_URL`, which is frequently a bare IP locally).
   */
  @Get('config')
  async config(@Query('org') org?: string): Promise<{
    authProviders: { password: boolean; google: boolean; microsoft: boolean };
    /** Providers that can accept a member invitation (only with the one-time OAuth handoff enabled). */
    invitationProviders: { google: boolean; microsoft: boolean };
    domain: { scheme: 'http' | 'https'; workspaceBaseDomain: string | null };
  }> {
    const effective = org ? await this.organisationAuthProviders.getEffectiveBySlug(org) : this.organisationAuthProviders.systemEnabled();
    const appUrl = new URL(this.env.get('APP_URL'));
    const handoff = this.env.get('AUTH_OAUTH_HANDOFF_ENABLED') === true;
    return {
      authProviders: effective,
      invitationProviders: { google: handoff && effective.google, microsoft: handoff && effective.microsoft },
      domain: {
        scheme: appUrl.protocol === 'https:' ? 'https' : 'http',
        workspaceBaseDomain: this.env.get('WORKSPACE_BASE_DOMAIN') ?? null,
      },
    };
  }

  @MobileApplication()

  @Get('capabilities')
  @UseGuards(JwtAuthGuard)
  async capabilities(@AuthUser() ctx: AuthContext) {
    const flags = [PermissionFlag.STAFF_VIEW, PermissionFlag.SCHEDULE_VIEW,
      PermissionFlag.VENUE_VIEW, PermissionFlag.OFFER_SEND,
      PermissionFlag.REPORT_VIEW, PermissionFlag.STAFFING_REQUEST_CREATE, PermissionFlag.ATTENDANCE_VIEW,
      PermissionFlag.VENUE_MANAGER_CREATE,
      // Display hints for the Venue Manager report screens (Finalise & send, Review hours, Staff review). Every action
      // is still enforced server-side by its own route guard and service check.
      PermissionFlag.REPORT_EXPORT, PermissionFlag.ATTENDANCE_EDIT, PermissionFlag.REVIEW_CREATE,
      // Display hints for the web Users bulk-action bar and account menu (Add Staff, Activate/Deactivate/Delete). The
      // Staff routes keep their own PermissionGuard and service checks.
      PermissionFlag.STAFF_CREATE, PermissionFlag.STAFF_DEACTIVATE,
      // Display hints for the web Payroll page (Approve / Reject / bulk approve). The payroll routes keep their own
      // PermissionGuard and PayrollService re-checks.
      PermissionFlag.PAYROLL_VIEW, PermissionFlag.PAYROLL_APPROVE, PermissionFlag.PAYROLL_CALCULATE, PermissionFlag.PAYROLL_MARK_PAID];
    const entries = await Promise.all(flags.map(async (flag) =>
      [flag, await this.permissions.userHasPermission(ctx, flag)] as const));
    return Object.fromEntries(entries);
  }

  /** Revokes the session whose `crewflow_session` cookie this browser presented at login (if any). Best-effort, never throws. */
  private async supersedePresentedWebSession(request: AuthenticatedRequest): Promise<void> {
    try {
      await this.authService.revokeSupersededWebSession(request.cookies?.[WEB_SESSION_COOKIE_NAME] as string | undefined);
    } catch (error) {
      this.supersedeLogger.warn(`supersede_previous_session_failed reason=${(error as Error).name}`);
    }
  }

  private requestedApplication(request: AuthenticatedRequest): ApplicationTarget | undefined {
    const target = request.headers['x-application-target'];
    if (target === undefined) return this.isMobile(request) ? undefined : 'manager_web';
    if (!APPLICATION_TARGETS.includes(target as ApplicationTarget)) throw new ForbiddenException('Invalid application target.');
    return target as ApplicationTarget;
  }

  private isMobile(request: AuthenticatedRequest): boolean {
    return request.headers[CLIENT_PLATFORM_HEADER] === MOBILE_PLATFORM_VALUE;
  }

  /**
   * Sets the refresh cookie and strips the raw token from the JSON body for
   * a Web caller; leaves the body untouched (refreshToken included, no
   * cookie) for Mobile. `mustResetPassword` (login only) and any other
   * field pass through unchanged either way.
   *
   * P1C.1C: ALSO sets `crewflow_session` — present on `result` only for a genuinely new
   * `manager_web` login, never on `/auth/refresh` (a refresh must not rotate the web credential —
   * FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.9) and never for Mobile (which returns here before this
   * runs at all). Its own Max-Age uses the SAME real family-absolute-expiry clamp as `rab_rt` —
   * never a flat duration, never extended on reload or refresh.
   */
  private respondWithTokens<T extends AuthTokens>(
    request: AuthenticatedRequest,
    response: Response,
    result: T,
  ): Omit<T, 'refreshToken' | 'webSessionToken'> | T {
    if (this.isMobile(request)) return result;

    // Real remaining time until the token's own (already family-clamped)
    // expiry — never the flat 30-day constant. That constant only bounds
    // an individual token's own TTL; using it here would keep resetting
    // the cookie's lifetime to 30 days on every refresh regardless of how
    // close the session's actual absolute deadline is.
    const maxAgeMs = Math.max(0, result.refreshExpiresAt.getTime() - Date.now());
    response.cookie(REFRESH_COOKIE_NAME, result.refreshToken, buildRefreshCookieOptions(this.env.isProduction, maxAgeMs));
    if (result.webSessionToken) {
      // sessionExpiresAt IS the family's absolute deadline — the same ceiling the cookie's own
      // lifetime must never exceed (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.9: "do not calculate a
      // new lifetime independently at cookie issuance").
      const sessionMaxAgeMs = Math.max(0, result.sessionExpiresAt.getTime() - Date.now());
      response.cookie(WEB_SESSION_COOKIE_NAME, result.webSessionToken, buildWebSessionCookieOptions(this.env.isProduction, sessionMaxAgeMs));
    }
    const { refreshToken: _refreshToken, webSessionToken: _webSessionToken, ...rest } = result;
    return rest;
  }

  /**
   * Resolves the presented refresh token from wherever this caller actually
   * put it — Mobile sends it in the body (`dto.refreshToken`); Web relies on
   * the HttpOnly cookie the browser attaches automatically — and reports
   * which one it came from, since that (not the `CLIENT_PLATFORM_HEADER`
   * value, which a test or a misbehaving client could simply omit) is what
   * `assertTrustedOriginForCookieAuth` actually needs to know: a body value
   * was deliberately supplied by whoever's calling, never CSRF-forgeable the
   * way an ambient cookie is, regardless of what platform they claim to be.
   */
  private resolvePresentedRefreshToken(
    request: AuthenticatedRequest,
    dto: RefreshDto,
  ): { token: string | undefined; fromCookie: boolean } {
    if (dto.refreshToken) return { token: dto.refreshToken, fromCookie: false };
    return { token: request.cookies?.[REFRESH_COOKIE_NAME], fromCookie: true };
  }

  /**
   * `/refresh` is the one route Web authenticates using ONLY the ambient
   * cookie — no Bearer token (there isn't one yet) and, since production
   * cross-site cookies need `SameSite=None`, no same-site browser default
   * either. Strict Origin validation is what actually closes the CSRF gap
   * `SameSite=None` opens: the `Origin` header is set by the browser itself
   * and cannot be overridden by page JavaScript on a cross-origin request,
   * so a forged request from an untrusted page either carries no Origin
   * (rejected here) or an Origin this allowlist doesn't contain (also
   * rejected). `/login` has its own check (CF-05, `assertCredentialIssuingRequestProvenance`): a forged
   * cross-site login with the ATTACKER's password would sign the victim's browser into the attacker's account.
   * `/logout` and every other `JwtAuthGuard`-protected mutation now get the SAME Origin check,
   * applied generically inside the guard itself for any unsafe cookie-authenticated request
   * (P1C.1C, `cookie-csrf.util.ts`) — `crewflow_session` became manager_web's primary credential
   * that checkpoint, so logout (and everything else) is typically cookie-authenticated now, not
   * Bearer-only as this comment originally assumed. This method's OWN check remains specific to
   * `/refresh`, which authenticates via the ambient `rab_rt` cookie before `JwtAuthGuard` ever
   * runs — there is no session/bearer credential yet at that point for the guard to check.
   */
  private assertTrustedOriginForCookieAuth(request: AuthenticatedRequest, fromCookie: boolean): void {
    if (!fromCookie) return; // A body-supplied token was never CSRF-forgeable in the first place.
    if (!this.env.isTrustedOrigin(request.headers.origin)) {
      throw new ForbiddenException('Untrusted origin.');
    }
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @RateLimitRequired()
  // CF-05: JSON only, and a present Origin must be trusted, checked before validation and any credential work.
  @UseGuards(CredentialRequestProvenanceGuard)
  async login(
    @Body() dto: LoginDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Omit<LoginResult, 'refreshToken'> | LoginResult> {
    try {
      const result = await this.authService.login(dto, requestMeta(request, this.env.trustedProxyCidrs), this.isMobile(request));
      // Owner decision (2026-10-15): the same rule Google/Microsoft sign-in already applies (F11, Twenty's SUPERSEDED) — a browser
      // that signs in again does not leave the session IT presented alive. Only that one presented session is revoked; every
      // other device stays signed in. Web only (the mobile app never holds the web session cookie). Never fails the login.
      if (!this.isMobile(request)) await this.supersedePresentedWebSession(request);
      return this.respondWithTokens(request, response, result);
    } catch (error) {
      // 429: the login limiter slowed this (email, IP) / account down. 503: the limiter's Redis is unavailable (fail closed).
      if (error instanceof HttpException && (error.getStatus() === 429 || error.getStatus() === 503)) {
        const body = error.getResponse() as { retryAfter?: number };
        if (body.retryAfter) response.setHeader('Retry-After', body.retryAfter);
      }
      throw error;
    }
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @RateLimitRequired()
  async refresh(
    @Body() dto: RefreshDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Omit<AuthTokens, 'refreshToken'> | AuthTokens> {
    // Not the CF-05 JSON rule: the web client refreshes with an empty body (no Content-Type). Refresh is already closed to
    // CSRF: a cookie refresh requires a trusted Origin below, and a body token cannot be supplied by a cross-site page.
    const { token: presentedToken, fromCookie } = this.resolvePresentedRefreshToken(request, dto);
    this.assertTrustedOriginForCookieAuth(request, fromCookie);
    if (!presentedToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const result = await this.authService.refresh(presentedToken, requestMeta(request, this.env.trustedProxyCidrs), this.requestedApplication(request));
    return this.respondWithTokens(request, response, result);
  }

  @MobileApplication()

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async logout(
    @Body() dto: RefreshDto,
    @AuthUser() ctx: AuthContext,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const { token: presentedToken } = this.resolvePresentedRefreshToken(request, dto);
    // Revokes the authenticated session (ctx.sessionId) and, if presented, the refresh-token family — each revokes the
    // refresh family AND the same-row `core.user_session` (whose web-cookie hash lives on that row).
    await this.authService.logout(ctx, presentedToken);
    response.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions(this.env.isProduction));
    // P1C.1C: cookie deletion alone is never logout (the brief's own explicit requirement) — this
    // only removes the browser's copy; the row it pointed to is already revoked above, so a
    // replayed old cookie value fails `SessionValidityService.assertActive` on its very next use
    // regardless of whether this clear ever reaches the browser.
    response.clearCookie(WEB_SESSION_COOKIE_NAME, clearWebSessionCookieOptions(this.env.isProduction));
  }

  @MobileApplication()

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@AuthUser() ctx: AuthContext) {
    return this.authService.me(ctx);
  }

  /** The forced-reset completion step — see AuthService.setPassword's doc comment. */
  @MobileApplication()
  @Post('set-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Throttle(AUTH_THROTTLE)
  @RateLimitRequired()
  async setPassword(@Body() dto: SetPasswordDto, @AuthUser() ctx: AuthContext): Promise<void> {
    await this.authService.setPassword(ctx, dto.newPassword);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(AUTH_THROTTLE)
  @RateLimitRequired()
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() request: AuthenticatedRequest): Promise<void> {
    await this.authService.forgotPassword(dto, this.isMobile(request));
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @RateLimitRequired()
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('activate-account')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @RateLimitRequired()
  async activateAccount(@Body() dto: ActivateAccountDto) {
    return this.authService.activateAccount(dto);
  }
}
