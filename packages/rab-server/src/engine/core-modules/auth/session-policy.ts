import { APPLICATION_TARGETS, ApplicationTarget } from './application-access';

/**
 * ONE canonical resolver for "how long may an authenticated session live,
 * absolutely, regardless of how often it's refreshed" — Phase 10 replaces
 * the single flat 24h constant every application target previously shared
 * with a per-target policy, because the mobile product requirement (staff
 * and venue managers should not need to re-type a password every 24h once
 * biometric login is configured) genuinely differs from the web console's
 * requirement (a shared/borrowed office machine should not stay signed in
 * indefinitely).
 *
 * This is the ONLY place these durations are defined — `RefreshTokenService`
 * calls this at first-issue time (never at rotation, which always inherits
 * the family's already-fixed `familyExpiresAt` unchanged) and nothing else
 * should hardcode `24 * 60 * 60 * 1000` or `90 * 24 * 60 * 60 * 1000` again.
 *
 * APPLICATION ACCESS and SESSION SECURITY CLASS are separate axes, not one.
 * `applicationAllowed()` in `application-access.ts` decides WHICH targets a
 * role may use at all — an Internal Manager (and the admin-tier roles) has
 * long-documented, intentional multi-app access, including the mobile
 * staff/venue-manager apps (see `application-access.integration.spec.ts`'s
 * "complete application matrix" case and `test-identities.integration.spec.ts`'s
 * "every application (intentional multi-app access)" case — both pre-date
 * Phase 10). This function decides how long a session lasts once a target
 * is already allowed, and a manager-tier identity gets the 24h policy
 * EVERY time, regardless of which allowed target they actually used —
 * selecting a mobile target must never be a way to trade up from a 24h
 * session to a 90-day one. Only a genuine mobile-worker role (staff,
 * venue_manager) gets the 90-day policy, and only because that's the one
 * target their role is scoped to in the first place.
 *
 * Fails closed: an unrecognised application target gets no policy at all
 * (throws) rather than silently defaulting to the most permissive duration.
 */
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

const ABSOLUTE_SESSION_TTL_MS: Record<ApplicationTarget, number> = {
  manager_web: 24 * ONE_HOUR_MS,
  staff_app: 90 * ONE_DAY_MS,
  venue_manager_app: 90 * ONE_DAY_MS,
};

/** Roles whose SESSION SECURITY CLASS is always the 24h "web" policy — see this file's doc comment. */
const MANAGER_TIER_ROLES = ['manager', 'ceo', 'org_admin', 'super_admin', 'admin'];

export function absoluteSessionTtlMsFor(roles: readonly string[], applicationTarget: ApplicationTarget): number {
  if (!APPLICATION_TARGETS.includes(applicationTarget)) {
    // Fail closed — an unrecognised target must never fall through to a
    // default duration (which could accidentally be the most permissive one).
    throw new Error(`No session policy defined for application target "${applicationTarget}".`);
  }
  if (roles.some((role) => MANAGER_TIER_ROLES.includes(role))) {
    return ABSOLUTE_SESSION_TTL_MS.manager_web;
  }
  return ABSOLUTE_SESSION_TTL_MS[applicationTarget];
}

/** The access JWT's own short TTL — independent of the session's absolute ceiling above, but always clamped to not outlive it (see AccessTokenService.sign). */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
