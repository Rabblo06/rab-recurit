import { checkPasswordStrength, PasswordResetTokenPurpose, UserStatus } from '@rab/shared';
import { BadRequestException, ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource, MoreThan } from 'typeorm';

import { LoginHistory, Organisation, Role, User, UserRole } from '../../../../modules/identity/entities';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { EnvironmentService } from '../../environment/environment.service';
import { EmailService } from '../../email/email.service';
import { renderPasswordResetEmail, renderPasswordUpdatedEmail, renderWelcomeEmail } from '../../email/templates';
import { AuthContext } from '../../tenant/auth-context.interface';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { PlatformAdminService } from '../../platform-admin/platform-admin.service';
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
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
    private readonly env: EnvironmentService,
    private readonly platformAdmin: PlatformAdminService,
  ) {}

  /**
   * A security notice, not blocking — a flaky SMTP server must never
   * prevent the password change itself from completing. Never called for
   * the very first password an account ever gets (see `resetPassword`'s
   * `INITIAL_SETUP` branch, which sends a welcome email instead).
   */
  private async sendPasswordUpdatedEmail(email: string, firstName: string): Promise<void> {
    const { subject, html, text } = renderPasswordUpdatedEmail({ firstName });
    try {
      await this.emailService.send({ to: email, subject, html, text });
    } catch (error) {
      this.logger.error(`Password-updated notice failed to send to ${email}`, error as Error);
    }
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
  async login(dto: { email: string; password: string }, meta: RequestMeta): Promise<LoginResult> {
    const recentFailures = await this.dataSource.manager.count(LoginHistory, {
      where: {
        email: dto.email,
        success: false,
        createdAt: MoreThan(new Date(Date.now() - LOCKOUT_WINDOW_MS)),
      },
    });

    if (recentFailures >= LOCKOUT_THRESHOLD) {
      // Deliberately a distinct message — lockout state is not the secret
      // wrong-credentials responses protect (see the timing/message-uniform
      // check below), and telling a legitimate user to wait is more useful
      // than reusing "invalid email or password".
      throw new UnauthorizedException('Too many failed attempts. Try again later.');
    }

    const candidates = await this.dataSource.manager
      .createQueryBuilder(User, 'u')
      .addSelect('u.passwordHash')
      .where('u.email = :email', { email: dto.email })
      .andWhere('u.deletedAt IS NULL')
      .getMany();

    // Wrong-email and wrong-password must be indistinguishable in timing
    // and message — always run at least one argon2 verify, against a real
    // hash if any candidate exists, a dummy one otherwise.
    let matched: User | null = null;
    if (candidates.length === 0) {
      await this.passwordHashing.verify(await this.getDummyHash(), dto.password);
    } else {
      for (const candidate of candidates) {
        const valid = await this.passwordHashing.verify(candidate.passwordHash, dto.password);
        if (valid && candidate.status === UserStatus.ACTIVE) {
          matched = candidate;
          break;
        }
      }
    }

    await this.dataSource.manager.insert(LoginHistory, {
      organisationId: matched?.organisationId,
      userId: matched?.id,
      email: dto.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      success: Boolean(matched),
    });

    if (!matched) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    const user = matched;

    const sid = randomUUID();
    const ctx: AuthContext = { organisationId: user.organisationId, userId: user.id, role: '' };

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const roleRows = await manager
        .createQueryBuilder(UserRole, 'ur')
        .innerJoin(Role, 'r', 'r.id = ur.role_id')
        .where('ur.user_id = :userId', { userId: user.id })
        .select('r.key', 'key')
        .getRawMany<{ key: string }>();
      const roles = roleRows.map((r) => r.key);

      const accessToken = this.accessTokenService.sign({
        sub: user.id,
        org: user.organisationId,
        roles,
        sid,
      });
      const issued = await this.refreshTokenService.issue(manager, {
        organisationId: user.organisationId,
        userId: user.id,
        familyId: sid,
        userAgent: meta.userAgent,
        ip: meta.ip,
      });
      await manager.update(User, user.id, { lastLoginAt: new Date() });

      return { accessToken, refreshToken: issued.token, mustResetPassword: user.mustResetPassword };
    });
  }

  /**
   * Reuse detection: `RefreshTokenService.rotate` already revoked the whole
   * family by the time it throws `RefreshTokenReuseError` — this just turns
   * that into the right HTTP response. (`AUTH_REFRESH_REUSE` audit event
   * lands with the audit writer in a later PR — not built yet.)
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthTokens> {
    // The presented token identifies the org — pre-auth here too, so this
    // runs against the unscoped connection, matching AuthService.login.
    let rotated: Awaited<ReturnType<RefreshTokenService['rotate']>>;
    try {
      rotated = await this.refreshTokenService.rotate(this.dataSource.manager, refreshToken, {
        userAgent: meta.userAgent,
        ip: meta.ip,
      });
    } catch (error) {
      if (error instanceof RefreshTokenReuseError) {
        throw new UnauthorizedException('Refresh token reuse detected — session revoked. Please log in again.');
      }
      throw error;
    }

    const ctx: AuthContext = {
      organisationId: rotated.organisationId,
      userId: rotated.userId,
      role: '',
    };

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
      await this.sendPasswordUpdatedEmail(user.email, user.firstName);
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
  async forgotPassword(dto: { email: string }): Promise<void> {
    const users = await this.dataSource.manager.find(User, {
      where: { email: dto.email, status: UserStatus.ACTIVE },
    });

    for (const user of users) {
      const ctx: AuthContext = { organisationId: user.organisationId, userId: user.id, role: '' };
      await this.tenantContext.runInTenantContext(ctx, async (manager) => {
        const { token } = await this.passwordResetTokenService.issue(manager, {
          organisationId: user.organisationId,
          userId: user.id,
          purpose: PasswordResetTokenPurpose.FORGOT_PASSWORD,
          ttlMs: 60 * 60 * 1000, // 1h — shorter than the 48h invite/admin-reset default, this one's self-triggered and time-sensitive
        });
        const resetUrl = `${this.env.get('APP_URL')}/reset-password?token=${token}`;
        const { subject, html, text } = renderPasswordResetEmail({
          firstName: user.firstName,
          resetUrl,
          selfRequested: true,
        });
        try {
          await this.emailService.send({ to: user.email, subject, html, text });
        } catch (error) {
          this.logger.error(`Forgot-password email failed to send to ${user.email}`, error as Error);
        }
        await this.auditService.record(manager, ctx, AuditAction.PASSWORD_RESET_REQUESTED, { targetUserId: user.id });
      });
    }
  }

  /**
   * Runs pre-auth, same as `refresh()` — the presented token is what
   * identifies which organisation/user this is for, so it's looked up by
   * hash against the unscoped owner connection before any tenant context
   * can be bound (`password_reset_token`'s RLS exception, mirroring
   * `refresh_token`'s).
   */
  async resetPassword(dto: { token: string; newPassword: string }): Promise<void> {
    const consumed = await this.passwordResetTokenService.consume(this.dataSource.manager, dto.token);
    if (!consumed) {
      throw new BadRequestException('This reset link is invalid or has expired.');
    }

    const ctx: AuthContext = { organisationId: consumed.organisationId, userId: consumed.userId, role: '' };
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
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
        const { subject, html, text } = renderWelcomeEmail({ firstName: user.firstName, organisationName: organisation.name });
        try {
          await this.emailService.send({ to: user.email, subject, html, text });
        } catch (error) {
          this.logger.error(`Welcome email failed to send to ${user.email}`, error as Error);
        }
      } else {
        await this.sendPasswordUpdatedEmail(user.email, user.firstName);
      }
    });
  }
}
