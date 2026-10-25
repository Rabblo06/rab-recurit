import { createHash } from 'node:crypto';

import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { DataSource, EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../audit/audit.service';
import { EnvironmentService } from '../../environment/environment.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { authCookieModeFromEnv, readAuthCookie } from '../constants/auth-cookie-policy';
import { isWellFormedWebSessionToken } from '../constants/web-session-cookie.constants';
import { ConsumedOAuthTransaction, OAuthProvider } from './oauth-transaction-state.service';
import { OidcLoginService, ProviderIdentity } from './oidc-login.service';
import { OrganisationAuthProvidersService } from './organisation-auth-providers.service';
import { StepUpReauthService } from './step-up-reauth.service';
import { UserAuthIdentityService } from './user-auth-identity.service';

export type SsoReauthProvider = OAuthProvider;

/**
 * Which providers can be used for a step-up re-authentication. A provider qualifies only if it can GUARANTEE a fresh,
 * signed `auth_time` for a forced re-authentication (verified against the providers' current documentation,
 * 2026-10-24 — see docs/account-security/STEP1_REPORT.md §P6):
 *
 *  - Microsoft identity platform: `prompt=login` is documented ("forces the user to enter their credentials on that
 *    request, which negates single sign-on"); `auth_time` is an optional ID-token claim that the app registration must
 *    include (optional claims → ID token → auth_time). ENABLED; a token without `auth_time` is refused at the callback,
 *    so a deployment that has not configured the claim fails closed (the re-auth never grants anything).
 *  - Google: the documented `prompt` values are only `none`, `consent` and `select_account` (no `login`), `max_age` is
 *    not documented, and `auth_time` is returned only when requested with the `claims` parameter AND enabled in the
 *    Google "security bundle" settings. Google therefore cannot guarantee a forced fresh login: REFUSED
 *    (409 SSO_REAUTH_UNSUPPORTED). Enabling it is a one-line change here after verifying both on a real Google project.
 */
export const SSO_REAUTH_SUPPORTED: Readonly<Record<SsoReauthProvider, boolean>> = { google: false, microsoft: true };

/** The ONLY places the browser may be sent back to after a re-authentication (fixed, same-origin, relative). */
export const SSO_REAUTH_RETURN_PATHS = ['/settings/account', '/settings/admin', '/settings/profile'] as const;
export const SSO_REAUTH_DEFAULT_RETURN_PATH = '/settings/account';

/** Tolerated clock difference between the provider and this server when comparing `auth_time` (seconds-resolution claim). */
export const SSO_REAUTH_AUTH_TIME_SKEW_MS = 30_000;

type FailureReason =
  | 'transaction_not_reauth'
  | 'session_missing'
  | 'session_mismatch'
  | 'auth_time_missing'
  | 'auth_time_stale'
  | 'auth_time_future'
  | 'identity_mismatch'
  | 'provider_disabled'
  | 'provider_unsupported';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Account security step 1 (P6): "Continue with Microsoft" as the step-up proof for an account that signs in with a
 * provider (it may have no password at all).
 *
 *   start    (authenticated, manager_web, cookie-CSRF-checked POST) — the provider must be supported, linked to THIS
 *            user and enabled for the organisation. Creates an OAuth transaction with intent `reauthenticate` bound to the
 *            user and to sha256(current session id), sets the usual browser-binding cookie, and returns the provider URL
 *            (`prompt=login`, `max_age=0`).
 *   callback (the provider's existing callback route) — the SAME state / browser binding / PKCE / nonce / signature /
 *            iss / aud / exp validation as sign-in (`OidcLoginService.handleCallback`, one-time consumption), then:
 *              1. the browser must present the web session the transaction is bound to (same user, same session hash);
 *              2. `auth_time` is REQUIRED and must be ≥ transaction creation − 30 s skew (and not in the future);
 *              3. the returned identity (provider + subject — Google `sub`, Microsoft `tid:oid`, which encodes the
 *                 issuing tenant) must be an identity ALREADY linked to that same user;
 *              4. the provider must still be enabled for the organisation.
 *            Then a step-up grant (`via: 'sso_reauth'`) is recorded for that session — exactly like a password step-up.
 *            It NEVER creates a session, signs anyone in, issues a handoff or links an identity. Any failure is audited
 *            (`auth.sso_reauth_failed`, reason) and answered with ONE generic redirect.
 *   return   a fixed allowlisted same-origin path (`SSO_REAUTH_RETURN_PATHS`) + `?reauth=ok|failed`; never a client URL.
 */
@Injectable()
export class OidcReauthService {
  private readonly logger = new Logger(OidcReauthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly oidc: OidcLoginService,
    private readonly identities: UserAuthIdentityService,
    private readonly providers: OrganisationAuthProvidersService,
    private readonly stepUp: StepUpReauthService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
    private readonly env: EnvironmentService,
  ) {}

  /** Providers linked to this user (`manager` bound to the user's own tenant context). */
  async linkedProviders(manager: EntityManager, userId: string): Promise<SsoReauthProvider[]> {
    const rows = await manager.query<Array<{ provider: string }>>('SELECT provider FROM core.user_auth_identity WHERE user_id = $1 ORDER BY provider', [userId]);
    return rows.map((r) => r.provider).filter((p): p is SsoReauthProvider => p === 'google' || p === 'microsoft');
  }

  /** Linked providers this account can re-authenticate with right now (supported + enabled for its organisation). */
  async availableProviders(ctx: AuthContext, linked: readonly SsoReauthProvider[]): Promise<SsoReauthProvider[]> {
    const supported = linked.filter((p) => SSO_REAUTH_SUPPORTED[p]);
    if (supported.length === 0) return [];
    const effective = await this.providers.getEffective(ctx);
    return supported.filter((p) => effective[p] === true);
  }

  /** Only an allowlisted path; anything else (absolute, protocol-relative, other paths, query strings) → the default. */
  returnPathFor(requested: unknown): string {
    return typeof requested === 'string' && (SSO_REAUTH_RETURN_PATHS as readonly string[]).includes(requested) ? requested : SSO_REAUTH_DEFAULT_RETURN_PATH;
  }

  async start(ctx: AuthContext, provider: SsoReauthProvider, returnTo: unknown): Promise<{ url: string; browserSecret: string }> {
    if (ctx.inspectedBy) throw new ForbiddenException('This is not available while inspecting another account.');
    // Layer 2: the controller is @ManagerApplication, and a re-authentication is a browser round trip by nature.
    if (!ctx.sessionId || (ctx.applicationTarget !== undefined && ctx.applicationTarget !== 'manager_web')) {
      throw new ForbiddenException({ code: 'APPLICATION_ROUTE_DENIED', message: 'This action is not available in this app.' });
    }
    if (!SSO_REAUTH_SUPPORTED[provider]) {
      await this.recordFailure(ctx.userId, ctx.organisationId, provider, 'provider_unsupported');
      throw new ConflictException({ code: 'SSO_REAUTH_UNSUPPORTED', message: 'Confirming your identity with this provider isn’t available. Use your password instead.' });
    }
    const linked = await this.tenantContext.runInTenantContext(ctx, (manager) => this.linkedProviders(manager, ctx.userId));
    if (!(await this.availableProviders(ctx, linked)).includes(provider)) {
      await this.recordFailure(ctx.userId, ctx.organisationId, provider, linked.includes(provider) ? 'provider_disabled' : 'identity_mismatch');
      throw new ConflictException({ code: 'SSO_REAUTH_UNAVAILABLE', message: 'You can’t confirm your identity with this provider. Use another sign-in method.' });
    }
    return this.oidc.buildAuthorizationUrl(provider, {
      intent: 'reauthenticate',
      returnToPath: this.returnPathFor(returnTo),
      reauth: { userId: ctx.userId, organisationId: ctx.organisationId!, sessionIdHash: sha256(ctx.sessionId) },
    });
  }

  /**
   * Finishes a callback whose transaction has intent `reauthenticate` (already consumed and fully validated by
   * `OidcLoginService.handleCallback`). Returns the same-origin path to redirect to. Never throws: every refusal is
   * audited and becomes `?reauth=failed` on the fixed return path.
   */
  async completeCallback(
    req: Request & { cookies?: Record<string, string | undefined> },
    provider: OAuthProvider,
    identity: ProviderIdentity,
    transaction: ConsumedOAuthTransaction,
    authTime: number | null,
  ): Promise<string> {
    const returnPath = this.returnPathFor(transaction.returnToPath);
    const binding = transaction.reauth;
    if (transaction.intent !== 'reauthenticate' || !binding) {
      this.logger.warn(`sso_reauth_failed provider=${provider} reason=transaction_not_reauth`);
      return `${returnPath}?reauth=failed`;
    }
    const fail = async (reason: FailureReason) => {
      await this.recordFailure(binding.userId, binding.organisationId, provider, reason);
      return `${returnPath}?reauth=failed`;
    };
    try {
      // 1. The browser finishing the round trip holds the very session the re-authentication was started for.
      const presented = readAuthCookie(req, 'session', authCookieModeFromEnv(this.env));
      if (!isWellFormedWebSessionToken(presented)) return await fail('session_missing');
      const [session] = await this.dataSource.query<Array<{ sessionId: string; userId: string }>>('SELECT "sessionId", "userId" FROM core.auth_find_session_by_web_token_hash($1)', [sha256(presented)]);
      if (!session || session.userId !== binding.userId || sha256(session.sessionId) !== binding.sessionIdHash) return await fail('session_mismatch');

      // 2. A FRESH authentication at the provider, proven by the signed auth_time claim.
      if (authTime === null) return await fail('auth_time_missing');
      const authTimeMs = authTime * 1000;
      if (authTimeMs < transaction.createdAt.getTime() - SSO_REAUTH_AUTH_TIME_SKEW_MS) return await fail('auth_time_stale');
      if (authTimeMs > Date.now() + SSO_REAUTH_AUTH_TIME_SKEW_MS) return await fail('auth_time_future');

      // 3. The SAME identity that is already linked to this user (never a new link, never another account).
      const linked = await this.identities.findLinkedUser(provider, identity.subject);
      if (!linked || linked.userId !== binding.userId || linked.organisationId !== binding.organisationId) return await fail('identity_mismatch');

      // 4. The provider is still allowed for this organisation (an admin may have switched it off meanwhile).
      const ctx: AuthContext = { organisationId: binding.organisationId, workspaceId: null, userId: binding.userId, role: '' };
      if (!(await this.availableProviders(ctx, [provider])).includes(provider)) return await fail('provider_disabled');

      await this.stepUp.recordSsoReauthGrant(binding.sessionIdHash, binding.userId);
      await this.tenantContext.runInTenantContext(ctx, (manager) =>
        this.audit.record(manager, ctx, AuditAction.STEP_UP_SUCCEEDED, { targetUserId: binding.userId, metadata: { method: 'sso_reauth', provider } }),
      );
      return `${returnPath}?reauth=ok`;
    } catch (error) {
      this.logger.warn(`sso_reauth_failed provider=${provider} reason=error ${(error as Error)?.name ?? 'unknown'}`);
      return `${returnPath}?reauth=failed`;
    }
  }

  /** Audited in the user's organisation, in its own transaction; never throws. */
  private async recordFailure(userId: string, organisationId: string | null, provider: OAuthProvider, reason: FailureReason): Promise<void> {
    this.logger.warn(`sso_reauth_failed provider=${provider} reason=${reason}`);
    if (!organisationId) return;
    const ctx: AuthContext = { organisationId, workspaceId: null, userId, role: '' };
    try {
      await this.tenantContext.runInTenantContext(ctx, (manager) => this.audit.record(manager, ctx, AuditAction.SSO_REAUTH_FAILED, { targetUserId: userId, metadata: { reason, provider } }));
    } catch (error) {
      this.logger.warn(`sso re-auth failure audit not written: ${(error as Error).message}`);
    }
  }
}
