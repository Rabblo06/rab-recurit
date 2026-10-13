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
 *
 * P0.3 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.2): `isPlatformAdmin` is an
 * INDEPENDENT security-class input, not derived from `roles`. `core.platform_admin`
 * is keyed by user id, not by role membership (`PlatformAdminService.isPlatformAdmin`),
 * so a platform admin with no manager-tier role previously fell through to
 * whichever target's own (possibly 90-day) policy applied. A platform admin's
 * session is always the 24h "web" policy, regardless of target or role, for the
 * same reason a manager-tier role is: selecting a mobile target must never be a
 * way to trade up to a longer session.
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

export function absoluteSessionTtlMsFor(
  roles: readonly string[],
  applicationTarget: ApplicationTarget,
  isPlatformAdmin = false,
): number {
  if (!APPLICATION_TARGETS.includes(applicationTarget)) {
    // Fail closed — an unrecognised target must never fall through to a
    // default duration (which could accidentally be the most permissive one).
    throw new Error(`No session policy defined for application target "${applicationTarget}".`);
  }
  if (isPlatformAdmin || roles.some((role) => MANAGER_TIER_ROLES.includes(role))) {
    return ABSOLUTE_SESSION_TTL_MS.manager_web;
  }
  return ABSOLUTE_SESSION_TTL_MS[applicationTarget];
}

/** The access JWT's own short TTL — independent of the session's absolute ceiling above, but always clamped to not outlive it (see AccessTokenService.sign). */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * P0 finalization (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.3): the longest absolute session
 * lifetime this codebase currently defines, across every application target and the
 * platform-admin cap — i.e. the true upper bound any live `refresh_token` family can reach.
 * `token/retention-policy.ts` asserts the auth-token cleanup retention window (a separate value,
 * living inside a Postgres function body, not here) always exceeds this — so if this file's own
 * policy is ever changed to allow a longer session, that assertion fails loudly in CI instead of
 * silently letting cleanup delete reuse-detection evidence for a still-live family again.
 */
export function maxAbsoluteSessionTtlMsAcrossAllTargets(): number {
  return Math.max(...Object.values(ABSOLUTE_SESSION_TTL_MS));
}

/**
 * P2.2 — idle-session timeout (`core.user_session.idle_expires_at`, present since P1B's
 * `UserSessionColumnPrivilegeTightening` migration but explicitly "not enforced... reserved for
 * P2" until now). A session with no activity for this long is denied even though its absolute
 * deadline and refresh-token family are both still otherwise live — the gap `manager_web`'s own
 * 24h absolute policy above says it closes ("a shared/borrowed office machine should not stay
 * signed in indefinitely") but doesn't, by itself, actually close.
 *
 * ASSUMPTION FLAGGED (CLAUDE.md §"Never invent a business rule silently" — no idle-duration value
 * was specified anywhere in the architecture docs; `idle_expires_at` existed as a column with no
 * policy attached). Chosen values, pending explicit owner sign-off:
 *   - `manager_web`: 30 minutes — short enough to matter for the shared-office-machine risk this
 *     target's absolute policy already names as its own rationale.
 *   - `staff_app` / `venue_manager_app`: 7 days — long enough that a mobile worker who doesn't open
 *     the app daily isn't forced to re-authenticate, short enough to still be a real boundary
 *     inside the existing 90-day absolute ceiling (not "idle timeout in name only").
 * OWNER CORRECTION (overnight P2/P3 mandate, supersedes the originally-flagged gap below): "A
 * platform administrator must receive the stricter 30-minute inactivity policy regardless of
 * whether authentication originated through a web or mobile application target. Do not allow
 * mobile application-target metadata to override verified privileged-role policy." Unlike the
 * absolute TTL (computed ONCE at creation and frozen forever — see `absoluteSessionTtlMsFor`
 * above), idle timeout SLIDES forward on every bump, and `core.user_session` has nowhere to
 * persist "which policy class was this session created under," only `application_target` — so
 * honouring this correctly means re-evaluating the privileged override from CURRENT role data on
 * every bump, never a value frozen at login. `isPrivilegedIdleClass()` below is that check;
 * `SessionValidityService`'s caller (`AuthSecuritySnapshotService.build()`) supplies it computed
 * from THIS request's own freshly-resolved `roles`/`isPlatformAdmin` — the same per-request
 * resolution every other authorization decision in this codebase already uses, never cached
 * session-start state — which is exactly what makes this handle a live role change correctly: a
 * promotion to platform-admin (or a grant of a manager-tier role) tightens the idle policy on the
 * very next request after the grant takes effect; a demotion loosens it the same way. Neither
 * direction can "retain a longer idle window than the new role permits," because nothing is ever
 * retained — it is recomputed every time.
 */
const IDLE_SESSION_TIMEOUT_MS: Record<ApplicationTarget, number> = {
  manager_web: 30 * 60 * 1000,
  staff_app: 7 * ONE_DAY_MS,
  venue_manager_app: 7 * ONE_DAY_MS,
};

/** Manager-tier roles get the strict `manager_web` idle policy regardless of target — the identical rule, and the identical role list, `absoluteSessionTtlMsFor` already applies to the absolute deadline. */
export function isPrivilegedIdleClass(roles: readonly string[], isPlatformAdmin = false): boolean {
  return isPlatformAdmin || roles.some((role) => MANAGER_TIER_ROLES.includes(role));
}

export function idleSessionTimeoutMsFor(applicationTarget: ApplicationTarget, privileged = false): number {
  if (!APPLICATION_TARGETS.includes(applicationTarget)) {
    throw new Error(`No idle-session policy defined for application target "${applicationTarget}".`);
  }
  return privileged ? IDLE_SESSION_TIMEOUT_MS.manager_web : IDLE_SESSION_TIMEOUT_MS[applicationTarget];
}

/** Raw per-target idle durations, in milliseconds — for the SQL `CASE` in `SessionValidityService`'s bump, which keys off the row's own stored `application_target` UNLESS the caller's current role resolves `isPrivilegedIdleClass() === true`, in which case the `manager_web` value applies regardless. */
export function idleSessionTimeoutMsByTarget(): Record<ApplicationTarget, number> {
  return { ...IDLE_SESSION_TIMEOUT_MS };
}
