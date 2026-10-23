import { ApplicationTarget, applicationAllowed, applicationDenied, defaultApplication, memberWithoutWorkspace, passwordExemptForMobileWorkforce } from '../application-access';
import { assertTransition, checkPasswordStrength, EmailOutboxJobType, normalizeEmail, PasswordResetTokenPurpose, USER_STATUS_TRANSITIONS, UserStatus } from '@rab/shared';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { Organisation, Role, User, UserRole } from '../../../../modules/identity/entities';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { EnvironmentService } from '../../environment/environment.service';
import { EmailOutboxService } from '../../email/email-outbox.service';
import { EmailQueueService } from '../../email/email-queue.service';
import { renderPasswordResetEmail, renderPasswordUpdatedEmail, renderWelcomeEmail } from '../../email/templates';
import { AuthContext } from '../../tenant/auth-context.interface';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { WorkspaceResolverService } from '../../tenant/workspace-resolver.service';
import { PlatformAdminService } from '../../platform-admin/platform-admin.service';
import { AccountInviteService } from './account-invite.service';
import { OrganisationAuthProvidersService } from './organisation-auth-providers.service';
import { SecurityVersionService } from './security-version.service';
import { UserAuthIdentityService } from './user-auth-identity.service';
import { PasswordResetTokenService } from '../token/services/password-reset-token.service';
import { RefreshTokenReuseError } from '../token/services/refresh-token-reuse.error';
import { RefreshTokenService } from '../token/services/refresh-token.service';
import { AccessTokenService } from '../token/services/access-token.service';
import { PasswordHashingService } from './password-hashing.service';
import { ProviderSignInError, ProviderSignInIdentity } from './provider-sign-in.error';
import { isWellFormedWebSessionToken } from '../constants/web-session-cookie.constants';
import { LoginAttemptLimiterService } from './login-attempt-limiter.service';
import { LoginSecondFactorPolicyService } from './login-second-factor-policy.service';
import { MfaChallengeService, PendingLogin, PendingProviderLink } from './mfa-challenge.service';
import type { WorkspaceHostContext } from '../../workspace-host/workspace-host.types';

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
  /** W6-E2E-02: the request's workspace-host routing context (server-derived by WorkspaceHostMiddleware), when known. */
  workspaceHost?: WorkspaceHostContext;
}

/**
 * W6-E2E-02: the 404 code of a sign-in refused because it was attempted on a workspace host that is not the account's
 * own. Distinct from WORKSPACE_HOST_MISMATCH (an existing session used from the wrong host): here no session exists.
 */
export const WORKSPACE_HOST_SIGN_IN_REFUSED = 'WORKSPACE_HOST_SIGN_IN_REFUSED';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** The refresh token's own expiry, already clamped to the absolute session ceiling — the Web cookie's maxAge is derived from this, never a flat constant. */
  refreshExpiresAt: Date;
  /**
   * P1C.1C — the raw `crewflow_session` credential, present only for a genuinely new
   * `manager_web` login (never on `/auth/refresh`, never for mobile) — see
   * `RefreshTokenService.IssuedRefreshToken`'s own doc comment. `AuthController` sets it as the
   * HttpOnly cookie and strips it from the JSON body, exactly like `refreshToken` for Web.
   */
  webSessionToken?: string;
  /**
   * PHASE 10 §26/§53 — the session family's absolute deadline, exposed as
   * plain non-secret metadata so a client can schedule its OWN UX deadline
   * (redirect to /login, invalidate a locally-cached "authenticated"
   * presentation) without polling. Never a credential — knowing this
   * timestamp grants no access; the server remains the sole authority via
   * `SessionValidityService`, checked on every request regardless of
   * whether any client ever reads or acts on this value.
   */
  sessionExpiresAt: Date;
}

export interface LoginResult extends AuthTokens {
  mustResetPassword: boolean;
}

/** Wave 4 lane MFA — options of the one session-issuing convergence point. Never derived from a client request. */
interface CompleteLoginOptions {
  /**
   * A first-time Google/Microsoft link (or a last-used touch) to write inside the session transaction, after every access
   * gate (audit F10). Serialisable on purpose: when the second factor interrupts the sign-in, the SAME link travels with
   * the challenge and is written only when the session is finally issued.
   */
  providerLink?: PendingProviderLink | null;
  /** Set ONLY by `completeChallengedLogin`, after `MfaLoginService` verified the factor and consumed the challenge. */
  secondFactorVerified?: boolean;
}

/** Shape returned by `core.auth_find_users_by_email` — see PreAuthLookupFunctions1786667400000. */
interface LoginCandidate {
  id: string;
  organisationId: string;
  email: string;
  // Nullable since AccountInviteSchema1786670100000 — a pending (INVITED)
  // account created under the invitation flow has no password yet.
  passwordHash: string | null;
  status: string;
  mustResetPassword: boolean;
  firstName: string;
}

