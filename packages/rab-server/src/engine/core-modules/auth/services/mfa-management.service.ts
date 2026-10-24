import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { mobileWorkforceOnly } from '../application-access';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { EnvironmentService } from '../../environment/environment.service';
import { PlatformAdminService } from '../../platform-admin/platform-admin.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { RefreshTokenService } from '../token/services/refresh-token.service';
import { LoginSecondFactorPolicyService } from './login-second-factor-policy.service';
import { MfaFactorService } from './mfa-factor.service';
import { EnrolmentMaterial, MfaLoginService } from './mfa-login.service';
import { SecurityVersionService } from './security-version.service';
import { StepUpProof, StepUpReauthService } from './step-up-reauth.service';

export interface MfaStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
  /** An enforcement flag applies to this account: it cannot switch MFA off, and must enrol at its next sign-in if it has none. */
  enforced: boolean;
  /** New enrolments are allowed by this deployment (AUTH_MFA_ENROLMENT_ENABLED). */
  enrolmentAvailable: boolean;
  /** Whether mobile-app sign-ins are challenged (AUTH_MFA_MOBILE_POLICY). Display only. */
  mobileChallenged: boolean;
}

/**
 * Wave 4 lane MFA — the signed-in user's own second factor (status, enrol, confirm, regenerate recovery codes, disable)
 * and the platform administrator's reset of ANOTHER user's factor. Business rules live here (CLAUDE.md layer 2), so the
 * controller is a transport adapter only and any future caller (CLI, job) gets the same checks.
 *
 * Rules:
 *  - Admin Inspect contexts are refused for every mutation (an inspecting admin never changes the target's factor).
 *  - Starting enrolment needs the current password: otherwise a stolen session could bind ITS authenticator to the
 *    victim's account and lock the owner out at the next sign-in.
 *  - Confirming needs a valid code for the staged secret; it enables MFA, records the confirming step (no replay), stores
 *    ten hashed recovery codes (returned once) and ends every OTHER session of the account (security version bumped).
 *  - Disable and recovery-code regeneration need password AND a current code (TOTP or a recovery code) in the same
 *    request: one compromised session can never silently remove or re-key the factor. Disable is refused while an
 *    enforcement flag applies. Disable ends every other session and bumps the security version.
 *  - Admin reset: platform admin only (guard + this service), the admin must have MFA themselves and re-prove password +
 *    their own current code, never on themselves; it clears the target's factor and recovery codes, ends ALL the
 *    target's sessions, bumps their security version and is audited in both organisations.
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
  ) {}

  async status(ctx: AuthContext): Promise<MfaStatus> {
    const state = await this.tenantContext.runInTenantContext(ctx, (manager) => this.factors.state(manager, ctx.userId));
    if (!state) throw new NotFoundException();
    return {
      enabled: state.totpEnabled,
      enabledAt: state.totpEnabled && state.enabledAt ? state.enabledAt.toISOString() : null,
      recoveryCodesRemaining: state.totpEnabled ? state.recoveryCodesRemaining : 0,
      enforced: await this.isEnforced(ctx),
      enrolmentAvailable: this.env.get('AUTH_MFA_ENROLMENT_ENABLED') === true,
      // Lane D (M10-1): only the staff / venue-manager workforce is exempt on mobile; everyone who can reach this
      // (manager web) settings page is a higher tier and is challenged on mobile too — unless they are workforce-only.
      mobileChallenged: this.env.get('AUTH_MFA_MOBILE_POLICY') === 'require' || !mobileWorkforceOnly(ctx.security?.roles ?? [], ctx.security?.isPlatformAdmin ?? false),
    };
  }

  async startEnrolment(ctx: AuthContext, currentPassword: string): Promise<EnrolmentMaterial> {
    this.refuseInspection(ctx);
    if (this.env.get('AUTH_MFA_ENROLMENT_ENABLED') !== true) throw new ForbiddenException({ code: 'MFA_ENROLMENT_DISABLED', message: 'Two-factor setup is not available right now.' });
    await this.stepUp.assertCurrentPassword(ctx, currentPassword);
    const { secret, email } = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const staged = await this.factors.stageNewSecret(manager, ctx.userId);
      if (!staged) return { secret: null, email: '' };
      await this.audit.record(manager, ctx, AuditAction.MFA_ENROLMENT_STARTED, { targetUserId: ctx.userId, metadata: { during: 'settings' } });
      const [row] = await manager.query<Array<{ email: string }>>('SELECT email FROM core."user" WHERE id = $1', [ctx.userId]);
      return { secret: staged, email: row?.email ?? '' };
    });
    if (!secret) throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'Two-factor authentication is already on.' });
    return this.mfaLogin.material(email, secret);
  }

  async confirmEnrolment(ctx: AuthContext, code: string): Promise<{ recoveryCodes: string[] }> {
    this.refuseInspection(ctx);
    await this.factors.admitAttempt(ctx.userId);
    const codes = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const enrolled = await this.factors.confirmEnrolment(manager, ctx.userId, code);
      if (!enrolled) return null;
      await this.audit.record(manager, ctx, AuditAction.MFA_ENABLED, { targetUserId: ctx.userId, metadata: { during: 'settings', recoveryCodes: enrolled.length } });
      await this.endOtherSessions(manager, ctx, 'mfa_enabled');
      return enrolled;
    });
    if (!codes) {
      await this.recordFailure(ctx, 'enrolment_code');
      throw new UnauthorizedException({ code: 'MFA_CODE_INVALID', message: 'That code didn’t work. Check your authenticator app and try again.' });
    }
    return { recoveryCodes: codes };
  }

  async regenerateRecoveryCodes(ctx: AuthContext, proof: StepUpProof): Promise<{ recoveryCodes: string[] }> {
    this.refuseInspection(ctx);
    const { method } = await this.stepUp.assertPasswordAndSecondFactor(ctx, proof, { allowRecoveryCode: true });
    if (method === null) throw new ConflictException({ code: 'MFA_NOT_ENABLED', message: 'Two-factor authentication is off.' });
    const codes = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const fresh = await this.factors.regenerateRecoveryCodes(manager, ctx.userId);
      await this.audit.record(manager, ctx, AuditAction.MFA_RECOVERY_CODES_REGENERATED, { targetUserId: ctx.userId, metadata: { count: fresh.length, provedWith: method } });
      return fresh;
    });
    return { recoveryCodes: codes };
  }

  async disable(ctx: AuthContext, proof: StepUpProof): Promise<void> {
    this.refuseInspection(ctx);
    // Policy first (no code is burned for a request that can never succeed).
    if (await this.isEnforced(ctx)) throw new ForbiddenException({ code: 'MFA_REQUIRED_BY_POLICY', message: 'Two-factor authentication is required for your account and can’t be turned off.' });
    const { method } = await this.stepUp.assertPasswordAndSecondFactor(ctx, proof, { allowRecoveryCode: true });
    if (method === null) throw new ConflictException({ code: 'MFA_NOT_ENABLED', message: 'Two-factor authentication is already off.' });
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      if (!(await this.factors.disable(manager, ctx.userId))) throw new ConflictException({ code: 'MFA_NOT_ENABLED', message: 'Two-factor authentication is already off.' });
      await this.audit.record(manager, ctx, AuditAction.MFA_DISABLED, { targetUserId: ctx.userId, metadata: { provedWith: method } });
      await this.endOtherSessions(manager, ctx, 'mfa_disabled');
    });
    await this.stepUp.clearGrant(ctx.sessionId);
  }

  async adminReset(actorCtx: AuthContext, targetUserId: string, proof: StepUpProof): Promise<{ reset: boolean }> {
    this.refuseInspection(actorCtx);
    // Layer 2: never rely on the route guard alone.
    if (!(await this.platformAdmin.isPlatformAdmin(actorCtx))) throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
    if (targetUserId === actorCtx.userId) throw new BadRequestException({ code: 'MFA_RESET_SELF', message: 'Use your own security settings to change your two-factor authentication.' });
    // The resetting admin must hold (and now re-prove) a second factor of their own.
    const { method } = await this.stepUp.assertPasswordAndSecondFactor(actorCtx, proof, { allowRecoveryCode: false });
    if (method === null) {
      throw new ForbiddenException({ code: 'MFA_ENROLMENT_REQUIRED', message: 'Set up two-factor authentication on your own account before resetting someone else’s.' });
    }
    return this.tenantContext.runInTenantContext(actorCtx, async (manager) => {
      const [membership] = await manager.query<Array<{ organisation_id: string }>>('SELECT organisation_id FROM core.resolve_membership_for_user($1)', [targetUserId]);
      if (!membership) throw new NotFoundException();
      const targetOrg = membership.organisation_id;
      // resolve_membership_for_user rebinds the GUCs itself; restore the actor's binding before the next step either way.
      await this.bind(manager, actorCtx);
      let reset = false;
      let revokedSessions = 0;
      await this.bind(manager, { organisationId: targetOrg, userId: actorCtx.userId });
      try {
        reset = await this.factors.disable(manager, targetUserId);
        if (reset) {
          const [, count] = await manager.query<[unknown[], number]>(
            `UPDATE core.user_session SET revoked_at = now(), revoked_reason = 'mfa_reset_by_admin', security_version = security_version + 1 WHERE user_id = $1 AND revoked_at IS NULL`,
            [targetUserId],
          );
          revokedSessions = count ?? 0;
          await manager.query('UPDATE core.refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [targetUserId]);
          await this.securityVersion.bumpUser(manager, targetUserId);
          // The target organisation's own audit trail shows who reset it (platform-admin actor: allowed cross-org).
          await this.audit.record(manager, { organisationId: targetOrg, userId: actorCtx.userId }, AuditAction.MFA_RESET_BY_ADMIN, { targetUserId, metadata: { revokedSessions } });
        }
      } finally {
        await this.bind(manager, actorCtx);
      }
      if (reset) await this.audit.record(manager, actorCtx, AuditAction.MFA_RESET_BY_ADMIN, { targetUserId, metadata: { revokedSessions, targetOrganisationId: targetOrg } });
      return { reset };
    });
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
