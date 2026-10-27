import { Injectable } from '@nestjs/common';

import { EnvironmentService } from '../../environment/environment.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { ApplicationTarget, mobileWorkforceOnly } from '../application-access';

export type SecondFactorRequirement = 'none' | 'verify' | 'enroll';

export interface SecondFactorSubject {
  userId: string;
  organisationId: string;
  workspaceId?: string | null;
  /** Server-resolved role keys (never from the client). */
  roles: readonly string[];
  isPlatformAdmin: boolean;
  /** The session's application target, as resolved by `completeLogin` (never a client header alone). */
  applicationTarget: ApplicationTarget;
}

/** Which enforcement class an identity falls into. Most-privileged class wins; a person can be in several. */
export type MfaEnforcementClass = 'platform_admin' | 'organisation_owner' | 'initial_manager' | 'other_web';

const MOBILE_TARGETS: ReadonlySet<ApplicationTarget> = new Set(['staff_app', 'venue_manager_app']);

/**
 * The single place that decides whether a sign-in must pass a second factor BEFORE the session is issued (Twenty:
 * TWO_FACTOR_AUTHENTICATION_VERIFICATION_REQUIRED / _PROVISION_REQUIRED).
 *
 * Wave 4 lane MFA — real policy (it answered a hard-coded 'none' until now):
 *  - `verify`: the account HAS a confirmed TOTP factor (`core.user.totp_enabled`). Always, on every web sign-in
 *    (password, Google, Microsoft) — no flag can downgrade an enrolled account to password-only on web.
 *  - `enroll`: the account has no factor yet but belongs to an enforced class (env flags, all default OFF):
 *    AUTH_MFA_ENFORCE_PLATFORM_ADMIN, _ORGANISATION_OWNER (role `ceo`), _INITIAL_MANAGER (current Initial Manager),
 *    _OTHER_WEB_USERS. The sign-in is NOT refused: the challenge lets the user enrol right there and finishes the
 *    sign-in (enrolment-required flow, never a lockout).
 *  - Step 1 (owner policy 2026-10-24, account security): enrolment is OPTIONAL for every role on every app, and once a
 *    factor is enrolled it is REQUIRED on every sign-in path — password, Google, Microsoft; manager_web, staff_app,
 *    venue_manager_app — for every role. The facts are therefore loaded FIRST and an enrolled account always answers
 *    `verify`: no flag, role, application target or client header can downgrade it to password-only.
 *  - AUTH_MFA_MOBILE_POLICY (re-documented, default `exempt`; the env file is unchanged): it now only decides whether
 *    the ENROLMENT flags (AUTH_MFA_ENFORCE_*) reach the mobile workforce. `exempt` = an identity whose server-resolved
 *    roles are exclusively staff / venue_manager and who is not a platform administrator (`mobileWorkforceOnly`) is
 *    never told to `enroll` on a mobile target; `require` = the flags apply to them too. It can suppress `enroll`
 *    only — never `verify`. With every AUTH_MFA_ENFORCE_* off (the default) it has no effect at all. Lane D's rule is
 *    kept: every higher tier (CEO, Initial Manager, other manager tiers, custom roles, platform admins) gets exactly the
 *    web requirement on mobile, so choosing a mobile target never lets them skip anything.
 *
 * Consulted at exactly one point: `AuthService.completeLogin`, after every access gate and before any session,
 * login_history success row, audit event or provider link exists. A non-'none' answer turns the sign-in into a
 * single-use challenge (`MfaChallengeService`) and issues nothing. A database error propagates (fail closed: no session) —
 * since step 1 that includes a staff / venue-manager mobile sign-in, which used to skip the lookup entirely.
 */
@Injectable()
export class LoginSecondFactorPolicyService {
  constructor(
    private readonly env: EnvironmentService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async requirementFor(subject: SecondFactorSubject): Promise<SecondFactorRequirement> {
    // Facts first (step 1): an enrolled account is challenged everywhere, before any exemption is even considered.
    const facts = await this.loadFacts(subject);
    if (facts.totpEnabled) return 'verify';
    // The mobile-workforce exemption can only suppress forced ENROLMENT, never verification of an enrolled factor.
    if (
      MOBILE_TARGETS.has(subject.applicationTarget) &&
      this.env.get('AUTH_MFA_MOBILE_POLICY') !== 'require' &&
      mobileWorkforceOnly(subject.roles, subject.isPlatformAdmin)
    ) {
      return 'none';
    }
    return this.enforcedClasses(subject, facts.isInitialManager).length > 0 ? 'enroll' : 'none';
  }

  /** The enforced classes an identity falls into right now (used for the requirement and for the settings page). */
  enforcedClasses(subject: Pick<SecondFactorSubject, 'roles' | 'isPlatformAdmin'>, isInitialManager: boolean): MfaEnforcementClass[] {
    const classes: MfaEnforcementClass[] = [];
    if (subject.isPlatformAdmin && this.env.get('AUTH_MFA_ENFORCE_PLATFORM_ADMIN') === true) classes.push('platform_admin');
    if (subject.roles.includes('ceo') && this.env.get('AUTH_MFA_ENFORCE_ORGANISATION_OWNER') === true) classes.push('organisation_owner');
    if (isInitialManager && this.env.get('AUTH_MFA_ENFORCE_INITIAL_MANAGER') === true) classes.push('initial_manager');
    const webUser = subject.isPlatformAdmin || subject.roles.some((role) => role !== 'staff' && role !== 'venue_manager');
    if (webUser && this.env.get('AUTH_MFA_ENFORCE_OTHER_WEB_USERS') === true) classes.push('other_web');
    return classes;
  }

  /** Whether enrolment is required for this identity (no factor needed to know that). */
  async isEnforced(subject: Omit<SecondFactorSubject, 'applicationTarget'>): Promise<boolean> {
    const facts = await this.loadFacts(subject);
    return this.enforcedClasses(subject, facts.isInitialManager).length > 0;
  }

  /**
   * `totp_enabled` is a column `crewflow_app` may read (only the secret itself is column-revoked); the Initial Manager
   * flag is the same query `PayrollCalendarService.isInitialManager` uses. Both run under the user's OWN tenant context.
   */
  private async loadFacts(subject: Pick<SecondFactorSubject, 'userId' | 'organisationId' | 'workspaceId'>): Promise<{ totpEnabled: boolean; isInitialManager: boolean }> {
    const ctx: AuthContext = { organisationId: subject.organisationId, workspaceId: subject.workspaceId ?? null, userId: subject.userId, role: '' };
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const [user] = await manager.query<Array<{ totp_enabled: boolean }>>('SELECT totp_enabled FROM core."user" WHERE id = $1', [subject.userId]);
      if (!user) throw new Error('second-factor policy: account not visible in its own tenant context');
      const initial = await manager.query<unknown[]>(
        `SELECT 1 FROM core.manager_profile WHERE user_id = $1 AND organisation_id = $2 AND type = 'internal' AND is_initial_manager AND superseded_at IS NULL`,
        [subject.userId, subject.organisationId],
      );
      return { totpEnabled: user.totp_enabled === true, isInitialManager: initial.length > 0 };
    });
  }
}
