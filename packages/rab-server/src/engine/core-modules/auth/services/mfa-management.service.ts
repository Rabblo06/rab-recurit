import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../audit/audit.service';
import { EnvironmentService } from '../../environment/environment.service';
import { PlatformAdminService } from '../../platform-admin/platform-admin.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { RECOVERY_CODE_COUNT } from '../mfa/recovery-codes';
import { RefreshTokenService } from '../token/services/refresh-token.service';
import { LoginAttemptLimiterService } from './login-attempt-limiter.service';
import { LoginSecondFactorPolicyService } from './login-second-factor-policy.service';
import { MfaFactorService } from './mfa-factor.service';
import { EnrolmentMaterial, MfaLoginService } from './mfa-login.service';
import { MfaSecurityNoticeService } from './mfa-security-notice.service';
import { OidcReauthService, SsoReauthProvider } from './oidc-reauth.service';
import { SecurityVersionService } from './security-version.service';
import { OptionalPasswordProof, StepUpReauthService } from './step-up-reauth.service';

export interface MfaStatus {
  enabled: boolean;
  /** When the current factor was confirmed (ISO), or null. */
  enabledAt: string | null;
  recoveryCodesRemaining: number;
  /** Size of a recovery-code set (always generated in full); "8 of 10 remaining". 0 while MFA is off. */
  recoveryCodesTotal: number;
  /** An enforcement flag applies to this account: it cannot switch MFA off, and must enrol at its next sign-in if it has none. */
  enforced: boolean;
  /** New enrolments are allowed by this deployment (AUTH_MFA_ENROLMENT_ENABLED). */
  enrolmentAvailable: boolean;
  /** Whether mobile-app sign-ins are challenged. Since step 1: exactly when a factor is enrolled (every role, every app). */
  mobileChallenged: boolean;
  /** Whether the account has a password (so a client asks for "Current password" or offers the SSO re-authentication). */
  hasPassword: boolean;
  /** Providers linked to this account (display only). */
  linkedProviders: SsoReauthProvider[];
  /** Linked providers this account can re-authenticate with RIGHT NOW (supported for re-auth and enabled for the org). */
  ssoReauthProviders: SsoReauthProvider[];
}

export interface AdminMfaResetInput extends OptionalPasswordProof {
  reason: string;
}

const REASON_MIN = 3;
const REASON_MAX = 500;

/**
 * Wave 4 lane MFA — the signed-in user's own second factor (status, enrol, confirm, regenerate recovery codes, disable)
 * and the platform administrator's reset of ANOTHER user's factor. Business rules live here (CLAUDE.md layer 2), so the
 * controller is a transport adapter only and any future caller (CLI, job) gets the same checks.
 *
 * Account security step 1 (owner policy 2026-10-24): 2FA is optional for every role on every app; once enrolled it is
 * verified at every sign-in. The self-service routes are reachable from manager_web AND both mobile apps.
 *
 * Rules:
 *  - Admin Inspect contexts are refused for every mutation (an inspecting admin never changes the target's factor).
 *  - Starting enrolment needs proof of identity NOW: the current password, or a fresh step-up / SSO re-authentication
 *    grant of this session (`StepUpReauthService.assertIdentityProof`). Otherwise a stolen session could bind ITS
 *    authenticator to the victim's account and lock the owner out at the next sign-in.
 *  - Confirming needs a valid code for the staged secret; it enables MFA, records the confirming step (no replay), stores
 *    ten hashed recovery codes (returned once), ends every OTHER session of the account (security version bumped) and
 *    emails the account.
 *  - Disable and recovery-code regeneration need the same identity proof AND a current code (TOTP or a recovery code)
 *    in the same request: one compromised session can never silently remove or re-key the factor. Disable is refused
 *    while an enforcement flag applies, ends every other session, bumps the security version, leaves no secret, no
 *    replay counter and no recovery code behind (core.mfa_disable), and emails the account.
 *  - Admin reset (P4): platform admin only (guard + this service), never on themselves, a required reason, a per-admin
 *    rate limit, `assertRecentStepUp(ctx, 'user.mfa.reset')` semantics (fresh password or SSO re-auth, + the admin's own
 *    code ONLY if the admin is enrolled — an admin is never forced to enrol). The target must currently have a factor
 *    (409 MFA_NOT_ENABLED otherwise). A target who is an ACTIVE PLATFORM ADMINISTRATOR is refused (409
 *    MFA_RESET_REQUIRES_SECOND_ADMIN, audited): independent authorisation for that case is not designed yet, so it fails
 *    closed. A reset clears the factor and every recovery code, ends ALL the target's sessions and refresh tokens, bumps
 *    their security version, is audited in both organisations with the reason, and emails the target.
 */
