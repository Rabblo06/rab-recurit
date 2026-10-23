import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { DataSource } from 'typeorm';

import { resolveClientIp } from '../../../utils/client-ip.util';
import { EnvironmentService } from '../../environment/environment.service';
import {
  AuthCookieMode,
  authCookieClearOptions,
  authCookieModeFromEnv,
  authCookieName,
  authCookieSetOptions,
  clearLegacyAuthCookieIfPresent,
  presentedWebSessionTokens,
  readAuthCookie,
} from '../constants/auth-cookie-policy';
import { AuthService, LoginResult } from './auth.service';
import { LoginSecondFactorPolicyService } from './login-second-factor-policy.service';
import { OAuthInvitationHandlerRegistry, ProviderInvitationSummary } from './oauth-invitation-handler.registry';
import { OAuthIntent, OAuthProvider, OAuthTransactionStateService } from './oauth-transaction-state.service';
import { OidcLoginService } from './oidc-login.service';
import { PROVIDER_SIGN_IN_GENERIC_MESSAGE, ProviderSignInError, ProviderSignInIdentity } from './provider-sign-in.error';

export interface HandoffSummary {
  intent: OAuthIntent;
  provider: OAuthProvider;
  email: string;
  returnTo: string;
  /** Second factor still required before a session can be issued (always 'none' until TOTP exists). */
  secondFactor: 'none' | 'verify' | 'enroll';
  invitation: ProviderInvitationSummary | null;
}

export interface HandoffCompletion {
  mustResetPassword: boolean;
  returnTo: string;
  sessionExpiresAt: string;
}

type RequestWithCookies = Request & { cookies?: Record<string, string | undefined> };

/**
 * Google/Microsoft sign-in, end to end (TWENTY_GOOGLE_AUTH_GAP_ANALYSIS.md §4). Shared by both provider controllers
 * and the handoff controller so the two providers can never drift apart.
 *
 *   start     → OAuth transaction (state, PKCE, nonce, return path) + `crewflow_oauth_tx` browser-binding cookie.
 *   callback  → browser-bound one-time state consumption, full openid-client validation, account resolution.
 *               Handoff mode (AUTH_OAUTH_HANDOFF_ENABLED): issue a 5-minute single-use handoff as an HttpOnly cookie
 *               and redirect with NO credential in the URL. Legacy mode: issue the session here, as before.
 *   complete  → (handoff mode) Origin-checked POST; second-factor gate; atomic redemption; re-validation of the
 *               account, provider settings, invitation and workspace membership; session cookies; supersedes any
 *               session this browser already held.
 *
 * Failures are uniform for the browser (`/login?oauthError=1` or one generic 401) and specific in the security log
 * plus a `login_history` failure row (audit F7).
 */
@Injectable()
export class OAuthSignInFlowService {
  private readonly logger = new Logger('OAuthSignIn');

  constructor(
    private readonly oidcLogin: OidcLoginService,
    private readonly state: OAuthTransactionStateService,
    private readonly authService: AuthService,
    private readonly secondFactor: LoginSecondFactorPolicyService,
    private readonly invitations: OAuthInvitationHandlerRegistry,
    private readonly dataSource: DataSource,
    private readonly env: EnvironmentService,
  ) {}

  /**
   * Wave 2 lane A2: legacy names, or `__Host-` names (AUTH_COOKIE_HOST_PREFIX_ENABLED). The OAuth cookies are short-lived
   * (10 / 5 min) and have NO legacy fallback in host mode: an un-prefixed tx/handoff cookie is exactly what a sibling host
   * could plant to finish a sign-in in the victim's browser, so a sign-in in flight at the switch simply has to restart.
   */
  private get cookieMode(): AuthCookieMode {
    return authCookieModeFromEnv(this.env);
  }

  get handoffEnabled(): boolean {
    return this.env.get('AUTH_OAUTH_HANDOFF_ENABLED') === true;
  }

  private get appUrl(): string {
    return this.env.get('APP_URL');
  }

  private meta(req: Request) {
    return { ip: resolveClientIp(req, this.env.trustedProxyCidrs), userAgent: req.headers['user-agent'] };
  }

  // ── start ────────────────────────────────────────────────────────────────────────────────────────────────

  async start(
    provider: OAuthProvider,
    res: Response,
    options: { returnTo?: string; intent?: OAuthIntent; invitationToken?: string } = {},
  ): Promise<void> {
    const errorTarget = options.intent === 'accept_invitation' ? `${this.appUrl}/accept-invitation?oauthError=1` : `${this.appUrl}/login?oauthError=1`;
    try {
      let invitationTokenHash: string | undefined;
      if (options.intent === 'accept_invitation') {
        // Accepting with a provider issues a session at the end, so it only exists in handoff mode.
        const handler = this.invitations.get();
        if (!this.handoffEnabled || !handler || typeof options.invitationToken !== 'string' || options.invitationToken.length < 20 || options.invitationToken.length > 128) {
          throw new ProviderSignInError('invitation_invalid');
        }
        invitationTokenHash = handler.hashToken(options.invitationToken);
      }
      const { url, browserSecret } = await this.oidcLogin.buildAuthorizationUrl(provider, {
        returnToPath: options.returnTo,
        intent: options.intent,
        invitationTokenHash,
      });
      res.cookie(authCookieName('oauthTx', this.cookieMode), browserSecret, authCookieSetOptions('oauthTx', this.cookieMode));
      res.redirect(url);
    } catch (error) {
      // Audit F6: a discovery/database failure becomes the normal error page, never a raw 500.
      this.logger.warn(`oauth_start_failed provider=${provider} reason=${(error as ProviderSignInError).reason ?? (error as Error).name}`);
      res.redirect(errorTarget);
    }
  }

