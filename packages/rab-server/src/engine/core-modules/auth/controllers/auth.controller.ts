import { Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';

import { AuthUser } from '../../../decorators/auth-user.decorator';
import { EnvironmentService } from '../../environment/environment.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import {
  buildRefreshCookieOptions,
  clearRefreshCookieOptions,
  CLIENT_PLATFORM_HEADER,
  MOBILE_PLATFORM_VALUE,
  REFRESH_COOKIE_NAME,
} from '../constants/refresh-cookie.constants';
import { ActivateAccountDto } from '../dto/activate-account.dto';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import { LoginDto } from '../dto/login.dto';
import { RefreshDto } from '../dto/refresh.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';
import { SetPasswordDto } from '../dto/set-password.dto';
import { AuthenticatedRequest, JwtAuthGuard } from '../guards/jwt-auth.guard';
import { REFRESH_TOKEN_TTL_MS } from '../token/services/refresh-token.service';
import { AuthService, AuthTokens, LoginResult } from '../services/auth.service';

function requestMeta(request: AuthenticatedRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

/**
 * 5 req/min/IP — tight enough to blunt credential stuffing and forgot/reset-
 * password abuse, loose enough that a genuine user mistyping their password
 * a few times in a row never sees it. IP-scoped, on top of (not instead of)
 * `AuthService.login`'s existing per-account lockout — see RabThrottlerModule.
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
  constructor(
    private readonly authService: AuthService,
    private readonly env: EnvironmentService,
  ) {}

  private isMobile(request: AuthenticatedRequest): boolean {
    return request.headers[CLIENT_PLATFORM_HEADER] === MOBILE_PLATFORM_VALUE;
  }

  /**
   * Sets the refresh cookie and strips the raw token from the JSON body for
   * a Web caller; leaves the body untouched (refreshToken included, no
   * cookie) for Mobile. `mustResetPassword` (login only) and any other
   * field pass through unchanged either way.
   */
  private respondWithTokens<T extends AuthTokens>(
    request: AuthenticatedRequest,
    response: Response,
    result: T,
  ): Omit<T, 'refreshToken'> | T {
    if (this.isMobile(request)) return result;

    response.cookie(
      REFRESH_COOKIE_NAME,
      result.refreshToken,
      buildRefreshCookieOptions(this.env.isProduction, REFRESH_TOKEN_TTL_MS),
    );
    const { refreshToken: _refreshToken, ...withoutRefreshToken } = result;
    return withoutRefreshToken;
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
   * rejected). `/login` needs no equivalent check — a forged cross-site
   * login POST still can't succeed without the victim's real password.
   * `/logout` needs none either — it's `JwtAuthGuard`-protected, requiring a
   * real `Authorization: Bearer` header, which a classic cross-site request
   * (form POST or credentialed fetch from an untrusted origin, blocked by
   * CORS from ever setting a custom header here) cannot supply.
   */
  private assertTrustedOriginForCookieAuth(request: AuthenticatedRequest, fromCookie: boolean): void {
    if (!fromCookie) return; // A body-supplied token was never CSRF-forgeable in the first place.
    const origin = request.headers.origin;
    if (!origin || !this.env.corsOrigins.includes(origin)) {
      throw new ForbiddenException('Untrusted origin.');
    }
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  async login(
    @Body() dto: LoginDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Omit<LoginResult, 'refreshToken'> | LoginResult> {
    const result = await this.authService.login(dto, requestMeta(request));
    return this.respondWithTokens(request, response, result);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  async refresh(
    @Body() dto: RefreshDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Omit<AuthTokens, 'refreshToken'> | AuthTokens> {
    const { token: presentedToken, fromCookie } = this.resolvePresentedRefreshToken(request, dto);
    this.assertTrustedOriginForCookieAuth(request, fromCookie);
    if (!presentedToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const result = await this.authService.refresh(presentedToken, requestMeta(request));
    return this.respondWithTokens(request, response, result);
  }

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
    if (presentedToken) {
      await this.authService.logout(ctx, presentedToken);
    }
    response.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions(this.env.isProduction));
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@AuthUser() ctx: AuthContext) {
    return this.authService.me(ctx);
  }

  /** The forced-reset completion step — see AuthService.setPassword's doc comment. */
  @Post('set-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Throttle(AUTH_THROTTLE)
  async setPassword(@Body() dto: SetPasswordDto, @AuthUser() ctx: AuthContext): Promise<void> {
    await this.authService.setPassword(ctx, dto.newPassword);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(AUTH_THROTTLE)
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    await this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(AUTH_THROTTLE)
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.authService.resetPassword(dto);
  }

  @Post('activate-account')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(AUTH_THROTTLE)
  async activateAccount(@Body() dto: ActivateAccountDto): Promise<void> {
    await this.authService.activateAccount(dto);
  }
}