@Injectable()
export class MfaManagementService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly factors: MfaFactorService,
    private readonly stepUp: StepUpReauthService,
    private readonly policy: LoginSecondFactorPolicyService,
    private readonly mfaLogin: MfaLoginService,
    private readonly audit: AuditService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly securityVersion: SecurityVersionService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly env: EnvironmentService,
    private readonly limiter: LoginAttemptLimiterService,
    private readonly notices: MfaSecurityNoticeService,
    private readonly reauth: OidcReauthService,
  ) {}

  async status(ctx: AuthContext): Promise<MfaStatus> {
    const { state, linked } = await this.tenantContext.runInTenantContext(ctx, async (manager) => ({
      state: await this.factors.state(manager, ctx.userId),
      linked: await this.reauth.linkedProviders(manager, ctx.userId),
    }));
    if (!state) throw new NotFoundException();
    return {
      enabled: state.totpEnabled,
      enabledAt: state.totpEnabled && state.enabledAt ? state.enabledAt.toISOString() : null,
      recoveryCodesRemaining: state.totpEnabled ? state.recoveryCodesRemaining : 0,
      recoveryCodesTotal: state.totpEnabled ? RECOVERY_CODE_COUNT : 0,
      enforced: await this.isEnforced(ctx),
      enrolmentAvailable: this.env.get('AUTH_MFA_ENROLMENT_ENABLED') === true,
      // Step 1 (P1): an enrolled factor is verified on every app for every role; nothing is challenged without one.
      mobileChallenged: state.totpEnabled,
      hasPassword: await this.stepUp.hasPassword(ctx),
      linkedProviders: linked,
      ssoReauthProviders: await this.reauth.availableProviders(ctx, linked),
    };
  }

  async startEnrolment(ctx: AuthContext, proof: OptionalPasswordProof): Promise<EnrolmentMaterial> {
    this.refuseInspection(ctx);
    if (this.env.get('AUTH_MFA_ENROLMENT_ENABLED') !== true) throw new ForbiddenException({ code: 'MFA_ENROLMENT_DISABLED', message: 'Two-factor setup is not available right now.' });
    // No factor exists yet, so the proof is identity only (password or a fresh step-up / SSO re-auth grant).
    await this.stepUp.assertIdentityProof(ctx, { currentPassword: proof.currentPassword }, { requireFactor: false, allowRecoveryCode: false });
    const { secret, email } = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staged = await this.factors.stageNewSecret(manager, ctx.userId);
      if (!staged) return { secret: null, email: '' };
      await this.audit.record(manager, ctx, AuditAction.MFA_ENROLMENT_STARTED, { targetUserId: ctx.userId, metadata: { during: 'settings', applicationTarget: ctx.applicationTarget ?? null } });
      const [row] = await manager.query<Array<{ email: string }>>('SELECT email FROM core."user" WHERE id = $1', [ctx.userId]);
      return { secret: staged, email: row?.email ?? '' };
    });
    if (!secret) throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'Two-factor authentication is already on.' });
    // The otpauth:// URI is returned for same-phone setup; it is never logged or stored in clear by the server.
    return this.mfaLogin.material(email, secret);
  }

  async confirmEnrolment(ctx: AuthContext, code: string): Promise<{ recoveryCodes: string[] }> {
    this.refuseInspection(ctx);
    await this.factors.admitAttempt(ctx.userId);
    const outcome = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const enrolled = await this.factors.confirmEnrolment(manager, ctx.userId, code);
      if (!enrolled) return null;
      await this.audit.record(manager, ctx, AuditAction.MFA_ENABLED, { targetUserId: ctx.userId, metadata: { during: 'settings', recoveryCodes: enrolled.length, applicationTarget: ctx.applicationTarget ?? null } });
      await this.endOtherSessions(manager, ctx, 'mfa_enabled');
      const notice = await this.notices.enqueue(manager, ctx.organisationId!, ctx.userId, 'enabled');
      return { enrolled, notice };
    });
    if (!outcome) {
      await this.recordFailure(ctx, 'enrolment_code');
      throw new UnauthorizedException({ code: 'MFA_CODE_INVALID', message: 'That code didn’t work. Check your authenticator app and try again.' });
    }
    this.notices.publish(outcome.notice);
    return { recoveryCodes: outcome.enrolled };
  }

  async regenerateRecoveryCodes(ctx: AuthContext, proof: OptionalPasswordProof): Promise<{ recoveryCodes: string[] }> {
    this.refuseInspection(ctx);
    const { method } = await this.stepUp.assertIdentityProof(ctx, proof, { requireFactor: true, allowRecoveryCode: true });
    if (method === null) throw new ConflictException({ code: 'MFA_NOT_ENABLED', message: 'Two-factor authentication is off.' });
    const { codes, notice } = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const fresh = await this.factors.regenerateRecoveryCodes(manager, ctx.userId);
      await this.audit.record(manager, ctx, AuditAction.MFA_RECOVERY_CODES_REGENERATED, { targetUserId: ctx.userId, metadata: { count: fresh.length, provedWith: method } });
      return { codes: fresh, notice: await this.notices.enqueue(manager, ctx.organisationId!, ctx.userId, 'recovery_codes_regenerated') };
    });
    this.notices.publish(notice);
    return { recoveryCodes: codes };
  }

  async disable(ctx: AuthContext, proof: OptionalPasswordProof): Promise<void> {
    this.refuseInspection(ctx);
    // Policy first (no code is burned for a request that can never succeed).
    if (await this.isEnforced(ctx)) throw new ForbiddenException({ code: 'MFA_REQUIRED_BY_POLICY', message: 'Two-factor authentication is required for your account and can’t be turned off.' });
    const { method } = await this.stepUp.assertIdentityProof(ctx, proof, { requireFactor: true, allowRecoveryCode: true });
    if (method === null) throw new ConflictException({ code: 'MFA_NOT_ENABLED', message: 'Two-factor authentication is already off.' });
    const notice = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      if (!(await this.factors.disable(manager, ctx.userId))) throw new ConflictException({ code: 'MFA_NOT_ENABLED', message: 'Two-factor authentication is already off.' });
      await this.audit.record(manager, ctx, AuditAction.MFA_DISABLED, { targetUserId: ctx.userId, metadata: { provedWith: method } });
      await this.endOtherSessions(manager, ctx, 'mfa_disabled');
      return this.notices.enqueue(manager, ctx.organisationId!, ctx.userId, 'disabled');
    });
    this.notices.publish(notice);
    await this.stepUp.clearGrant(ctx.sessionId);
  }

  async adminReset(actorCtx: AuthContext, targetUserId: string, input: AdminMfaResetInput): Promise<{ reset: true; revokedSessions: number }> {
    this.refuseInspection(actorCtx);
    // Layer 2: never rely on the route guard alone.
    if (!(await this.platformAdmin.isPlatformAdmin(actorCtx))) throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
    if (targetUserId === actorCtx.userId) throw new BadRequestException({ code: 'MFA_RESET_SELF', message: 'Use your own security settings to change your two-factor authentication.' });
    // Layer 2 for the reason too (the DTO already trims and bounds it; a CLI/job caller has no DTO).
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      throw new BadRequestException({ code: 'MFA_RESET_REASON_REQUIRED', message: `Give a reason for the reset (${REASON_MIN}–${REASON_MAX} characters).` });
    }
    // Per-admin limit BEFORE the proof: a wrong password or code still costs the attempt.
    await this.limiter.admitAdminMfaReset(actorCtx.userId);
    // Fresh password or SSO re-auth (inline or a step-up grant of this session), + own code ONLY when the admin is enrolled.
    await this.stepUp.assertProofOrRecentStepUp(actorCtx, 'user.mfa.reset', { currentPassword: input.currentPassword, code: input.code });

    const outcome = await this.tenantContext.runInTenantContext(actorCtx, async (manager) => {
      const [membership] = await manager.query<Array<{ organisation_id: string }>>('SELECT organisation_id FROM core.resolve_membership_for_user($1)', [targetUserId]);
      // resolve_membership_for_user rebinds the GUCs itself; restore the actor's binding before the next step either way.
      await this.bind(manager, actorCtx);
      if (!membership) return { kind: 'not_found' as const };
      const targetOrg = membership.organisation_id;

      // Fail closed: resetting ANOTHER PLATFORM ADMINISTRATOR's factor needs independent authorisation (a second admin or
      // a verified recovery procedure) that does not exist yet. Refused and audited; nothing changes.
      if (await this.platformAdmin.isPlatformAdminTx(manager, { userId: targetUserId })) {
        await this.audit.record(manager, actorCtx, AuditAction.MFA_RESET_REFUSED, { targetUserId, metadata: { refusal: 'target_is_platform_admin', reason, targetOrganisationId: targetOrg } });
        return { kind: 'target_is_platform_admin' as const };
      }

      let revokedSessions = 0;
      let notice: { id: string; organisationId: string } | null = null;
      await this.bind(manager, { organisationId: targetOrg, userId: actorCtx.userId });
      try {
        const state = await this.factors.state(manager, targetUserId);
        if (!state) return { kind: 'not_found' as const };
        if (!state.totpEnabled) return { kind: 'not_enabled' as const };
        if (!(await this.factors.disable(manager, targetUserId))) return { kind: 'not_enabled' as const };
        const [, count] = await manager.query<[unknown[], number]>(
          `UPDATE core.user_session SET revoked_at = now(), revoked_reason = 'mfa_reset_by_admin', security_version = security_version + 1 WHERE user_id = $1 AND revoked_at IS NULL`,
          [targetUserId],
        );
        revokedSessions = count ?? 0;
        await manager.query('UPDATE core.refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [targetUserId]);
        await this.securityVersion.bumpUser(manager, targetUserId);
        // The target organisation's own audit trail shows who reset it and why (platform-admin actor: allowed cross-org).
        await this.audit.record(manager, { organisationId: targetOrg, userId: actorCtx.userId }, AuditAction.MFA_RESET_BY_ADMIN, { targetUserId, metadata: { revokedSessions, reason } });
        notice = await this.notices.enqueue(manager, targetOrg, targetUserId, 'reset_by_admin');
      } finally {
        await this.bind(manager, actorCtx);
      }
      await this.audit.record(manager, actorCtx, AuditAction.MFA_RESET_BY_ADMIN, { targetUserId, metadata: { revokedSessions, targetOrganisationId: targetOrg, reason } });
      return { kind: 'reset' as const, revokedSessions, notice };
    });

    switch (outcome.kind) {
      case 'not_found':
        throw new NotFoundException();
      case 'target_is_platform_admin':
        throw new ConflictException({
          code: 'MFA_RESET_REQUIRES_SECOND_ADMIN',
          message: 'Resetting another platform administrator’s two-factor authentication needs a second administrator’s approval, which isn’t available yet. Nothing was changed.',
        });
      case 'not_enabled':
        throw new ConflictException({ code: 'MFA_NOT_ENABLED', message: 'This account doesn’t have two-factor authentication turned on. Nothing was changed.' });
      case 'reset':
        this.notices.publish(outcome.notice);
        return { reset: true, revokedSessions: outcome.revokedSessions };
    }
  }

  // ------------------------------------------------------------------ internals

  private refuseInspection(ctx: AuthContext): void {
    if (ctx.inspectedBy) throw new ForbiddenException('This is not available while inspecting another account.');
  }

  private async isEnforced(ctx: AuthContext): Promise<boolean> {
    const roles = ctx.security?.roles ?? [];
    const isPlatformAdmin = ctx.security?.isPlatformAdmin ?? (await this.platformAdmin.isPlatformAdmin(ctx));
    return this.policy.isEnforced({ userId: ctx.userId, organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId, roles, isPlatformAdmin });
  }

  /** Ends every session of this account except the one making the request, and moves its security version. */
  private async endOtherSessions(manager: EntityManager, ctx: AuthContext, reason: string): Promise<void> {
    if (ctx.sessionId) await this.refreshTokens.revokeAllForUserExcept(manager, ctx.userId, ctx.sessionId, reason);
    else await this.refreshTokens.revokeAllForUser(manager, ctx.userId, reason);
    await this.securityVersion.bumpUser(manager, ctx.userId);
  }

  private async bind(manager: EntityManager, ctx: { organisationId: string | null; userId: string }): Promise<void> {
    await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [ctx.organisationId ?? '', ctx.userId]);
  }

  private async recordFailure(ctx: AuthContext, reason: string): Promise<void> {
    try {
      await this.tenantContext.runInTenantContext(ctx, (manager) => this.audit.record(manager, ctx, AuditAction.MFA_CHALLENGE_FAILED, { targetUserId: ctx.userId, metadata: { reason } }));
    } catch {
      // Observability must never turn a refusal into a 500.
    }
  }
}