  // ── callback ─────────────────────────────────────────────────────────────────────────────────────────────

  async callback(provider: OAuthProvider, req: RequestWithCookies, res: Response): Promise<void> {
    const mode = this.cookieMode;
    const browserSecret = readAuthCookie(req, 'oauthTx', mode);
    res.clearCookie(authCookieName('oauthTx', mode), authCookieClearOptions('oauthTx', mode));
    clearLegacyAuthCookieIfPresent(req, res, 'oauthTx', mode);
    let intent: OAuthIntent = 'sign_in';
    let email: string | null = null;
    try {
      if (typeof req.query.error === 'string') throw new ProviderSignInError('no_eligible_account');
      const { identity, returnToPath, transaction } = await this.oidcLogin.handleCallback(provider, req.query as Record<string, string>, browserSecret);
      intent = transaction.intent;
      email = identity.email;

      if (!this.handoffEnabled) {
        const result = await this.authService.signInWithProvider(provider, identity, this.meta(req));
        await this.supersedePresentedSession(req);
        this.setSessionCookies(req, res, result);
        res.redirect(`${this.appUrl}/oauth/callback-complete?mustResetPassword=${result.mustResetPassword}&returnTo=${encodeURIComponent(returnToPath)}`);
        return;
      }

      let resolvedUserId: string | null = null;
      if (transaction.intent === 'accept_invitation') {
        const handler = this.invitations.get();
        if (!handler || !transaction.invitationTokenHash || !(await handler.describe(transaction.invitationTokenHash, identity))) {
          throw new ProviderSignInError('invitation_invalid');
        }
      } else {
        // Fail early (and audit) at the callback; redemption re-runs the same resolution.
        resolvedUserId = (await this.authService.resolveProviderUser(provider, identity)).user.id;
      }
      const secret = await this.state.issueHandoff(transaction.id, identity, resolvedUserId);
      res.cookie(authCookieName('oauthHandoff', mode), secret, authCookieSetOptions('oauthHandoff', mode));
      // No credential, email or account detail in the URL — the handoff travels only in its HttpOnly cookie.
      res.redirect(`${this.appUrl}/oauth/callback-complete?handoff=1`);
    } catch (error) {
      await this.recordFailure(provider, email, error, 'callback');
      res.redirect(intent === 'accept_invitation' ? `${this.appUrl}/accept-invitation?oauthError=1` : `${this.appUrl}/login?oauthError=1`);
    }
  }

  // ── handoff ──────────────────────────────────────────────────────────────────────────────────────────────

  /** What the web app shows before completing (e.g. "Join Northwind as Supervisor"). Never consumes the handoff. */
  async describeHandoff(req: RequestWithCookies): Promise<HandoffSummary> {
    const live = await this.state.peekHandoff(readAuthCookie(req, 'oauthHandoff', this.cookieMode));
    if (!live) throw new UnauthorizedException(PROVIDER_SIGN_IN_GENERIC_MESSAGE);
    let invitation: ProviderInvitationSummary | null = null;
    if (live.intent === 'accept_invitation') {
      invitation = (live.invitationTokenHash && (await this.invitations.get()?.describe(live.invitationTokenHash, live.identity))) || null;
      if (!invitation) throw new UnauthorizedException(PROVIDER_SIGN_IN_GENERIC_MESSAGE);
    }
    const secondFactor = live.resolvedUserId ? await this.secondFactor.requirementFor({ userId: live.resolvedUserId, organisationId: null }) : 'none';
    return { intent: live.intent, provider: live.provider, email: live.identity.email, returnTo: live.returnToPath, secondFactor, invitation };
  }

