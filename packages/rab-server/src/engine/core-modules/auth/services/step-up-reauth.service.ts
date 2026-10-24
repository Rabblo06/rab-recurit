import { createHash, randomBytes } from 'node:crypto';

import { ForbiddenException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import { AuditAction, AuditService } from '../../audit/audit.service';
import { EnvironmentService } from '../../environment/environment.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { AuthCacheRedisClientProvider } from './auth-cache-redis-client.provider';
import { MfaFactorService } from './mfa-factor.service';
import { PasswordHashingService } from './password-hashing.service';

type StepUpCtx = Pick<AuthContext, 'organisationId' | 'workspaceId' | 'userId'> & Partial<Pick<AuthContext, 'sessionId' | 'inspectedBy'>>;

export interface StepUpProof {
  currentPassword: string;
  /** Six-digit TOTP, or (where allowed) a one-time recovery code. */
  code?: string;
}

const PASSWORD_MESSAGE = 'Re-enter your current password to continue.';

/**
 * Lane D (M10-2): the sensitive operations gated by `assertRecentStepUp` (recorded on the refusal audit row). Adding an
 * operation = calling `assertRecentStepUp(ctx, '<action>')` in its service before any write, plus an abuse-case test.
 */
export const STEP_UP_ACTIONS = [
  'organisation.auth_providers.update',
  'platform.smtp_config.update',
  'platform.maintenance_mode.update',
  'platform.admin_inspect.start',
  'role.create',
  'role.update',
  'role.delete',
  'member.role.change',
  'member.suspend',
  'member.reinstate',
  'user.deactivate',
  'user.reactivate',
  'user.password_reset',
  'user.email.change',
  'user.pending_email.change',
] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

type FailureReason = 'password' | 'mfa_code' | 'mfa_code_missing' | 'step_up_required';

/**
 * P2.8 — "sudo mode" for destructive actions. The caller's EXISTING session already proves who they are; this proves
 * they can still produce the password (and, since wave 4, their second factor), right now — a hijacked-but-live session
 * (stolen cookie/token) cannot alone perform the action. It reuses the exact `PasswordHashingService` primitive login
 * uses and is timing-uniform with login's wrong-password path: an account with no password (OAuth-only) still runs one
 * real argon2 verify against a dummy hash. Every assertion THROWS (never a boolean a caller could forget to check).
 *
 * Wave 4 lane MFA — three entry points:
 *  - `assertPasswordAndSecondFactor(ctx, proof)`: password AND (if the account has MFA) a current code, inline in the
 *    same request. Used by MFA management (disable, regenerate recovery codes) and the platform-admin MFA reset — always,
 *    no flag. The code is replay-protected and burned in its own committed transaction.
 *  - `stepUp(ctx, proof)` + `assertRecentStepUp(ctx)`: `POST /auth/step-up` records a grant for THIS session (Redis,
 *    AUTH_STEP_UP_WINDOW_SECONDS, default 5 min; keyed by a hash of the session id); any service can then require a recent
 *    password+MFA proof without its own password field. Fail closed: Redis unavailable ⇒ 503.
 *  - `assertCurrentPassword(ctx, password, mfaCode?)`: the pre-existing password-only call sites (platform-admin
 *    grant/revoke, organisation suspend/reactivate, user deletion, email change). With
 *    AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS=true an enrolled actor must ALSO present `mfaCode` or hold a recent step-up.
 *    Default false until those dialogs gain a code field (see the security trade-off in WAVE4_LANE_MFA_REPORT.md).
 *
 * Lane D (M10-2) — `assertRecentStepUp` now HAS callers: every sensitive operation listed in `STEP_UP_ACTIONS` calls it
 * in its SERVICE (layer 2; a controller check alone would not count). A fresh credential sign-in (`completeLogin`:
 * password / Google / Microsoft, plus the second factor whenever the account has one) records the same grant for the
 * session it creates (`recordSignInGrant`) — OIDC `max_age` semantics: "authenticated within the window" — so a user
 * who has just signed in is not asked again, while a session that is older than the window (a stolen cookie, an
 * unattended machine) must re-prove password (+ code) through `POST /auth/step-up`. A refresh or a session restore never
 * creates a grant; a cross-host login handoff only carries the source session's grant over, with its ORIGINAL time.
 *
 * Admin Inspect contexts (`ctx.inspectedBy`) are always refused: an inspecting admin never re-authenticates as the target.
 * Every failure is audited (`auth.step_up_failed`, reason only) in a transaction of its own.
 */
@Injectable()
export class StepUpReauthService {
  private readonly logger = new Logger(StepUpReauthService.name);
  private dummyHashPromise?: Promise<string>;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly passwordHashing: PasswordHashingService,
    private readonly factors: MfaFactorService,
    private readonly audit: AuditService,
    private readonly env: EnvironmentService,
    private readonly redis: AuthCacheRedisClientProvider,
  ) {}

  private getDummyHash(): Promise<string> {
    this.dummyHashPromise ??= this.passwordHashing.hash(randomBytes(32).toString('hex'));
    return this.dummyHashPromise;
  }

  /**
   * Reads via `core.auth_find_password_hash_by_user_id` — a SECURITY DEFINER function, never a plain
   * `manager.findOne(User, { select: ['passwordHash'] })`. `RevokeUserPasswordHashSelectFromApp1786669800000` revoked
   * `rab_app`'s SELECT on `password_hash`; see `AuthFindPasswordHashByUserId1786703000000`.
   *
   * Wave 4: with AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS=true, an actor with MFA must also present `mfaCode` (TOTP only) or
   * hold a recent `/auth/step-up` grant for this session.
   */
  async assertCurrentPassword(ctx: StepUpCtx, currentPassword: string, mfaCode?: string): Promise<void> {
    this.refuseInspection(ctx);
    await this.verifyPassword(ctx, currentPassword);
    if (this.env.get('AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS') !== true) return;
    if (!(await this.hasMfa(ctx))) return;
    if (mfaCode !== undefined && mfaCode !== '') {
      await this.verifySecondFactor(ctx, mfaCode, false);
      return;
    }
    if (await this.hasRecentGrant(ctx, true)) return;
    await this.recordFailure(ctx, 'mfa_code_missing');
    throw new ForbiddenException({ code: 'STEP_UP_MFA_REQUIRED', message: 'Enter the code from your authenticator app to continue.' });
  }

  /**
   * Password AND — when the account has an enabled factor — a current code, both in this request. Returns which factor
   * was used (null when the account has none). `allowRecoveryCode` lets a user who lost their device still disable or
   * regenerate with a recovery code (single use).
   */
  async assertPasswordAndSecondFactor(ctx: StepUpCtx, proof: StepUpProof, opts: { allowRecoveryCode: boolean }): Promise<{ method: 'totp' | 'recovery_code' | null }> {
    this.refuseInspection(ctx);
    await this.verifyPassword(ctx, proof.currentPassword);
    if (!(await this.hasMfa(ctx))) return { method: null };
    const method = await this.verifySecondFactor(ctx, proof.code, opts.allowRecoveryCode);
    return { method };
  }

  /** `POST /auth/step-up`: proves password (+ factor when enrolled) and records a short grant for this session. */
  async stepUp(ctx: StepUpCtx, proof: StepUpProof): Promise<{ validUntil: string; mfa: boolean }> {
    if (!ctx.sessionId) throw new ForbiddenException(PASSWORD_MESSAGE);
    const { method } = await this.assertPasswordAndSecondFactor(ctx, proof, { allowRecoveryCode: false });
    const windowMs = this.env.get('AUTH_STEP_UP_WINDOW_SECONDS') * 1000;
    const grant = JSON.stringify({ u: ctx.userId, mfa: method !== null, at: Date.now() });
    try {
      await this.redis.client.set(this.grantKey(ctx.sessionId), grant, 'PX', windowMs);
    } catch (error) {
      throw this.unavailable(error);
    }
    await this.tenantContext.runInTenantContext({ ...ctx, role: '' } as AuthContext, (manager) =>
      this.audit.record(manager, ctx, AuditAction.STEP_UP_SUCCEEDED, { targetUserId: ctx.userId, metadata: { method: method ?? 'password' } }),
    );
    return { validUntil: new Date(Date.now() + windowMs).toISOString(), mfa: method !== null };
  }

  /**
   * A recent `stepUp()` on THIS session (same user, within the window). When the account has MFA, the grant must have
   * included the factor. Throws 403 STEP_UP_REQUIRED otherwise.
   */
  async assertRecentStepUp(ctx: StepUpCtx, action?: StepUpAction): Promise<void> {
    this.refuseInspection(ctx);
    const mfa = await this.hasMfa(ctx);
    if (await this.hasRecentGrant(ctx, mfa)) return;
    await this.recordFailure(ctx, 'step_up_required', action);
    // `mfa` tells the client which proof the dialog must collect (never anything about another account).
    throw new ForbiddenException({ code: 'STEP_UP_REQUIRED', mfa, message: 'Confirm it’s you to continue.' });
  }

  /**
   * Lane D (M10-2): a fresh credential sign-in counts as a step-up for the session it just created, for the same window
   * (`AUTH_STEP_UP_WINDOW_SECONDS`). Called ONLY by `AuthService.completeLogin` after the session is issued; `mfa` is true
   * only when the second factor was actually verified in this sign-in. Best effort: a Redis failure costs the user one
   * extra step-up prompt later and never fails the sign-in.
   */
  async recordSignInGrant(sessionId: string, userId: string, mfa: boolean): Promise<void> {
    const windowMs = this.env.get('AUTH_STEP_UP_WINDOW_SECONDS') * 1000;
    try {
      await this.redis.client.set(this.grantKey(sessionId), JSON.stringify({ u: userId, mfa, at: Date.now(), via: 'sign_in' }), 'PX', windowMs);
    } catch (error) {
      this.logger.warn(`sign-in step-up grant not recorded: ${(error as Error).message}`);
    }
  }

  /**
   * Lane D (M10-2): the cross-host login handoff replaces the source session with a new one; a grant the SOURCE session
   * held is carried over with its ORIGINAL timestamp and remaining lifetime (never extended, never created from nothing).
   * Best effort, same as above.
   */
  async carryGrantOver(sourceSessionId: string, targetSessionId: string, userId: string): Promise<void> {
    try {
      const raw = await this.redis.client.get(this.grantKey(sourceSessionId));
      if (!raw) return;
      const grant = JSON.parse(raw) as { u?: string; at?: number };
      if (grant.u !== userId || typeof grant.at !== 'number') return;
      const remaining = grant.at + this.env.get('AUTH_STEP_UP_WINDOW_SECONDS') * 1000 - Date.now();
      if (remaining <= 0) return;
      await this.redis.client.set(this.grantKey(targetSessionId), raw, 'PX', remaining);
      await this.redis.client.del(this.grantKey(sourceSessionId));
    } catch (error) {
      this.logger.warn(`step-up grant not carried over the login handoff: ${(error as Error).message}`);
    }
  }

  /** Ends any grant held by this session (after a disable/reset, or logout). Best effort. */
  async clearGrant(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    try {
      await this.redis.client.del(this.grantKey(sessionId));
    } catch (error) {
      this.logger.warn(`step-up grant clear failed: ${(error as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ internals

  private refuseInspection(ctx: StepUpCtx): void {
    if (ctx.inspectedBy) throw new ForbiddenException('This is not available while inspecting another account.');
  }

  private async verifyPassword(ctx: StepUpCtx, currentPassword: string): Promise<void> {
    const hash = await this.tenantContext.runInTenantContext({ ...ctx, role: '' } as AuthContext, async (manager) => {
      const [row] = await manager.query<Array<{ passwordHash: string | null }>>('SELECT "passwordHash" FROM core.auth_find_password_hash_by_user_id($1)', [ctx.userId]);
      return row?.passwordHash ?? null;
    });
    const valid = hash
      ? await this.passwordHashing.verify(hash, currentPassword)
      : await this.passwordHashing.verify(await this.getDummyHash(), currentPassword).then(() => false);
    if (!valid) {
      await this.recordFailure(ctx, 'password');
      throw new ForbiddenException(PASSWORD_MESSAGE);
    }
  }

  private async hasMfa(ctx: StepUpCtx): Promise<boolean> {
    return this.tenantContext.runInTenantContext({ ...ctx, role: '' } as AuthContext, async (manager) => (await this.factors.state(manager, ctx.userId))?.totpEnabled === true);
  }

  /** Burns the code in its OWN committed transaction (replay protection survives whatever the caller does next). */
  private async verifySecondFactor(ctx: StepUpCtx, code: string | undefined, allowRecoveryCode: boolean): Promise<'totp' | 'recovery_code'> {
    await this.factors.admitAttempt(ctx.userId);
    const verified = await this.tenantContext.runInTenantContext({ ...ctx, role: '' } as AuthContext, async (manager) => {
      const result = await this.factors.verify(manager, ctx.userId, code, { allowRecoveryCode });
      if (result?.method === 'recovery_code') {
        await this.audit.record(manager, ctx, AuditAction.MFA_RECOVERY_CODE_USED, { targetUserId: ctx.userId, metadata: { purpose: 'step_up', remaining: result.recoveryCodesRemaining } });
      }
      return result;
    });
    if (!verified) {
      await this.recordFailure(ctx, 'mfa_code');
      throw new ForbiddenException({ code: 'STEP_UP_MFA_INVALID', message: 'That code didn’t work. Enter the current code from your authenticator app.' });
    }
    return verified.method;
  }

  private async hasRecentGrant(ctx: StepUpCtx, requireMfa: boolean): Promise<boolean> {
    if (!ctx.sessionId) return false;
    let raw: string | null;
    try {
      raw = await this.redis.client.get(this.grantKey(ctx.sessionId));
    } catch (error) {
      throw this.unavailable(error);
    }
    if (!raw) return false;
    try {
      const grant = JSON.parse(raw) as { u?: string; mfa?: boolean; at?: number };
      if (grant.u !== ctx.userId || typeof grant.at !== 'number') return false;
      if (Date.now() - grant.at > this.env.get('AUTH_STEP_UP_WINDOW_SECONDS') * 1000) return false;
      return requireMfa ? grant.mfa === true : true;
    } catch {
      return false;
    }
  }

  private grantKey(sessionId: string): string {
    return `crewflow:${this.env.get('NODE_ENV')}:step-up:${createHash('sha256').update(sessionId).digest('hex')}`;
  }

  /** Audits a refused step-up in its own transaction (it must survive the request's failure). Never throws. */
  private async recordFailure(ctx: StepUpCtx, reason: FailureReason, action?: StepUpAction): Promise<void> {
    try {
      await this.tenantContext.runInTenantContext({ ...ctx, role: '' } as AuthContext, (manager) =>
        this.audit.record(manager, ctx, AuditAction.STEP_UP_FAILED, { targetUserId: ctx.userId, metadata: action ? { reason, action } : { reason } }),
      );
    } catch (error) {
      this.logger.warn(`step-up failure audit not written: ${(error as Error).message}`);
    }
  }

  private unavailable(error: unknown): ServiceUnavailableException {
    this.logger.warn(`step-up grant store unavailable (Redis): ${(error as Error)?.message ?? 'unknown'}; refused with 503`);
    return new ServiceUnavailableException({ statusCode: HttpStatus.SERVICE_UNAVAILABLE, code: 'STEP_UP_UNAVAILABLE', message: 'This is temporarily unavailable. Try again in a moment.', retryAfter: 5 });
  }
}