/**
 * Login is the one flow that runs BEFORE any tenant context exists — see
 * the SECURITY TRADE-OFF note on IdentitySchema1786665800000. Everything
 * else (refresh, logout) already has a token to derive context from, so it
 * runs inside `runInTenantContext` like any other service.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly passwordHashing: PasswordHashingService,
    private readonly accessTokenService: AccessTokenService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly passwordResetTokenService: PasswordResetTokenService,
    private readonly emailOutbox: EmailOutboxService,
    private readonly emailQueue: EmailQueueService,
    private readonly auditService: AuditService,
    private readonly env: EnvironmentService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly workspaceResolver: WorkspaceResolverService,
    private readonly accountInviteService: AccountInviteService,
    private readonly userAuthIdentity: UserAuthIdentityService,
    private readonly organisationAuthProviders: OrganisationAuthProvidersService,
    private readonly securityVersion: SecurityVersionService,
    private readonly loginLimiter: LoginAttemptLimiterService,
    private readonly secondFactor: LoginSecondFactorPolicyService,
    private readonly mfaChallenges: MfaChallengeService,
  ) {}

  /**
   * A security notice, queued (never inline) — the password change itself
   * has already committed by the time this is called; delivery of the
   * notice never gates or blocks that. Never called for the very first
   * password an account ever gets (see `resetPassword`'s `INITIAL_SETUP`
   * branch, which sends a welcome email instead).
   */
  private async sendPasswordUpdatedEmail(manager: EntityManager, organisationId: string, userId: string, email: string, firstName: string): Promise<void> {
    const rendered = renderPasswordUpdatedEmail({ firstName });
    const row = await this.emailOutbox.enqueue(manager, {
      organisationId,
      jobType: EmailOutboxJobType.PASSWORD_UPDATED,
      recipientEmail: email,
      targetUserId: userId,
      rendered,
    });
    void this.emailOutbox.tryFastPublish((id, orgId) => this.emailQueue.publish(id, orgId), row);
  }

  private dummyHashPromise: Promise<string> | null = null;
  /** Computed once, reused for every "user not found" login — so a wrong email costs the same CPU time as a wrong password. */
  private getDummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = this.passwordHashing.hash(randomBytes(32).toString('hex'));
    }
    return this.dummyHashPromise;
  }

  /**
   * No organisation slug on the way in — `email` is only unique per-org
   * (`(organisation_id, email)`, see IdentitySchema), so more than one
   * candidate row is possible when the same email is registered under two
   * different organisations. SECURITY TRADE-OFF: rather than ask which org
   * up front, every candidate's password hash is checked and whichever one
   * matches determines the org — fail-closed and non-enumerating exactly
   * like the single-candidate case, just resolved by password instead of a
   * slug. (The only behavioural difference from a single-org email: with
   * 2+ candidates, checking them in sequence means a very small timing
   * signal about which one matched — irrelevant in practice, since
   * matching at all already requires the correct password for that org.)
   */
  async login(dto: { email: string; password: string; applicationTarget?: ApplicationTarget }, meta: RequestMeta, mobile = false): Promise<LoginResult> {
    // Explicit, matching the one shared normalization used everywhere else
    // an email is looked up (Manager/Staff creation, invitation, forgot-
    // password, duplicate checks) — functionally redundant with `email`
    // being `citext` (case-insensitive already) once `LoginDto` has trimmed
    // it, but explicit here too rather than relying on two different
    // mechanisms to coincidentally agree.
    const email = normalizeEmail(dto.email);
    // Wave 1 lane A (finding D-A1): the old per-EMAIL hard lockout (10 failures ⇒ everyone refused for 15 minutes,
    // checked before the password) let anyone lock any known address out indefinitely. Attempts are now slowed per
    // (email, client IP), with an account-wide ceiling that only applies to addresses that have not signed in to this
    // account before — see LoginAttemptLimiterService. Runs before the account lookup for EVERY submitted address, so
    // an unknown email is throttled exactly like a real one (a distinct, honest 429 message is fine: being slowed down is
    // not the secret the uniform wrong-credentials response protects). Redis unavailable ⇒ 503, never unlimited.
    await this.loginLimiter.admit(email, meta.ip);

    // Raw, parameterized call into the SECURITY DEFINER function from
    // PreAuthLookupFunctions1786667400000 — see that migration's own doc
    // comment for why a plain unscoped read against this table no longer
    // works under the app's real runtime role (rab_app).
    const candidates = await this.dataSource.query<LoginCandidate[]>(
      'SELECT * FROM core.auth_find_users_by_email($1)',
      [email],
    );

    // Wrong-email and wrong-password must be indistinguishable in timing
    // and message — always run at least one argon2 verify, against a real
    // hash if any candidate exists, a dummy one otherwise.
    let matched: LoginCandidate | null = null;
    // Organisation isolation (2026-10-15): email is not globally unique, so EVERY candidate is checked. Two accounts in different
    // organisations that both accept this password are ambiguous — refused (fail closed, the same rule provider sign-in already
    // applies as `ambiguous_accounts`), never silently signed into whichever row happened to come first.
    let ambiguous = false;
    if (candidates.length === 0) {
      await this.passwordHashing.verify(await this.getDummyHash(), dto.password);
    } else {
      for (const candidate of candidates) {
        // A pending (INVITED) account created under the invitation flow has
        // no password yet — never a real match, but still one argon2 verify
        // against a dummy hash, so its presence in `candidates` doesn't
        // create a timing signal distinguishing it from a real wrong-password
        // candidate.
        const valid = candidate.passwordHash
          ? await this.passwordHashing.verify(candidate.passwordHash, dto.password)
          : await this.passwordHashing.verify(await this.getDummyHash(), dto.password).then(() => false);
        // A candidate also matches when INVITED with a real password already
        // set (i.e. they've completed /auth/activate-account but never
        // logged in) — this login call is what activates them, below. This
        // branch is only safe because User creation never writes
        // `passwordHash` directly (see StaffService.create()/
        // ManagerService.create()) — if that ever changes, this condition
        // must be tightened to something stronger than "passwordHash is set".
        // A Manager-set/generated "temporary password" (Create Staff) does
        // NOT threaten this: it's hashed into the separate
        // `User.temporaryPasswordHash` column, which `core.auth_find_users_by_email`
        // never selects and this candidate object never carries — see that
        // column's own comment on the entity for the full reasoning.
        const invitedWithPassword = candidate.status === UserStatus.INVITED && candidate.passwordHash !== null;
        if (valid && (candidate.status === UserStatus.ACTIVE || invitedWithPassword)) {
          if (matched) ambiguous = true;
          else matched = candidate;
        }
      }
    }
    if (ambiguous) {
      await this.dataSource.query(
        `INSERT INTO core.login_history (organisation_id, user_id, email, ip, user_agent, success)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [null, null, email, meta.ip ?? null, meta.userAgent ?? null, false],
      );
      // Only someone holding the password of BOTH accounts ever sees this, so it discloses nothing the uniform message protects.
      throw new UnauthorizedException({
        code: 'AMBIGUOUS_ACCOUNTS',
        message: 'This email address belongs to more than one Crewflow account. Ask your administrator to resolve it before signing in.',
      });
    }

    // Plain parameterized INSERT, no RETURNING — TypeORM's `.insert()`
    // always appends a RETURNING clause to populate `result.identifiers`
    // (unused here), but Postgres additionally evaluates the SELECT policy
    // against a RETURNING'd row, not just the INSERT policy's WITH CHECK —
    // confirmed live: identical to `login_history_insert`'s `WITH CHECK
    // true`, this insert only succeeds under `rab_app` with no context
    // bound when RETURNING is omitted entirely.
    if (!matched) await this.dataSource.query(
      `INSERT INTO core.login_history (organisation_id, user_id, email, ip, user_agent, success)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [null, null, email, meta.ip ?? null, meta.userAgent ?? null, false],
    );

    if (!matched) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const result = await this.completeLogin(matched, meta, mobile, dto.applicationTarget, 'password');
    // Only once a session has actually been issued: never after a refusal that followed a correct password (password
    // sign-in disabled, second factor required, application denied), which would turn the limiter into an oracle.
    await this.loginLimiter.recordSuccess(email, meta.ip);
    return result;
  }

  /**
   * P1C.1B (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.3): the ONE convergence point every login
   * provider funnels through once identity is resolved — extracted verbatim from `login()`'s own
   * post-verification body, unchanged in behaviour. Password login calls this after its own
   * argon2 verify; `signInWithProvider` (Google/Microsoft) calls it after resolving an EXISTING
   * Crewflow user via `core.user_auth_identity`/email match, having done NO password check at
   * all. Nothing here is provider-specific: workspace resolution, platform-admin/application
   * checks, `login_history`/audit writes, refresh-family + `core.user_session` creation, JWT
   * signing, and the one-time INVITED->ACTIVE transition are identical regardless of which
   * credential authenticated the caller. `mustResetPassword` flows through unchanged for every
   * provider — a Google/Microsoft login for a flagged account still reports it true (P1C.1B
   * brief §15; FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.9 step 5) — this is a deliberate decision,
   * not an oversight: OAuth authenticates identity, it does not satisfy Crewflow's own
   * post-auth password-hygiene policy.
   *
   * `user` is a PARTIAL candidate shape — `signInWithProvider` constructs one from a plain
   * `User` row (not the pre-auth `LoginCandidate` RPC shape `login()` itself uses), since by the
   * time OAuth calls this it has already resolved the full row through the normal RLS-enforced
   * path. Only the fields this method actually reads are required.
   */
  private async assertSignInHost(meta: RequestMeta, ctx: AuthContext, applicationTarget: ApplicationTarget): Promise<void> {
    const host = meta.workspaceHost;
    if (!host || host.kind === 'none') return;
    if (host.kind === 'workspace' && ctx.workspaceId !== null && ctx.workspaceId === host.workspaceId) return;
    if (host.kind === 'unavailable') throw new ServiceUnavailableException({ code: 'WORKSPACE_HOST_UNAVAILABLE', message: 'Please try again shortly.' });
    await this.tenantContext.runInTenantContext(ctx, (manager) =>
      this.auditService.record(manager, ctx, AuditAction.APPLICATION_ACCESS_DENIED, { metadata: { applicationTarget, reason: 'workspace_host_mismatch' } }),
    );
    throw new NotFoundException({ code: WORKSPACE_HOST_SIGN_IN_REFUSED, message: 'Not found.', canonicalUrl: this.env.get('APP_URL').replace(/\/+$/, '') });
  }

  private async completeLogin(
    user: Pick<LoginCandidate, 'id' | 'organisationId' | 'email' | 'firstName' | 'status' | 'mustResetPassword'>,
    meta: RequestMeta,
    mobile: boolean,
    requestedApplicationTarget: ApplicationTarget | undefined,
    authProvider: 'password' | 'google' | 'microsoft',
    opts: CompleteLoginOptions = {},
  ): Promise<LoginResult> {
    const sid = randomUUID();
    // P2.8 — organisation suspension blocks every login provider at this one convergence point
    // (password, Google, Microsoft all funnel through completeLogin). Computed before workspace
    // resolution — platform_admin has no workspace scoping, so this never needs it — and reused
    // below for applicationAllowed() rather than queried twice. A platform admin's OWN organisation
    // is exempt, same bypass MaintenanceModeGuard/ActiveAccountGuard's Admin Inspect path already
    // grant: Crewflow's own staff must still be able to log in to investigate/reactivate a
    // suspended tenant.
    const isPlatformAdmin = await this.platformAdmin.isPlatformAdmin({ userId: user.id });
    if (!isPlatformAdmin) {
      // SECURITY DEFINER (core.organisation_is_suspended) — this runs on the unbound connection,
      // before any tenant context exists for this row; a plain `this.dataSource.query('SELECT
      // suspended_at FROM core.organisation ...')` here would silently return zero rows under
      // `organisation_self`'s RLS policy (confirmed live: see OrganisationIsSuspended1786705000000).
      const [{ organisation_is_suspended: suspended }] = await this.dataSource.query<[{ organisation_is_suspended: boolean }]>(
        'SELECT core.organisation_is_suspended($1) AS organisation_is_suspended',
        [user.organisationId],
      );
      if (suspended) {
        throw new UnauthorizedException('This organisation has been suspended. Contact your administrator.');
      }
    }
    const workspaceId = await this.workspaceResolver.resolveForUser(user.id);
    const ctx: AuthContext = { organisationId: user.organisationId, workspaceId, userId: user.id, role: '' };

    const roles = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const roleRows = await manager
        .createQueryBuilder(UserRole, 'ur')
        .innerJoin(Role, 'r', 'r.id = ur.role_id')
        .where('ur.user_id = :userId', { userId: user.id })
        .select('r.key', 'key')
        .getRawMany<{ key: string }>();
      return roleRows.map((r) => r.key);
    });

    // Universal mobile entry derives its session from real roles. Explicit
    // targets from older clients still pass the existing role-access policy.
    const applicationTarget = mobile && !requestedApplicationTarget
      ? (roles.includes('venue_manager') ? 'venue_manager_app' : 'staff_app')
      : requestedApplicationTarget ?? 'manager_web';
    // P0.3 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.2): `isPlatformAdmin` computed once, right at the
    // top of this method (P2.8's organisation-suspension check needed it first) and reused here
    // for both the access-allowed check AND the session's absolute TTL, so a platform admin's
    // session is capped at the 24h policy regardless of applicationTarget — see session-policy.ts.
    // CF-06: an organisation's (or the deployment's) "password sign-in off" is enforced here, the one convergence point
    // every password sign-in reaches, with the owner-approved mobile-workforce exemption. Uniform message: refusing with a
    // provider-specific error would confirm that the password was right.
    if (authProvider === 'password' && !(await this.passwordProviderPermits(ctx, roles, isPlatformAdmin, mobile ? applicationTarget : null))) {
      await this.dataSource.query(
        `INSERT INTO core.login_history (organisation_id, user_id, email, ip, user_agent, success, provider) VALUES ($1, $2, $3, $4, $5, false, 'password')`,
        [null, null, user.email, meta.ip ?? null, meta.userAgent ?? null],
      );
      await this.tenantContext.runInTenantContext(ctx, (manager) =>
        this.auditService.record(manager, ctx, AuditAction.PASSWORD_SIGN_IN_PROVIDER_DISABLED, { targetUserId: user.id, metadata: { applicationTarget } }),
      );
      throw new UnauthorizedException('Invalid email or password.');
    }
    if (!applicationAllowed(roles, applicationTarget, isPlatformAdmin) || memberWithoutWorkspace(roles, workspaceId, isPlatformAdmin)) {
      await this.tenantContext.runInTenantContext(ctx, manager => this.auditService.record(manager, ctx, AuditAction.APPLICATION_ACCESS_DENIED, { metadata: { applicationTarget } }));
      throw applicationDenied(applicationTarget);
    }
    // W6-E2E-02 (owner decision H#3, interim rule): a sign-in made on a WORKSPACE host completes only for an account of
    // THAT workspace. Before, the session was issued on the foreign host and every later call answered 404
    // WORKSPACE_HOST_MISMATCH — a stray, useless session the user could not see. Refused here, after the credential
    // and access checks (so it never answers for a wrong password) and before the second factor, any session,
    // login_history success row or token exists. The body names only the default app URL (identical for every account),
    // where sign-in hands the session to the account's own workspace host (lane H / MFA handoff design).
    await this.assertSignInHost(meta, ctx, applicationTarget);
    // Wave 1 lane A (finding D-A3): the ONE second-factor gate (`LoginSecondFactorPolicyService`) — previously consulted
    // only by the OAuth handoff — now runs here, at the convergence point every provider reaches (password web, password
    // mobile, Google, Microsoft), after every access gate and BEFORE any session, login_history success row or audit
    // event exists. Crewflow has no enrolment or verification step yet (TOTP is wave 4), so the policy answers 'none'
    // and this is inert by default; any other answer FAILS CLOSED — no session is issued, because there is nothing that
    // could verify the factor. Same 409 shape the OAuth handoff already returns.
    //
    // Wave 4 lane MFA: the policy is real now (LoginSecondFactorPolicyService). A non-'none' answer no longer just
    // refuses: it creates a single-use, short-lived challenge bound to THIS pending sign-in (account, provider, transport,
    // security version, any pending provider link) and returns it in the same 409 shape. Nothing is issued or written
    // except the audit row; `completeChallengedLogin` re-enters here with `secondFactorVerified` once the code is proven.
    if (!opts.secondFactorVerified) {
      const requirement = await this.secondFactor.requirementFor({ userId: user.id, organisationId: user.organisationId, workspaceId, roles, isPlatformAdmin, applicationTarget });
      if (requirement !== 'none') {
        const securityVersion = await this.readUserSecurityVersion(ctx, user.id);
        const challenge = await this.mfaChallenges.create({
          requirement,
          userId: user.id,
          organisationId: user.organisationId,
          email: normalizeEmail(user.email),
          firstName: user.firstName,
          status: user.status,
          mustResetPassword: user.mustResetPassword,
          authProvider,
          mobile,
          requestedApplicationTarget: requestedApplicationTarget ?? null,
          providerLink: opts.providerLink ?? null,
          securityVersion,
        });
        await this.tenantContext.runInTenantContext(ctx, (manager) =>
          this.auditService.record(manager, ctx, AuditAction.MFA_CHALLENGE_ISSUED, { targetUserId: user.id, metadata: { requirement, authProvider, applicationTarget } }),
        );
        throw new ConflictException({
          code: 'SECOND_FACTOR_REQUIRED',
          requirement,
          challengeToken: challenge.token,
          challengeExpiresAt: challenge.expiresAt.toISOString(),
          message: requirement === 'enroll' ? 'Set up two-factor authentication to finish signing in.' : 'Enter the code from your authenticator app to finish signing in.',
        });
      }
    }
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      if (opts.providerLink) await this.applyProviderLink(manager, user, opts.providerLink);
      await manager.query('INSERT INTO core.login_history (organisation_id, user_id, email, ip, user_agent, success, provider) VALUES ($1, $2, $3, $4, $5, true, $6)', [user.organisationId, user.id, user.email, meta.ip ?? null, meta.userAgent ?? null, authProvider]);
      await this.auditService.record(manager, ctx, AuditAction.USER_LOGIN, { metadata: { applicationTarget, authProvider } });
      const issued = await this.refreshTokenService.issue(manager, {
        organisationId: user.organisationId,
        userId: user.id,
        familyId: sid,
        workspaceId: ctx.workspaceId,
        applicationTarget,
        roles,
        isPlatformAdmin,
        userAgent: meta.userAgent,
        ip: meta.ip,
        authProvider,
      });
      // PHASE 10 §16: the access JWT must never outlive the session family
      // it belongs to — clamp to whatever's actually left of the family's
      // absolute deadline (a fresh login's family always has the FULL
      // policy duration ahead of it, so this is a no-op clamp here in
      // practice, but the SAME call shape as refresh() below, which is
      // where a near-deadline clamp actually bites).
      const accessToken = this.accessTokenService.sign(
        { sub: user.id, org: user.organisationId, roles, applicationTarget, sid },
        issued.familyExpiresAt.getTime() - Date.now(),
      );

      if (user.status === UserStatus.INVITED) {
        // First successful login with a password set via activate-account (or, for OAuth, the
        // first successful provider sign-in — see signInWithProvider's own eligibility gate,
        // which requires the SAME invitedWithPassword state login() itself requires) — this is
        // the one and only place an account transitions to ACTIVE. A conditional, atomic UPDATE
        // (not a plain manager.update()) so two concurrent first-logins for the same account
        // can't both "win" and double-fire the audit/welcome email below — mirrors
        // AccountInviteService.consume()'s own single-use idiom.
        const result = await manager
          .createQueryBuilder()
          .update(User)
          .set({ status: UserStatus.ACTIVE, lastLoginAt: new Date() })
          .where('id = :id AND status = :invited', { id: user.id, invited: UserStatus.INVITED })
          .execute();

        if (result.affected === 1) {
          assertTransition(USER_STATUS_TRANSITIONS, UserStatus.INVITED, UserStatus.ACTIVE);
          await this.auditService.record(manager, ctx, AuditAction.ACCOUNT_ACTIVATED, { targetUserId: user.id });

          const organisation = await manager.findOneByOrFail(Organisation, { id: user.organisationId });
          const rendered = renderWelcomeEmail({ firstName: user.firstName, organisationName: organisation.name });
          const row = await this.emailOutbox.enqueue(manager, {
            organisationId: user.organisationId,
            jobType: EmailOutboxJobType.WELCOME,
            recipientEmail: user.email,
            targetUserId: user.id,
            rendered,
          });
          void this.emailOutbox.tryFastPublish((id, orgId) => this.emailQueue.publish(id, orgId), row);
        }
      } else {
        await manager.update(User, user.id, { lastLoginAt: new Date() });
      }

      return { accessToken, refreshToken: issued.token, refreshExpiresAt: issued.expiresAt, sessionExpiresAt: issued.familyExpiresAt, mustResetPassword: user.mustResetPassword, webSessionToken: issued.webSessionToken };
    });
  }

  /**
   * P1C.1B — the Google/Microsoft convergence entry point, called by `GoogleAuthController`/
   * `MicrosoftAuthController` after the OIDC callback has been fully validated (state/PKCE/nonce
   * consumed, ID token signature verified, email-verified claim checked for Google). This method
   * does NO further provider-protocol work — its only job is resolving a validated external
   * identity to an EXISTING Crewflow user (never creating one — invite-only signup is preserved
   * unchanged, FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.9) and handing off to `completeLogin`.
   *
   * Resolution order:
   *  1. Already-linked identity (`core.user_auth_identity`, via the pre-auth
   *     `auth_find_user_by_provider_identity` function) — the common case for a returning user.
   *  2. First-time link: an EXISTING Crewflow user whose email exactly matches the provider's own
   *     verified email claim, AND is eligible to authenticate at all — the SAME
   *     `ACTIVE || (INVITED && passwordHash !== null)` gate `login()` itself uses (P1C.1A audit,
   *     FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.9: Crewflow's own invite-acceptance ritual is not
   *     bypassed merely because OAuth proves the email differently). Exactly one eligible
   *     candidate is required — zero or more-than-one both fail generically (an email matching
   *     2+ organisations cannot be safely disambiguated without a password, and OAuth has none).
   *
   * Every failure path throws the SAME generic `UnauthorizedException` message, regardless of
   * which of the above reasons caused it — never revealing to the caller whether an account
   * exists, is ineligible, or belongs to a different provider (FULL-ARCHITECTURE-UPGRADE-PLAN.md
   * §33.7.12's OAuth-error-privacy decision). Callers (the provider controllers) are responsible
   * for logging the SPECIFIC reason to the audit/security log, never the HTTP response.
   */
  async signInWithProvider(
    provider: 'google' | 'microsoft',
    identity: ProviderSignInIdentity,
    meta: RequestMeta,
  ): Promise<LoginResult> {
    return this.completeProviderSignIn(provider, identity, null, meta);
  }

  /**
   * Resolves a validated provider identity to an EXISTING, eligible Crewflow account without writing anything.
   * Used at the OAuth callback (handoff mode) and again at redemption, so the account, its status and the provider
   * settings are re-checked at the moment the session is actually issued.
   *
   *  1. Linked `(provider, subject)`: the account must be ACTIVE, or INVITED (an INVITED account can only carry a
   *     provider link if it was created by accepting a member invitation with that provider). Suspended/deactivated
   *     accounts are refused BEFORE any session, audit or login-history write (audit F4).
   *  2. First link: the provider must prove the email (`emailVerified`, audit F1), and exactly one account across
   *     all organisations must match it and be eligible (`ACTIVE`, or `INVITED` with a password set — the existing
   *     invite-acceptance requirement is not bypassed).
   *
   * Every failure is the same generic 401 (`ProviderSignInError.reason` carries the specific cause for the
   * security log only, never the response).
   */
  async resolveProviderUser(
    provider: 'google' | 'microsoft',
    identity: ProviderSignInIdentity,
  ): Promise<{ user: User; linkRequired: boolean }> {
    const linked = await this.userAuthIdentity.findLinkedUser(provider, identity.subject);
    if (linked) {
      const workspaceId = await this.workspaceResolver.resolveForUser(linked.userId);
      const ctx: AuthContext = { organisationId: linked.organisationId, workspaceId, userId: linked.userId, role: '' };
      // Service-layer gate (CLAUDE.md layer 2) — never trust the controller/guard's system-only
      // check alone; this is the one place that also knows the resolved organisation.
      await this.organisationAuthProviders.assertProviderEnabledOrThrow(ctx, provider);
      const user = await this.tenantContext.runInTenantContext(ctx, (manager) => manager.findOne(User, { where: { id: linked.userId } }));
      if (!user || (user.status !== UserStatus.ACTIVE && user.status !== UserStatus.INVITED)) {
        throw new ProviderSignInError('account_not_eligible');
      }
      return { user, linkRequired: false };
    }

    if (identity.emailVerified !== true) throw new ProviderSignInError('email_not_verified_for_linking');
    // No existing link — first-time sign-in via this provider. Resolve by verified email against
    // the SAME cross-org pre-auth candidate set login() itself uses, filtered to the same
    // eligibility gate (never password-checked here — OAuth has no password to check).
    const email = normalizeEmail(identity.email);
    const candidates = await this.dataSource.query<LoginCandidate[]>('SELECT * FROM core.auth_find_users_by_email($1)', [email]);
    const eligible = candidates.filter((c) => c.status === UserStatus.ACTIVE || (c.status === UserStatus.INVITED && c.passwordHash !== null));
    // Covers both "no Crewflow account" (never auto-provisioned — invite-only signup is preserved) and "ambiguous
    // across organisations" (cannot safely resolve without a password) with the SAME generic outcome.
    if (eligible.length === 0) throw new ProviderSignInError('no_eligible_account');
    if (eligible.length > 1) throw new ProviderSignInError('ambiguous_accounts');
    const candidate = eligible[0]!;
    const workspaceId = await this.workspaceResolver.resolveForUser(candidate.id);
    const ctx: AuthContext = { organisationId: candidate.organisationId, workspaceId, userId: candidate.id, role: '' };
    await this.organisationAuthProviders.assertProviderEnabledOrThrow(ctx, provider);
    const user = await this.tenantContext.runInTenantContext(ctx, (manager) => manager.findOneOrFail(User, { where: { id: candidate.id } }));
    return { user, linkRequired: true };
  }

  /**
   * Resolve (again) and issue the session. `expectedUserId` (handoff redemption) must equal the account resolved
   * now, otherwise the sign-in is refused — the account behind a handoff can never silently change. A first-time
   * link is written inside the session transaction after every access gate (audit F10), with the race-safe
   * re-check: if another account won the link, the whole login rolls back.
   */
  async completeProviderSignIn(
    provider: 'google' | 'microsoft',
    identity: ProviderSignInIdentity,
    expectedUserId: string | null,
    meta: RequestMeta,
  ): Promise<LoginResult> {
    const { user, linkRequired } = await this.resolveProviderUser(provider, identity);
    if (expectedUserId && user.id !== expectedUserId) throw new ProviderSignInError('account_changed');
    const email = normalizeEmail(identity.email);
    const providerLink: PendingProviderLink = linkRequired
      ? { mode: 'link', provider, subject: identity.subject, verifiedEmail: email }
      : { mode: 'touch', provider };
    return this.completeLogin(user, meta, false, undefined, provider, { providerLink });
  }

  /**
   * Wave 4 lane MFA — cross-host login handoff, target side. `LoginHandoffService` has ALREADY burned the handoff
   * (`core.login_handoff_consume`, single use, audience = this request's registry-confirmed workspace host label) and
   * received the identity it was minted for. This issues a NEW, independent `manager_web` session for the workspace host
   * (fresh session id, fresh web-session credential — never the source session's: no fixation), after re-checking every
   * access gate as of now. The second-factor gate is not re-run: the handoff can only be minted from a live source
   * session that already passed it, and enabling/disabling MFA bumps the security version, which the consume function
   * compares. Returns the same shape as a sign-in.
   */
  async issueHandedOffSession(
    handoff: { organisationId: string; userId: string; workspaceId: string; authProvider: 'password' | 'google' | 'microsoft' },
    meta: RequestMeta,
  ): Promise<LoginResult> {
    const isPlatformAdmin = await this.platformAdmin.isPlatformAdmin({ userId: handoff.userId });
    if (!isPlatformAdmin) {
      const [{ organisation_is_suspended: suspended }] = await this.dataSource.query<[{ organisation_is_suspended: boolean }]>(
        'SELECT core.organisation_is_suspended($1) AS organisation_is_suspended',
        [handoff.organisationId],
      );
      if (suspended) throw new UnauthorizedException('Please sign in again.');
    }
    const workspaceId = await this.workspaceResolver.resolveForUser(handoff.userId);
    // The workspace the handoff was minted for must still be this user's workspace (single workspace per manager).
    if (workspaceId !== handoff.workspaceId) throw new UnauthorizedException('Please sign in again.');
    const ctx: AuthContext = { organisationId: handoff.organisationId, workspaceId, userId: handoff.userId, role: '' };
    const sid = randomUUID();
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const user = await manager.findOne(User, { where: { id: handoff.userId } });
      if (!user || user.status !== UserStatus.ACTIVE) throw new UnauthorizedException('Please sign in again.');
      const roles = await this.rolesForUserTx(manager, user.id);
      const applicationTarget: ApplicationTarget = 'manager_web';
      if (!applicationAllowed(roles, applicationTarget, isPlatformAdmin) || memberWithoutWorkspace(roles, workspaceId, isPlatformAdmin)) {
        throw new UnauthorizedException('Please sign in again.');
      }
      await manager.query('INSERT INTO core.login_history (organisation_id, user_id, email, ip, user_agent, success, provider) VALUES ($1, $2, $3, $4, $5, true, $6)', [user.organisationId, user.id, user.email, meta.ip ?? null, meta.userAgent ?? null, handoff.authProvider]);
      await this.auditService.record(manager, ctx, AuditAction.USER_LOGIN, { metadata: { applicationTarget, authProvider: handoff.authProvider, via: 'login_handoff' } });
      await this.auditService.record(manager, ctx, AuditAction.LOGIN_HANDOFF_EXCHANGED, { targetUserId: user.id, metadata: { applicationTarget } });
      const issued = await this.refreshTokenService.issue(manager, {
        organisationId: user.organisationId,
        userId: user.id,
        familyId: sid,
        workspaceId,
        applicationTarget,
        roles,
        isPlatformAdmin,
        userAgent: meta.userAgent,
        ip: meta.ip,
        authProvider: handoff.authProvider,
      });
      const accessToken = this.accessTokenService.sign({ sub: user.id, org: user.organisationId, roles, applicationTarget, sid }, issued.familyExpiresAt.getTime() - Date.now());
      await manager.update(User, user.id, { lastLoginAt: new Date() });
      return { accessToken, refreshToken: issued.token, refreshExpiresAt: issued.expiresAt, sessionExpiresAt: issued.familyExpiresAt, mustResetPassword: user.mustResetPassword, webSessionToken: issued.webSessionToken };
    });
  }

  /** Writes a first-time provider link (race-safe) or touches the existing one, inside the session transaction. */
  private async applyProviderLink(manager: EntityManager, user: { id: string; organisationId: string }, link: PendingProviderLink): Promise<void> {
    if (link.mode === 'link') {
      const linkedToThisUser = await this.userAuthIdentity.linkFirstTime(manager, {
        organisationId: user.organisationId,
        userId: user.id,
        provider: link.provider,
        subject: link.subject,
        verifiedEmail: link.verifiedEmail,
      });
      // Race-safe fail-closed: a concurrent link for a DIFFERENT user claimed this provider_subject first, or this
      // user already links a different subject for this provider — never proceed as the wrong identity.
      if (!linkedToThisUser) throw new ProviderSignInError('link_conflict');
    } else {
      await this.userAuthIdentity.touchLastUsed(manager, user.id, link.provider);
    }
  }

  private async readUserSecurityVersion(ctx: AuthContext, userId: string): Promise<number> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const [row] = await manager.query<Array<{ security_version: string | number }>>('SELECT security_version FROM core."user" WHERE id = $1', [userId]);
      if (!row) throw new UnauthorizedException('Please sign in again.');
      return Number(row.security_version);
    });
  }

  /**
   * Wave 4 lane MFA: finishes a sign-in whose second factor `MfaLoginService` has just verified (and whose challenge it
   * has already consumed — single use). Everything is re-checked NOW, at issue time, through the same convergence point:
   * account status, the account's security version (a password reset, MFA change or revocation since the challenge was
   * issued kills it), organisation suspension, application access, workspace membership, password-provider settings,
   * and the provider link. Only the second-factor gate itself is skipped, because it was just satisfied.
   */
  async completeChallengedLogin(login: PendingLogin, meta: RequestMeta): Promise<LoginResult> {
    const workspaceId = await this.workspaceResolver.resolveForUser(login.userId);
    const ctx: AuthContext = { organisationId: login.organisationId, workspaceId, userId: login.userId, role: '' };
    const user = await this.tenantContext.runInTenantContext(ctx, (manager) => manager.findOne(User, { where: { id: login.userId } }));
    if (!user || (user.status !== UserStatus.ACTIVE && user.status !== UserStatus.INVITED)) throw new UnauthorizedException('Please sign in again.');
    if ((await this.readUserSecurityVersion(ctx, user.id)) !== login.securityVersion) throw new UnauthorizedException('Please sign in again.');
    const result = await this.completeLogin(user, meta, login.mobile, login.requestedApplicationTarget ?? undefined, login.authProvider, {
      providerLink: login.providerLink,
      secondFactorVerified: true,
    });
    // Same rule as login(): only once a session has actually been issued.
    if (login.authProvider === 'password') await this.loginLimiter.recordSuccess(login.email, meta.ip);
    return result;
  }

  /**
   * Revokes the web session a browser presented when it signs in again (Twenty: SUPERSEDED). Best effort: an
   * unknown or malformed value is ignored and never blocks the new sign-in.
   */
  async revokeSupersededWebSession(rawWebSessionToken: string | undefined): Promise<void> {
    if (!isWellFormedWebSessionToken(rawWebSessionToken)) return;
    const hash = createHash('sha256').update(rawWebSessionToken).digest('hex');
    const [found] = await this.dataSource.query<Array<{ sessionId: string; userId: string; organisationId: string }>>(
      'SELECT * FROM core.auth_find_session_by_web_token_hash($1)',
      [hash],
    );
    if (!found) return;
    const ctx: AuthContext = { organisationId: found.organisationId, workspaceId: null, userId: found.userId, role: '' };
    await this.tenantContext.runInTenantContext(ctx, (manager) => this.refreshTokenService.revokeFamily(manager, found.sessionId, 'superseded'));
  }

  /**
   * Reuse detection: `RefreshTokenService.rotate` already revoked the whole
   * family by the time it throws `RefreshTokenReuseError` — this just turns
   * that into the right HTTP response. (`AUTH_REFRESH_REUSE` audit event
   * lands with the audit writer in a later PR — not built yet.)
   */
  async refresh(refreshToken: string, meta: RequestMeta, requestedTarget?: ApplicationTarget): Promise<AuthTokens> {
    // The presented token identifies the org, but nothing about which org
    // is known yet — a narrow SECURITY DEFINER lookup (see
    // PreAuthLookupFunctions1786667400000) resolves just enough to bind a
    // tenant context; `rotate()` itself, and the role lookup below, then run
    // through the normal RLS-enforced path for that org, matching every
    // other authenticated flow in this codebase.
    const tokenHash = this.refreshTokenService.hashToken(refreshToken);
    const [org] = await this.dataSource.query<[{ organisationId: string; userId: string }]>(
      'SELECT * FROM core.auth_find_refresh_token_org($1)',
      [tokenHash],
    );
    if (!org) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const workspaceId = await this.workspaceResolver.resolveForUser(org.userId);
    const ctx: AuthContext = { organisationId: org.organisationId, workspaceId, userId: org.userId, role: '' };

    await this.tenantContext.runInTenantContext(ctx, async manager => {
      const [session] = await manager.query('SELECT application_target FROM core.refresh_token WHERE token_hash = $1', [tokenHash]);
      const rows = await manager.query('SELECT r.key FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = $1', [org.userId]);
      const target = session?.application_target as ApplicationTarget | undefined;
      if (!target) throw new UnauthorizedException('Please sign in again.');
      const roleKeys = rows.map((r: {key: string}) => r.key);
      const platformAdmin = await this.platformAdmin.isPlatformAdminTx(manager, ctx);
      if ((requestedTarget && requestedTarget !== target) || !applicationAllowed(roleKeys, target, platformAdmin) || memberWithoutWorkspace(roleKeys, workspaceId, platformAdmin)) throw applicationDenied(requestedTarget ?? target);
    });

    let rotated: Awaited<ReturnType<RefreshTokenService['rotate']>>;
    try {
      rotated = await this.tenantContext.runInTenantContext(ctx, (manager) =>
        this.refreshTokenService.rotate(manager, refreshToken, {
          userAgent: meta.userAgent,
          ip: meta.ip,
        }),
      );
    } catch (error) {
      if (error instanceof RefreshTokenReuseError) {
        // `rotate()` throws from inside a transaction that has already
        // rolled back everything it attempted — including any revocation it
        // might otherwise have tried to persist (see RefreshTokenReuseError's
        // doc comment). Revoking the family here, in a fresh transaction
        // opened after that rollback, is what actually makes it durable.
        await this.tenantContext.runInTenantContext(ctx, async (manager) => {
          await this.refreshTokenService.revokeFamily(manager, error.familyId, 'reuse_detected');
          await this.auditService.record(manager, ctx, AuditAction.REFRESH_TOKEN_REUSE_DETECTED, {
            metadata: { familyId: error.familyId },
          });
        });
        throw new UnauthorizedException('Refresh token reuse detected — session revoked. Please log in again.');
      }
      throw error;
    }

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const roleRows = await manager
        .createQueryBuilder(UserRole, 'ur')
        .innerJoin(Role, 'r', 'r.id = ur.role_id')
        .where('ur.user_id = :userId', { userId: rotated.userId })
        .select('r.key', 'key')
        .getRawMany<{ key: string }>();

      // PHASE 10 §16/§17: this is the clamp that actually matters — a web
      // session refreshed with 3 minutes left before its 24h ceiling must
      // receive a token that expires in ~3 minutes, never a fresh 15-minute
      // one. `familyExpiresAt` is inherited unchanged by `rotate()`, so this
      // reflects the TRUE absolute deadline, never a sliding one.
      const accessToken = this.accessTokenService.sign(
        { sub: rotated.userId, org: rotated.organisationId, roles: roleRows.map((r) => r.key), sid: rotated.issued.familyId, applicationTarget: rotated.applicationTarget },
        rotated.issued.familyExpiresAt.getTime() - Date.now(),
      );

      return { accessToken, refreshToken: rotated.issued.token, refreshExpiresAt: rotated.issued.expiresAt, sessionExpiresAt: rotated.issued.familyExpiresAt };
    });
  }

  /**
   * P0.2 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8A.2): the presented token's resolved owner MUST be
   * the Bearer-authenticated caller (`ctx.userId`) — see `RefreshTokenService.revokeByToken`'s
   * doc comment for the full threat this closes (an authenticated user revoking a DIFFERENT
   * user's session by presenting their token). A mismatch is audited and the whole transaction
   * still commits (the audit write must be durable), then the method throws AFTER the
   * transaction has committed — the generic "Invalid refresh token" message, reused verbatim
   * from `rotate()`'s own unknown-token case, deliberately does not distinguish "this token
   * doesn't exist" from "this token belongs to someone else," so neither response is an oracle.
   */
  async logout(ctx: AuthContext, refreshToken: string | undefined): Promise<void> {
    const outcome = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // Audit F9: also end the session that authenticated THIS request (cookie or Bearer `sid`), so logout works even
      // when no refresh token is presented. A presented refresh token is ownership-checked FIRST: on a mismatch
      // nothing at all is revoked (the existing abuse-case contract).
      const result = refreshToken ? await this.refreshTokenService.revokeByToken(manager, refreshToken, ctx.userId) : ('revoked' as const);
      if (result !== 'mismatch' && ctx.sessionId) await this.refreshTokenService.revokeFamily(manager, ctx.sessionId, 'logout');
      await this.auditService.record(
        manager,
        ctx,
        result === 'mismatch' ? AuditAction.LOGOUT_TOKEN_OWNERSHIP_MISMATCH : AuditAction.USER_LOGOUT,
        {},
      );
      return result;
    });
    if (outcome === 'mismatch') {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  /**
   * Backs `GET /auth/me` — the console's own identity, never another
   * user's. `mustResetPassword` is included so a client can reactively
   * detect the forced-reset state after an app restart / page refresh, not
   * only from the one-off login response — `/auth/me` is the one endpoint
   * `MustResetPasswordGuard` always exempts, so it stays callable either way.
   */
  /**
   * P1C: `roles`/`mustResetPassword`/`isPlatformAdmin` come straight from `ctx.security` — the
   * ONE consolidated PostgreSQL security snapshot `JwtAuthGuard` already built for this exact
   * request — instead of this handler re-querying `core.user_role`/`core.role` and re-calling
   * `PlatformAdminService.isPlatformAdmin` a SECOND and THIRD time each (the guard chain already
   * resolved both once; this method was the clearest "same value loaded more than once in the
   * same request" case found during the P1C auth-chain audit). Only the display-only fields
   * (`email`/`firstName`/`lastName`) still need their own lookup — deliberately NOT folded into
   * the security snapshot itself, which stays security-shape-only (P1C §6's own "do not include
   * unneeded profile data" guidance).
   */
  async me(ctx: AuthContext): Promise<{
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    organisationId: string;
    roles: string[];
    mustResetPassword: boolean;
    isPlatformAdmin: boolean;
    sessionId: string;
    applicationTarget: ApplicationTarget;
    sessionExpiresAt: string;
  }> {
    const [user, sessionRow] = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const [userRow, sessionRows] = await Promise.all([
        manager.findOneOrFail(User, { where: { id: ctx.userId } }),
        // Same non-secret timestamp `completeLogin`/`refresh` already hand back on every
        // login/refresh response (`AuthTokens.sessionExpiresAt`) — the cookie-first bootstrap
        // (P1C.1C-F) needs it here too, since it no longer has a login/refresh response of its
        // own to read it from. The caller already has full rights to read their OWN session row
        // (this IS their session); no new table access, no new endpoint.
        manager.query('SELECT absolute_expires_at FROM core.user_session WHERE id = $1', [ctx.sessionId]),
      ]);
      return [userRow, sessionRows[0] as { absolute_expires_at: string } | undefined];
    });

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organisationId: ctx.organisationId ?? user.organisationId,
      roles: ctx.security?.roles ?? [],
      mustResetPassword: ctx.security?.mustResetPassword ?? user.mustResetPassword,
      isPlatformAdmin: ctx.security?.isPlatformAdmin ?? false,
      // P1C.1C — the web frontend's cookie-first bootstrap derives its identity store from THIS
      // response (never a decoded JWT any more, since ordinary requests carry no Bearer token to
      // decode) — `sessionId` is the P0 identity-epoch mechanism's own `expectedSessionId`, and
      // the same value the `X-Crewflow-Expected-Session-Id` fencing header asserts on every
      // subsequent request. Never the raw cookie credential or its hash — both non-secret, both
      // already readable by the authenticated caller through other means (this IS their own
      // session).
      sessionId: ctx.sessionId!,
      applicationTarget: ctx.applicationTarget!,
      sessionExpiresAt: sessionRow!.absolute_expires_at,
    };
  }

  /**
   * The completion step of the forced-reset flow — deliberately NOT a
   * general "change my password" self-service action: only callable while
   * `mustResetPassword` is still true, so a stolen-but-valid access token
   * can't be used to lock the real owner out at will. That narrower
   * capability (voluntary password change, requiring the current password)
   * isn't part of this feature and would need its own endpoint.
   */
  async setPassword(ctx: AuthContext, newPassword: string): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const user = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
      if (!user.mustResetPassword) {
        throw new ConflictException('Your password does not need to be reset.');
      }

      const { valid, reasons } = checkPasswordStrength(newPassword, user.email);
      if (!valid) {
        throw new BadRequestException(reasons.join(' '));
      }

      const passwordHash = await this.passwordHashing.hash(newPassword);
      await manager.update(User, user.id, { passwordHash, mustResetPassword: false });
      await this.securityVersion.bumpUser(manager, user.id);
      await this.refreshTokenService.revokeAllForUser(manager, user.id, 'password_changed');
      await this.auditService.record(manager, ctx, AuditAction.PASSWORD_CHANGED, { targetUserId: user.id });
      await this.sendPasswordUpdatedEmail(manager, ctx.organisationId!, user.id, user.email, user.firstName);
    });
  }

  /**
   * Always the same generic outcome regardless of whether the email
   * matches a real, active account — no enumeration. Silently no-ops
   * (after the same amount of work either way isn't attempted here,
   * unlike login's timing-uniform verify, since a reset email arriving a
   * few hundred ms later either way isn't the kind of oracle login's
   * per-request password verify is) when there's nothing to email.
   *
   * No organisation slug on the way in (see `login()`'s trade-off note) —
   * every org that has an active account under this email gets its own
   * reset link, each scoped to that account only.
   */
  /**
   * Response-time floor for forgot-password (Hyper Workspace Phase 3, Part 9). An existing account does real work (reset
   * token, outbox row, audit row) and a nonexistent address does none, which measured ~42 ms vs ~9 ms: a timing oracle for
   * account discovery. Every request is padded to this floor after its work completes. The response body and status are
   * unchanged, and rate limiting is untouched. Chosen above the measured existing-account latency distribution.
   */
  private static readonly FORGOT_PASSWORD_FLOOR_MS = 150;

  /**
   * CF-06: whether password authentication may be used by this identity right now. The deployment switch
   * (AUTH_PASSWORD_ENABLED) is absolute; an organisation's switch has the mobile-workforce exemption
   * (`passwordExemptForMobileWorkforce`). Fails closed: an error reading the flags propagates (no sign-in).
   */
  private async passwordProviderPermits(ctx: AuthContext, roles: readonly string[], isPlatformAdmin: boolean, target: ApplicationTarget | 'recovery' | null): Promise<boolean> {
    if (!this.organisationAuthProviders.systemEnabled().password) return false;
    if ((await this.organisationAuthProviders.getEffective(ctx)).password) return true;
    return passwordExemptForMobileWorkforce(roles, isPlatformAdmin, target);
  }

  private async rolesForUserTx(manager: EntityManager, userId: string): Promise<string[]> {
    const rows = await manager
      .createQueryBuilder(UserRole, 'ur')
      .innerJoin(Role, 'r', 'r.id = ur.role_id')
      .where('ur.user_id = :userId', { userId })
      .select('r.key', 'key')
      .getRawMany<{ key: string }>();
    return rows.map((r) => r.key);
  }

  async forgotPassword(dto: { email: string; applicationTarget?: ApplicationTarget }, mobile = false): Promise<void> {
    const started = Date.now();
    try {
      await this.doForgotPassword(dto, mobile);
    } finally {
      const remaining = AuthService.FORGOT_PASSWORD_FLOOR_MS - (Date.now() - started);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  private async doForgotPassword(dto: { email: string; applicationTarget?: ApplicationTarget }, mobile = false): Promise<void> {
    // Mobile reset links return to one universal login; this is navigation only.
    if (mobile) dto = { email: dto.email, applicationTarget: 'staff_app' };
    const candidates = await this.dataSource.query<LoginCandidate[]>(
      'SELECT * FROM core.auth_find_users_by_email($1)',
      [normalizeEmail(dto.email)],
    );
    const users = candidates.filter((c) => c.status === UserStatus.ACTIVE);

    for (const user of users) {
      // No workspace is needed to issue a reset token, enqueue its email, or audit the request: password_reset_token,
      // email_outbox and audit_log are all organisation-scoped (their RLS predicates do not read workspace). Resolving
      // membership here was an unnecessary authority read on a pre-auth, anti-enumeration path.
      const ctx: AuthContext = { organisationId: user.organisationId, workspaceId: null, userId: user.id, role: '' };
      // CF-06: no password-reset link for an identity that may not use password sign-in (the response stays uniform).
      const isPlatformAdmin = await this.platformAdmin.isPlatformAdmin({ userId: user.id });
      const roles = await this.tenantContext.runInTenantContext(ctx, (manager) => this.rolesForUserTx(manager, user.id));
      if (!(await this.passwordProviderPermits(ctx, roles, isPlatformAdmin, 'recovery'))) continue;
      await this.tenantContext.runInTenantContext(ctx, async (manager) => {
        const { id: tokenId, token } = await this.passwordResetTokenService.issue(manager, {
          organisationId: user.organisationId,
          userId: user.id,
          purpose: PasswordResetTokenPurpose.FORGOT_PASSWORD,
          applicationTarget: dto.applicationTarget,
          ttlMs: 60 * 60 * 1000, // 1h — shorter than the 48h invite/admin-reset default, this one's self-triggered and time-sensitive
        });
        const resetUrl = `${this.env.get('ACCOUNTS_URL')}/reset-password?token=${token}${dto.applicationTarget ? `&applicationTarget=${dto.applicationTarget}` : ''}`;
        const rendered = renderPasswordResetEmail({ firstName: user.firstName, resetUrl, selfRequested: true });
        // Queued, not awaited-inline — anti-enumeration is preserved (every
        // candidate does the same DB write regardless of outcome; no
        // network I/O of any kind happens in this request either way now).
        const row = await this.emailOutbox.enqueue(manager, {
          organisationId: user.organisationId,
          jobType: EmailOutboxJobType.PASSWORD_RESET,
          recipientEmail: user.email,
          targetUserId: user.id,
          passwordResetTokenId: tokenId,
          rendered,
        });
        void this.emailOutbox.tryFastPublish((id, orgId) => this.emailQueue.publish(id, orgId), row);
        await this.auditService.record(manager, ctx, AuditAction.PASSWORD_RESET_REQUESTED, { targetUserId: user.id });
      });
    }
  }

  /**
   * The absolute "Continue to Manager Portal" link returned alongside
   * `applicationTarget` by `activateAccount()`/`resetPassword()`. These two
   * flows are completed on the separate, public accounts domain
   * (`ACCOUNTS_URL`) — a relative `/login` there would open the accounts
   * site's own (nonexistent) login page instead of the Manager app, so the
   * Manager-web case needs an absolute URL back to `APP_URL`, which is
   * otherwise unused now that the email links themselves have moved to
   * `ACCOUNTS_URL`.
   */
  private managerLoginUrl(): string {
    return `${this.env.get('APP_URL')}/login`;
  }

  /**
   * Runs pre-auth, same as `refresh()` — the presented token's hash is
   * looked up via the narrow `core.auth_find_password_reset_token_org`
   * SECURITY DEFINER function (PreAuthLookupFunctions1786667400000) just to
   * learn which org to bind context to; the actual consume (validity,
   * expiry, single-use enforcement) then runs inside `runInTenantContext`
   * for that org, through the normal RLS-enforced path.
   */
  async resetPassword(dto: { token: string; newPassword: string }): Promise<{ applicationTarget: ApplicationTarget; managerLoginUrl: string }> {
    const tokenHash = this.passwordResetTokenService.hashToken(dto.token);
    const [org] = await this.dataSource.query<[{ organisationId: string; userId: string }]>(
      'SELECT * FROM core.auth_find_password_reset_token_org($1)',
      [tokenHash],
    );
    if (!org) {
      throw new BadRequestException('This reset link is invalid or has expired.');
    }

    const workspaceId = await this.workspaceResolver.resolveForUser(org.userId);
    const ctx: AuthContext = { organisationId: org.organisationId, workspaceId, userId: org.userId, role: '' };
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const consumed = await this.passwordResetTokenService.consume(manager, dto.token);
      if (!consumed) {
        throw new BadRequestException('This reset link is invalid or has expired.');
      }

      const user = await manager.findOneOrFail(User, { where: { id: consumed.userId } });
      // CF-06: a password the identity may not sign in with is never set through a recovery link (the first-time setup
      // link is exempt: it activates the account, and sign-in itself is still refused). Throwing rolls the consume back.
      if (consumed.purpose !== PasswordResetTokenPurpose.INITIAL_SETUP) {
        const isPlatformAdmin = await this.platformAdmin.isPlatformAdmin({ userId: user.id });
        if (!(await this.passwordProviderPermits(ctx, await this.rolesForUserTx(manager, user.id), isPlatformAdmin, 'recovery'))) {
          throw new BadRequestException('This reset link is invalid or has expired.');
        }
      }
      const { valid, reasons } = checkPasswordStrength(dto.newPassword, user.email);
      if (!valid) {
        throw new BadRequestException(reasons.join(' '));
      }

      const passwordHash = await this.passwordHashing.hash(dto.newPassword);
      await manager.update(User, user.id, { passwordHash, mustResetPassword: false });
      await this.securityVersion.bumpUser(manager, user.id);
      await this.refreshTokenService.revokeAllForUser(manager, user.id, 'password_reset');
      await this.auditService.record(manager, ctx, AuditAction.PASSWORD_RESET_COMPLETED, { targetUserId: user.id });

      // INITIAL_SETUP is the very first password this account has ever
      // had — nothing has "changed" from the owner's point of view, so this
      // is a welcome moment, not a security notice. Every other purpose
      // (admin-triggered reset, self-service forgot-password) is a real
      // change to an existing credential.
      if (consumed.purpose === PasswordResetTokenPurpose.INITIAL_SETUP) {
        const organisation = await manager.findOneByOrFail(Organisation, { id: user.organisationId });
        const rendered = renderWelcomeEmail({ firstName: user.firstName, organisationName: organisation.name });
        const row = await this.emailOutbox.enqueue(manager, {
          organisationId: user.organisationId,
          jobType: EmailOutboxJobType.WELCOME,
          recipientEmail: user.email,
          targetUserId: user.id,
          rendered,
        });
        void this.emailOutbox.tryFastPublish((id, orgId) => this.emailQueue.publish(id, orgId), row);
      } else {
        await this.sendPasswordUpdatedEmail(manager, user.organisationId, user.id, user.email, user.firstName);
      }
      const roles = await manager.query('SELECT r.key FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = $1', [user.id]);
      const applicationTarget = consumed.applicationTarget ?? (await this.platformAdmin.isPlatformAdminTx(manager, ctx) ? 'manager_web' : defaultApplication(roles.map((r: {key: string}) => r.key)));
      return { applicationTarget, managerLoginUrl: this.managerLoginUrl() };
    });
  }

  /**
   * Public — activates a PENDING (INVITED) account created under the
   * invitation flow. Resolves the target User entirely from the token
   * (via `core.auth_find_account_invite_org`, the same pre-auth pattern
   * `resetPassword()` uses); the client supplies only the raw token and the
   * new password, never a userId/organisationId/workspaceId/role — even if
   * the request body carried one, `ActivateAccountDto`'s whitelist means it
   * would never reach here (`forbidNonWhitelisted`).
   *
   * Returns `applicationTarget` + `managerLoginUrl` (the same shape
   * `resetPassword()` already returns) so the public accounts-domain page
   * can show the right post-activation destination — a Manager/CEO continues
   * to the Manager Portal, Staff/Venue Manager are told to use the mobile
   * app, never redirected into the Manager web app. Unlike a reset token, an
   * `AccountInvite` carries no stored `applicationTarget` of its own (it's
   * never client-asserted at invite time), so this is always derived from
   * the invited user's actual assigned role — the same `core.user_role`/
   * `core.role` join `resetPassword()`'s own fallback path already uses.
   */
  async activateAccount(dto: { token: string; newPassword: string }): Promise<{ applicationTarget: ApplicationTarget; managerLoginUrl: string }> {
    const tokenHash = this.accountInviteService.hashToken(dto.token);
    const [org] = await this.dataSource.query<[{ organisationId: string; userId: string }]>(
      'SELECT * FROM core.auth_find_account_invite_org($1)',
      [tokenHash],
    );
    if (!org) {
      throw new BadRequestException('This activation link is invalid or has expired.');
    }

    const workspaceId = await this.workspaceResolver.resolveForUser(org.userId);
    const ctx: AuthContext = { organisationId: org.organisationId, workspaceId, userId: org.userId, role: '' };
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // P2.8 — a suspended organisation accepts no new invitation (owner's requirement 5). The
      // pending AccountInvite row and its normal expiry are left untouched — this only blocks the
      // redemption step, same pattern as the login/refresh checks elsewhere in this file.
      const [suspendedOrg] = await manager.query<Array<{ suspended_at: string | null }>>(
        `SELECT suspended_at FROM core.organisation WHERE id = $1`,
        [org.organisationId],
      );
      if (suspendedOrg?.suspended_at) {
        throw new BadRequestException('This activation link is invalid or has expired.');
      }

      const consumed = await this.accountInviteService.consume(manager, dto.token);
      if (!consumed) {
        throw new BadRequestException('This activation link is invalid or has expired.');
      }

      const user = await manager.findOneOrFail(User, { where: { id: consumed.userId } });

      const { valid, reasons } = checkPasswordStrength(dto.newPassword, user.email);
      if (!valid) {
        throw new BadRequestException(reasons.join(' '));
      }

      // Deliberately does NOT set status: ACTIVE here. Activation happens
      // only at the account's first successful login with this new
      // password (see login()) — this step only proves the staff member
      // received the invite and chose a password; it does not yet prove
      // they can actually authenticate with it. Status stays INVITED.
      const passwordHash = await this.passwordHashing.hash(dto.newPassword);
      const now = new Date();
      await manager.update(User, user.id, {
        passwordHash,
        mustResetPassword: false,
        emailVerifiedAt: now,
      });
      await this.securityVersion.bumpUser(manager, user.id);
      await this.auditService.record(manager, ctx, AuditAction.INVITE_ACCEPTED, { targetUserId: user.id });

      const roles = await manager.query('SELECT r.key FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = $1', [user.id]);
      const applicationTarget = (await this.platformAdmin.isPlatformAdminTx(manager, ctx)) ? 'manager_web' : defaultApplication(roles.map((r: { key: string }) => r.key));
      return { applicationTarget, managerLoginUrl: this.managerLoginUrl() };
    });
  }
}