  /**
   * Redeems the handoff and issues the session. The caller (controller) has already required a trusted Origin.
   * Order: second-factor gate (before consumption, so a future factor step can still use the handoff) → atomic
   * single-use redemption → intent-specific re-validation and account work → session cookies.
   */
  async completeHandoff(req: RequestWithCookies, res: Response): Promise<HandoffCompletion> {
    const mode = this.cookieMode;
    const secret = readAuthCookie(req, 'oauthHandoff', mode);
    const peek = await this.state.peekHandoff(secret);
    if (peek?.resolvedUserId) {
      const requirement = await this.secondFactor.requirementFor({ userId: peek.resolvedUserId, organisationId: null });
      if (requirement !== 'none') {
        throw new ConflictException({ code: 'SECOND_FACTOR_REQUIRED', requirement, message: 'Additional verification is required to finish signing in.' });
      }
    }

    let provider: OAuthProvider = peek?.provider ?? 'google';
    let email: string | null = peek?.identity.email ?? null;
    try {
      const handoff = await this.state.redeemHandoff(secret);
      res.clearCookie(authCookieName('oauthHandoff', mode), authCookieClearOptions('oauthHandoff', mode));
      clearLegacyAuthCookieIfPresent(req, res, 'oauthHandoff', mode);
      provider = handoff.provider;
      email = handoff.identity.email;
      // The email proof (Google email_verified / Microsoft xms_edov) recorded at the callback travels with the handoff.
      const identity: ProviderSignInIdentity = handoff.identity;
      let result: LoginResult;
      if (handoff.intent === 'accept_invitation') {
        const handler = this.invitations.get();
        if (!handler || !handoff.invitationTokenHash) throw new ProviderSignInError('invitation_invalid');
        const { userId } = await handler.accept(handoff.invitationTokenHash, provider, identity, this.meta(req).ip ?? 'unknown');
        result = await this.authService.completeProviderSignIn(provider, identity, userId, this.meta(req));
      } else {
        // `resolvedUserId` was fixed at the callback; the account resolved NOW must be the same one.
        result = await this.authService.completeProviderSignIn(provider, identity, handoff.resolvedUserId, this.meta(req));
      }
      await this.supersedePresentedSession(req);
      this.setSessionCookies(req, res, result);
      return { mustResetPassword: result.mustResetPassword, returnTo: handoff.returnToPath, sessionExpiresAt: result.sessionExpiresAt.toISOString() };
    } catch (error) {
      await this.recordFailure(provider, email, error, 'complete');
      throw new UnauthorizedException(PROVIDER_SIGN_IN_GENERIC_MESSAGE);
    }
  }

  /** Abandons a handoff (user clicked Cancel on the confirmation screen). */
  async cancelHandoff(req: RequestWithCookies, res: Response): Promise<void> {
    try {
      await this.state.redeemHandoff(readAuthCookie(req, 'oauthHandoff', this.cookieMode));
    } catch {
      // Already used, expired or absent — nothing to cancel.
    }
    res.clearCookie(authCookieName('oauthHandoff', this.cookieMode), authCookieClearOptions('oauthHandoff', this.cookieMode));
    clearLegacyAuthCookieIfPresent(req, res, 'oauthHandoff', this.cookieMode);
  }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────

  /** Same names/attributes as AuthController.respondWithTokens (auth-cookie-policy.ts); host mode also drops legacy copies. */
  private setSessionCookies(req: RequestWithCookies, res: Response, result: LoginResult): void {
    const mode = this.cookieMode;
    const maxAgeMs = Math.max(0, result.refreshExpiresAt.getTime() - Date.now());
    res.cookie(authCookieName('refresh', mode), result.refreshToken, authCookieSetOptions('refresh', mode, maxAgeMs));
    clearLegacyAuthCookieIfPresent(req, res, 'refresh', mode);
    if (result.webSessionToken) {
      const sessionMaxAgeMs = Math.max(0, result.sessionExpiresAt.getTime() - Date.now());
      res.cookie(authCookieName('session', mode), result.webSessionToken, authCookieSetOptions('session', mode, sessionMaxAgeMs));
      clearLegacyAuthCookieIfPresent(req, res, 'session', mode);
    }
  }

  /** Twenty parity (SUPERSEDED): a browser that signs in again does not leave its previous session alive. */
  private async supersedePresentedSession(req: RequestWithCookies): Promise<void> {
    for (const token of presentedWebSessionTokens(req, this.cookieMode)) {
      try {
        await this.authService.revokeSupersededWebSession(token);
      } catch (error) {
        this.logger.warn(`supersede_previous_session_failed reason=${(error as Error).name}`);
      }
    }
  }

  /** Audit F7: specific reason to the security log, a provider-tagged failure row in login_history. Never throws. */
  private async recordFailure(provider: OAuthProvider, email: string | null, error: unknown, stage: 'callback' | 'complete'): Promise<void> {
    const reason = error instanceof ProviderSignInError ? error.reason : (error as Error)?.message?.includes('expired or was already used') ? 'state_invalid' : (error as Error)?.name ?? 'unknown';
    this.logger.warn(`oauth_sign_in_failed provider=${provider} stage=${stage} reason=${reason}`);
    try {
      await this.dataSource.query(
        `INSERT INTO core.login_history (organisation_id, user_id, email, ip, user_agent, success, provider) VALUES (NULL, NULL, $1, NULL, NULL, false, $2)`,
        [email ? email.toLowerCase().slice(0, 320) : '', provider],
      );
    } catch {
      // Observability must never turn a refused sign-in into a 500.
    }
  }
}
