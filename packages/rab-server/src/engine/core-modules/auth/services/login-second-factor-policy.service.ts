import { Injectable } from '@nestjs/common';

export type SecondFactorRequirement = 'none' | 'verify' | 'enroll';

/**
 * The single place that decides whether a sign-in must pass a second factor BEFORE the session is issued (Twenty:
 * TWO_FACTOR_AUTHENTICATION_VERIFICATION_REQUIRED / _PROVISION_REQUIRED, evaluated before the login token is
 * consumed).
 *
 * Crewflow has no second factor yet: the `user.totp_*` and `user_session.mfa_verified_at` columns exist but nothing
 * enrols, verifies or enforces them, and there is no organisation/workspace "require 2FA" setting (owner decision
 * 2026-10-14: gate hook only, TOTP is a separate, fully tested increment). This therefore always answers `'none'` —
 * it does NOT pretend a factor was checked.
 *
 * Where it is consulted (wave 1 lane A, finding D-A3 — previously ONLY the OAuth handoff called it, so the old claim
 * that it covered every sign-in was false):
 *  - `AuthService.completeLogin`, the convergence point of password (web and mobile), Google and Microsoft sign-in,
 *    after every access gate and before any session exists. A non-'none' answer refuses the sign-in with 409
 *    SECOND_FACTOR_REQUIRED and issues nothing (fail closed: there is no verification step yet).
 *  - The OAuth handoff (`OAuthSignInFlowService.completeHandoff`) additionally consults it BEFORE consuming the handoff,
 *    so a future factor step can still use it.
 * A future TOTP increment (wave 4) only has to change this service and add the verification step; nothing can issue a
 * session around it.
 */
@Injectable()
export class LoginSecondFactorPolicyService {
  async requirementFor(_user: { userId: string; organisationId: string | null }): Promise<SecondFactorRequirement> {
    return 'none';
  }
}
