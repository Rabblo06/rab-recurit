import { ConflictException, ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import QRCode from 'qrcode';

import { AuditAction, AuditService } from '../../audit/audit.service';
import { EnvironmentService } from '../../environment/environment.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { base32Encode, formatManualKey, totpProvisioningUri } from '../mfa/totp';
import { AuthService, LoginResult, RequestMeta } from './auth.service';
import { MfaChallengeService, PendingLogin } from './mfa-challenge.service';
import { MfaFactorService } from './mfa-factor.service';
import { MfaSecurityNoticeService } from './mfa-security-notice.service';
import { SecurityVersionService } from './security-version.service';
import { RefreshTokenService } from '../token/services/refresh-token.service';

export interface EnrolmentMaterial {
  /** `otpauth://` URI — shown once (QR + "can't scan?" manual key), never stored or logged by the server. */
  otpauthUri: string;
  /** PNG data URL of the same URI, rendered server-side so no QR library or third-party service sees the secret. */
  qrDataUrl: string;
  manualKey: string;
}

/**
 * Account security step 1 — the challenge's failure answers are distinct, STABLE codes a client maps to its screens, each
 * with a `state` the clients can switch on:
 *   - MFA_CODE_INVALID (401, state `invalid_code`) + `attemptsRemaining`: the TRUE number of further attempts this
 *     challenge will accept, from the atomic Redis counter (AUTH_MFA_CHALLENGE_MAX_ATTEMPTS − attempts counted so far).
 *     0 means the next attempt is refused as exhausted — clients show "start again".
 *   - MFA_CHALLENGE_EXPIRED (401, state `expired`): unknown, malformed, expired, already-used or other-transport token —
 *     one identical body, so a token that never existed is indistinguishable from one that lapsed (non-enumerating).
 *   - MFA_CHALLENGE_EXHAUSTED (401, state `locked`): this challenge was destroyed by too many wrong codes.
 *   - MFA_RATE_LIMITED (429, state `locked`, Retry-After): the per-user attempt bucket (LoginAttemptLimiterService).
 * None of them carries any account detail (no email, no name, no remaining recovery codes).
 */
const CHALLENGE_GONE = { code: 'MFA_CHALLENGE_EXPIRED', state: 'expired', message: 'Your sign-in expired. Please sign in again.' } as const;
const CHALLENGE_EXHAUSTED = { code: 'MFA_CHALLENGE_EXHAUSTED', state: 'locked', message: 'Too many incorrect codes. Please sign in again.' } as const;
const CODE_INVALID_MESSAGE = 'That code didn’t work. Check your authenticator app and try again.';
const codeInvalid = (attemptsRemaining: number) => ({ code: 'MFA_CODE_INVALID', state: 'invalid_code', message: CODE_INVALID_MESSAGE, attemptsRemaining }) as const;
/** Attempts this challenge will still accept after the one just counted (never negative). */
const remainingAfter = (attempt: { attempt: number; maxAttempts: number }) => Math.max(0, attempt.maxAttempts - attempt.attempt);

/**
 * Wave 4 lane MFA — finishing a sign-in that `AuthService.completeLogin` turned into a challenge.
 *
 * verify (requirement `verify`): count the attempt on the challenge (atomic, bounded) → per-user attempt bucket →
 * check the TOTP (±1 step, replay-protected) or a recovery code (single use) in a transaction that COMMITS on its own
 * → consume the challenge (atomic DEL; exactly one caller wins) → `AuthService.completeChallengedLogin` (re-checks every
 * gate, issues the session). A failed code is audited; the response is uniform (no hint whether the code was "close").
 *
 * enrolment (requirement `enroll`, an enforced role without a factor): `startEnrolment` stages a fresh server-generated
 * secret for that account and returns the provisioning material once; `confirmEnrolment` checks a code against the
 * staged secret, stores ten hashed recovery codes, enables MFA (the confirming step is recorded, so it can never be
 * replayed), consumes the challenge and issues the session. The clear recovery codes are returned once with it.
 *
 * The transport is part of the binding: a challenge issued to the mobile app cannot be finished over web and vice versa.
 */
@Injectable()
export class MfaLoginService {
  private readonly logger = new Logger(MfaLoginService.name);

  constructor(
    private readonly challenges: MfaChallengeService,
    private readonly factors: MfaFactorService,
    private readonly authService: AuthService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly env: EnvironmentService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly securityVersion: SecurityVersionService,
    private readonly notices: MfaSecurityNoticeService,
  ) {}

  async verifyChallenge(token: unknown, code: unknown, mobile: boolean, meta: RequestMeta): Promise<LoginResult> {
    const { login, attempt } = await this.admitted(token, mobile, 'verify');
    await this.factors.admitAttempt(login.userId);
    const ctx = this.ctxFor(login);
    const verified = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const result = await this.factors.verify(manager, login.userId, code, { allowRecoveryCode: true });
      if (result) {
        await this.audit.record(manager, ctx, AuditAction.MFA_CHALLENGE_SUCCEEDED, { targetUserId: login.userId, metadata: { method: result.method, authProvider: login.authProvider } });
        if (result.method === 'recovery_code') {
          await this.audit.record(manager, ctx, AuditAction.MFA_RECOVERY_CODE_USED, { targetUserId: login.userId, metadata: { purpose: 'sign_in', remaining: result.recoveryCodesRemaining } });
        }
      }
      return result;
    });
    if (!verified) {
      await this.recordFailure(ctx, login, 'code');
      throw new UnauthorizedException(codeInvalid(remainingAfter(attempt)));
    }
    return this.finish(token as string, login, meta);
  }

  async startEnrolment(token: unknown, mobile: boolean): Promise<EnrolmentMaterial> {
    const { login } = await this.admitted(token, mobile, 'enroll');
    const ctx = this.ctxFor(login);
    const secret = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staged = await this.factors.stageNewSecret(manager, login.userId);
      if (staged) await this.audit.record(manager, ctx, AuditAction.MFA_ENROLMENT_STARTED, { targetUserId: login.userId, metadata: { during: 'sign_in' } });
      return staged;
    });
    // Already enabled (e.g. enrolled from another tab meanwhile): this challenge can no longer enrol.
    if (!secret) throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'Two-factor authentication is already set up. Please sign in again.' });
    return this.material(login.email, secret);
  }

  async confirmEnrolment(token: unknown, code: unknown, mobile: boolean, meta: RequestMeta): Promise<LoginResult & { recoveryCodes: string[] }> {
    const { login, attempt } = await this.admitted(token, mobile, 'enroll');
    await this.factors.admitAttempt(login.userId);
    const ctx = this.ctxFor(login);
    const enrolledOutcome = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const enrolled = await this.factors.confirmEnrolment(manager, login.userId, code);
      if (!enrolled) return null;
      await this.audit.record(manager, ctx, AuditAction.MFA_ENABLED, { targetUserId: login.userId, metadata: { during: 'sign_in', recoveryCodes: enrolled.length } });
      // Account security step 1 (P7): the account is told its factor was turned on (no secret or code in the email).
      return { enrolled, notice: await this.notices.enqueue(manager, login.organisationId, login.userId, 'enabled') };
    });
    const codes = enrolledOutcome?.enrolled ?? null;
    if (enrolledOutcome) this.notices.publish(enrolledOutcome.notice);
    if (!codes) {
      await this.recordFailure(ctx, login, 'enrolment_code');
      throw new UnauthorizedException(codeInvalid(remainingAfter(attempt)));
    }
    // Enabling MFA is a security change: the account's security version moves, which ends every other session and
    // would also invalidate this challenge's snapshot — so the pending login is refreshed to the new version first.
    const refreshed = { ...login, securityVersion: await this.bumpAndRevokeOthers(ctx) };
    const result = await this.finish(token as string, refreshed, meta);
    return { ...result, recoveryCodes: codes };
  }

  async cancel(token: unknown): Promise<void> {
    await this.challenges.discard(token);
  }

  /** QR (PNG data URL, rendered locally) + URI + grouped manual key. Exposed for authenticated enrolment too. */
  async material(accountName: string, secret: Buffer): Promise<EnrolmentMaterial> {
    const secretBase32 = base32Encode(secret);
    const otpauthUri = totpProvisioningUri({ issuer: this.env.get('AUTH_MFA_ISSUER'), accountName, secretBase32 });
    const qrDataUrl = await QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: 'M', margin: 1, width: 220 });
    return { otpauthUri, qrDataUrl, manualKey: formatManualKey(secretBase32) };
  }

  // ------------------------------------------------------------------ internals

  private async admitted(token: unknown, mobile: boolean, requirement: PendingLogin['requirement']): Promise<{ login: PendingLogin; attempt: { attempt: number; maxAttempts: number } }> {
    const attempt = await this.challenges.attempt(token);
    if (!attempt.ok) {
      throw new UnauthorizedException(attempt.reason === 'exhausted' ? CHALLENGE_EXHAUSTED : CHALLENGE_GONE);
    }
    // Bound to the transport the sign-in started on, and to the step it is waiting for.
    if (attempt.login.mobile !== mobile) throw new UnauthorizedException(CHALLENGE_GONE);
    if (attempt.login.requirement !== requirement) {
      throw new ForbiddenException({ code: 'MFA_WRONG_STEP', message: requirement === 'enroll' ? 'This sign-in needs your existing authenticator code.' : 'This sign-in needs two-factor setup first.' });
    }
    return { login: attempt.login, attempt: { attempt: attempt.attempt, maxAttempts: attempt.maxAttempts } };
  }

  private ctxFor(login: PendingLogin): AuthContext {
    return { organisationId: login.organisationId, workspaceId: null, userId: login.userId, role: '' };
  }

  /** Single use: only the caller whose DEL removed the challenge may issue the session. */
  private async finish(token: string, login: PendingLogin, meta: RequestMeta): Promise<LoginResult> {
    if (!(await this.challenges.consume(token))) throw new UnauthorizedException(CHALLENGE_GONE);
    return this.authService.completeChallengedLogin(login, meta);
  }

  /** Every session of the account ends (the challenge's sign-in gets a brand-new one) and its security version moves. */
  private async bumpAndRevokeOthers(ctx: AuthContext): Promise<number> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.refreshTokens.revokeAllForUser(manager, ctx.userId, 'mfa_enabled');
      await this.securityVersion.bumpUser(manager, ctx.userId);
      const [row] = await manager.query<Array<{ security_version: string | number }>>('SELECT security_version FROM core."user" WHERE id = $1', [ctx.userId]);
      return Number(row?.security_version);
    });
  }

  private async recordFailure(ctx: AuthContext, login: PendingLogin, reason: 'code' | 'enrolment_code'): Promise<void> {
    try {
      await this.tenantContext.runInTenantContext(ctx, (manager) =>
        this.audit.record(manager, ctx, AuditAction.MFA_CHALLENGE_FAILED, { targetUserId: login.userId, metadata: { reason, authProvider: login.authProvider } }),
      );
    } catch (error) {
      this.logger.warn(`mfa failure audit not written: ${(error as Error).message}`);
    }
  }
}
