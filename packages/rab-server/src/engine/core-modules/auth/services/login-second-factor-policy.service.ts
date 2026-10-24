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
 *  - Mobile targets (staff_app / venue_manager_app) answer 'none' while AUTH_MFA_MOBILE_POLICY=exempt (default) ONLY
 *    for the mobile workforce — identities whose server-resolved roles are exclusively staff / venue_manager and who
 *    are not platform administrators (`mobileWorkforceOnly`). Lane D (owner decision M10-1): every higher tier (CEO,
 *    Initial Manager, other manager tiers, custom roles, platform admins) gets the SAME requirement on mobile as on
 *    web; the Flutter app finishes a `verify` challenge with its code screen and fails closed on `enroll`.
 *
 * Consulted at exactly one point: `AuthService.completeLogin`, after every access gate and before any session,
 * login_history success row, audit event or provider link exists. A non-'none' answer turns the sign-in into a
 * single-use challenge (`MfaChallengeService`) and issues nothing. A database error propagates (fail closed: no session).
 */
@Injectable()
export class LoginSecondFactorPolicyService {
  constructor(
    private readonly env: EnvironmentService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async requirementFor(subject: SecondFactorSubject): Promise<SecondFactorRequirement> {
    if (
      MOBILE_TARGETS.has(subject.applicationTarget) &&
      this.env.get('AUTH_MFA_MOBILE_POLICY') !== 'require' &&
      mobileWorkforceOnly(subject.roles, subject.isPlatformAdmin)
    ) {
      return 'none';
    }
    const facts = await this.loadFacts(subject);
    if (facts.totpEnabled) return 'verify';
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
