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
import { OAuthInvitationHandlerRegistry, ProviderInvitationSummary } from './oauth-invitation-handler.registry';
import { OAuthIntent, OAuthProvider, OAuthTransactionStateService } from './oauth-transaction-state.service';
import { OidcLoginService } from './oidc-login.service';
import { OidcReauthService, SsoReauthProvider } from './oidc-reauth.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { PROVIDER_SIGN_IN_GENERIC_MESSAGE, ProviderSignInError, ProviderSignInIdentity } from './provider-sign-in.error';

export interface HandoffSummary {
  intent: OAuthIntent;
  provider: OAuthProvider;
  email: string;
  returnTo: string;
  invitation: ProviderInvitationSummary | null;
}

export interface HandoffCompletion {
  mustResetPassword: boolean;
  returnTo: string;
  sessionExpiresAt: string;
}

type RequestWithCookies = Request & { cookies?: Record<string, string | undefined> };

/** The 409 `AuthService.completeLogin` raises when a sign-in now waits for its second factor (carries the challenge). */
function isSecondFactorChallenge(error: unknown): boolean {
  if (!(error instanceof ConflictException)) return false;
  const body = error.getResponse() as { code?: unknown };
  return body?.code === 'SECOND_FACTOR_REQUIRED';
}

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
    private readonly invitations: OAuthInvitationHandlerRegistry,
    private readonly dataSource: DataSource,
    private readonly env: EnvironmentService,
    private readonly reauth: OidcReauthService,
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

  /**
   * Account security step 1 (P6): an authenticated, CSRF-checked (JwtAuthGuard: trusted Origin for a cookie POST) start of
   * an SSO re-authentication for the CURRENT session. A top-level form POST, so the browser-binding cookie is set on a
   * first-party navigation response and the provider redirect is a plain 302. Refusals are audited by OidcReauthService
   * and land on the fixed return path with `?reauth=failed` (never a client-chosen URL).
   */
  async startReauthentication(ctx: AuthContext, provider: SsoReauthProvider, res: Response, returnTo: unknown): Promise<void> {
    const returnPath = this.reauth.returnPathFor(returnTo);
    try {
      const { url, browserSecret } = await this.reauth.start(ctx, provider, returnTo);
      res.cookie(authCookieName('oauthTx', this.cookieMode), browserSecret, authCookieSetOptions('oauthTx', this.cookieMode));
      res.redirect(url);
    } catch (error) {
      this.logger.warn(`oauth_reauth_start_refused provider=${provider} reason=${(error as { response?: { code?: string } })?.response?.code ?? (error as Error).name}`);
      res.redirect(`${this.appUrl}${returnPath}?reauth=failed`);
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
      const { identity, returnToPath, transaction, authTime } = await this.oidcLogin.handleCallback(provider, req.query as Record<string, string>, browserSecret);
      intent = transaction.intent;
      email = identity.email;

      // Account security step 1 (P6): a re-authentication never reaches the sign-in path below — no handoff, no session,
      // no provider link. OidcReauthService validates session binding, auth_time and the linked identity, records the
      // step-up grant, audits, and returns a FIXED same-origin path.
      if (transaction.intent === 'reauthenticate') {
        res.redirect(`${this.appUrl}${await this.reauth.completeCallback(req, provider, identity, transaction, authTime)}`);
        return;
      }

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
      if (!this.handoffEnabled && isSecondFactorChallenge(error)) {
        // Legacy (non-handoff) mode: the account needs its second factor. The challenge token travels in the URL
        // FRAGMENT only — never sent to any server, never in a Referer — and the login page strips it immediately. It is
        // single use, expires in minutes and is useless without the code.
        const body = (error as ConflictException).getResponse() as { challengeToken?: string; requirement?: string };
        res.redirect(`${this.appUrl}/login#mfa=${encodeURIComponent(body.challengeToken ?? '')}&requirement=${encodeURIComponent(body.requirement ?? 'verify')}`);
        return;
      }
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
    return { intent: live.intent, provider: live.provider, email: live.identity.email, returnTo: live.returnToPath, invitation };
  }

  /**
   * Redeems the handoff and issues the session. The caller (controller) has already required a trusted Origin.
   * Order: atomic single-use redemption → intent-specific re-validation and account work → `AuthService.completeLogin`
   * (where the second-factor gate runs) → session cookies.
   *
   * Wave 4 lane MFA: when the account needs a second factor, `completeLogin` turns the redeemed handoff into a
   * single-use MFA challenge (409 SECOND_FACTOR_REQUIRED + challengeToken) and nothing is issued; the browser finishes
   * at `/auth/mfa/challenge/verify`. The pre-consumption policy peek of wave 1 is gone: the handoff is single use either
   * way, and the challenge (bound to the same pending sign-in, including any first-time provider link) replaces it.
   */
  async completeHandoff(req: RequestWithCookies, res: Response): Promise<HandoffCompletion> {
    const mode = this.cookieMode;
    const secret = readAuthCookie(req, 'oauthHandoff', mode);
    const peek = await this.state.peekHandoff(secret);

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
      if (isSecondFactorChallenge(error)) {
        // The handoff is spent; the challenge in this 409 is now the only way to finish this sign-in.
        res.clearCookie(authCookieName('oauthHandoff', mode), authCookieClearOptions('oauthHandoff', mode));
        throw error;
      }
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
