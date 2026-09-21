import { ApplicationTarget, applicationAllowed, applicationDenied, defaultApplication } from '../application-access';
import { assertTransition, checkPasswordStrength, EmailOutboxJobType, normalizeEmail, PasswordResetTokenPurpose, USER_STATUS_TRANSITIONS, UserStatus } from '@rab/shared';
import { BadRequestException, ConflictException, HttpException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
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
import { PasswordResetTokenService } from '../token/services/password-reset-token.service';
import { RefreshTokenReuseError } from '../token/services/refresh-token-reuse.error';
import { RefreshTokenService } from '../token/services/refresh-token.service';
import { AccessTokenService } from '../token/services/access-token.service';
import { PasswordHashingService } from './password-hashing.service';

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_THRESHOLD = 10;

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult extends AuthTokens {
  mustResetPassword: boolean;
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
    // Both raw, parameterized calls into the SECURITY DEFINER functions from
    // PreAuthLookupFunctions1786667400000 — see that migration's own doc
    // comment for why a plain unscoped read/count against these tables no
    // longer works under the app's real runtime role (rab_app), and why a
    // narrow function is the fix rather than a broad SELECT policy.
    const [{ count: recentFailuresRaw }] = await this.dataSource.query<[{ count: string }]>(
      'SELECT core.auth_count_recent_login_failures($1, $2) AS count',
      [email, new Date(Date.now() - LOCKOUT_WINDOW_MS)],
    );
    const recentFailures = Number(recentFailuresRaw);

    if (recentFailures >= LOCKOUT_THRESHOLD) {
      // Deliberately a distinct message — lockout state is not the secret
      // wrong-credentials responses protect (see the timing/message-uniform
      // check below), and telling a legitimate user to wait is more useful
      // than reusing "invalid email or password".
      throw new HttpException({ message: 'Too many sign-in attempts. Please try again in 15 minutes.', retryAfter: 900 }, 429);
    }

    const candidates = await this.dataSource.query<LoginCandidate[]>(
      'SELECT * FROM core.auth_find_users_by_email($1)',
      [email],
    );

    // Wrong-email and wrong-password must be indistinguishable in timing
    // and message — always run at least one argon2 verify, against a real
    // hash if any candidate exists, a dummy one otherwise.
    let matched: LoginCandidate | null = null;
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
          matched = candidate;
          break;
        }
      }
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
    const user = matched;

    const sid = randomUUID();
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
    const applicationTarget = mobile && !dto.applicationTarget
      ? (roles.includes('venue_manager') ? 'venue_manager_app' : 'staff_app')
      : dto.applicationTarget ?? 'manager_web';
    if (!applicationAllowed(roles, applicationTarget, await this.platformAdmin.isPlatformAdmin(ctx))) {
      await this.tenantContext.runInTenantContext(ctx, manager => this.auditService.record(manager, ctx, AuditAction.APPLICATION_ACCESS_DENIED, { metadata: { applicationTarget } }));
      throw applicationDenied(applicationTarget);
    }
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await manager.query('INSERT INTO core.login_history (organisation_id, user_id, email, ip, user_agent, success) VALUES ($1, $2, $3, $4, $5, true)', [user.organisationId, user.id, email, meta.ip ?? null, meta.userAgent ?? null]);
      await this.auditService.record(manager, ctx, AuditAction.USER_LOGIN, { metadata: { applicationTarget } });
      const accessToken = this.accessTokenService.sign({
        sub: user.id,
        org: user.organisationId,
        roles,
        applicationTarget,
        sid,
      });
      const issued = await this.refreshTokenService.issue(manager, {
        organisationId: user.organisationId,
        userId: user.id,
        familyId: sid,
        applicationTarget,
        userAgent: meta.userAgent,
        ip: meta.ip,
      });

      if (user.status === UserStatus.INVITED) {
        // First successful login with a password set via activate-account —
        // this is the one and only place an account transitions to ACTIVE.
        // A conditional, atomic UPDATE (not a plain manager.update()) so two
        // concurrent first-logins for the same account can't both "win" and
        // double-fire the audit/welcome email below — mirrors
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

      return { accessToken, refreshToken: issued.token, mustResetPassword: user.mustResetPassword };
    });
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
      if ((requestedTarget && requestedTarget !== target) || !applicationAllowed(rows.map((r: {key: string}) => r.key), target, await this.platformAdmin.isPlatformAdminTx(manager, ctx))) throw applicationDenied(requestedTarget ?? target);
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
          await this.refreshTokenService.revokeFamily(manager, error.familyId);
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

      const accessToken = this.accessTokenService.sign({
        sub: rotated.userId,
        org: rotated.organisationId,
        roles: roleRows.map((r) => r.key),
        sid: rotated.issued.familyId,
        applicationTarget: rotated.applicationTarget,
      });

      return { accessToken, refreshToken: rotated.issued.token };
    });
  }

  async logout(ctx: AuthContext, refreshToken: string): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.refreshTokenService.revokeByToken(manager, refreshToken);
      await this.auditService.record(manager, ctx, AuditAction.USER_LOGOUT, {});
    });
  }

  /**
   * Backs `GET /auth/me` — the console's own identity, never another
   * user's. `mustResetPassword` is included so a client can reactively
   * detect the forced-reset state after an app restart / page refresh, not
   * only from the one-off login response — `/auth/me` is the one endpoint
   * `MustResetPasswordGuard` always exempts, so it stays callable either way.
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
  }> {
    const [result, isPlatformAdmin] = await Promise.all([
      this.tenantContext.runInTenantContext(ctx, async (manager) => {
        const user = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
        const roleRows = await manager
          .createQueryBuilder(UserRole, 'ur')
          .innerJoin(Role, 'r', 'r.id = ur.role_id')
          .where('ur.user_id = :userId', { userId: ctx.userId })
          .select('r.key', 'key')
          .getRawMany<{ key: string }>();

        return {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          organisationId: user.organisationId,
          roles: roleRows.map((r) => r.key),
          mustResetPassword: user.mustResetPassword,
        };
      }),
      this.platformAdmin.isPlatformAdmin(ctx),
    ]);

    return { ...result, isPlatformAdmin };
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
      await this.refreshTokenService.revokeAllForUser(manager, user.id);
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
  async forgotPassword(dto: { email: string; applicationTarget?: ApplicationTarget }, mobile = false): Promise<void> {
    // Mobile reset links return to one universal login; this is navigation only.
    if (mobile) dto = { email: dto.email, applicationTarget: 'staff_app' };
    const candidates = await this.dataSource.query<LoginCandidate[]>(
      'SELECT * FROM core.auth_find_users_by_email($1)',
      [normalizeEmail(dto.email)],
    );
    const users = candidates.filter((c) => c.status === UserStatus.ACTIVE);

    for (const user of users) {
      const workspaceId = await this.workspaceResolver.resolveForUser(user.id);
      const ctx: AuthContext = { organisationId: user.organisationId, workspaceId, userId: user.id, role: '' };
      await this.tenantContext.runInTenantContext(ctx, async (manager) => {
        const { id: tokenId, token } = await this.passwordResetTokenService.issue(manager, {
          organisationId: user.organisationId,
          userId: user.id,
          purpose: PasswordResetTokenPurpose.FORGOT_PASSWORD,
          applicationTarget: dto.applicationTarget,
          ttlMs: 60 * 60 * 1000, // 1h — shorter than the 48h invite/admin-reset default, this one's self-triggered and time-sensitive
        });
        const resetUrl = `${this.env.get('APP_URL')}/reset-password?token=${token}${dto.applicationTarget ? `&applicationTarget=${dto.applicationTarget}` : ''}`;
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
   * Runs pre-auth, same as `refresh()` — the presented token's hash is
   * looked up via the narrow `core.auth_find_password_reset_token_org`
   * SECURITY DEFINER function (PreAuthLookupFunctions1786667400000) just to
   * learn which org to bind context to; the actual consume (validity,
   * expiry, single-use enforcement) then runs inside `runInTenantContext`
   * for that org, through the normal RLS-enforced path.
   */
  async resetPassword(dto: { token: string; newPassword: string }): Promise<{ applicationTarget: ApplicationTarget }> {
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
      const { valid, reasons } = checkPasswordStrength(dto.newPassword, user.email);
      if (!valid) {
        throw new BadRequestException(reasons.join(' '));
      }

      const passwordHash = await this.passwordHashing.hash(dto.newPassword);
      await manager.update(User, user.id, { passwordHash, mustResetPassword: false });
      await this.refreshTokenService.revokeAllForUser(manager, user.id);
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
      return { applicationTarget: consumed.applicationTarget ?? (await this.platformAdmin.isPlatformAdminTx(manager, ctx) ? 'manager_web' : defaultApplication(roles.map((r: {key: string}) => r.key))) };
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
   */
  async activateAccount(dto: { token: string; newPassword: string }): Promise<void> {
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
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
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
      await this.auditService.record(manager, ctx, AuditAction.INVITE_ACCEPTED, { targetUserId: user.id });
    });
  }
}
