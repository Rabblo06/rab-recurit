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
 * is already allowed, and a manager-tier identity gets the `manager_web`
 * policy (180 days absolute / 30 days idle since 2026-10-14; 24h when this
 * was written) EVERY time, regardless of which allowed target they actually
 * used — selecting a mobile target must never be a way to change session
 * class. Only a genuine mobile-worker role (staff, venue_manager) gets the
 * 90-day mobile policy, and only because that's the one target their role
 * is scoped to in the first place.
 *
 * Fails closed: an unrecognised application target gets no policy at all
 * (throws) rather than silently defaulting to the most permissive duration.
 *
 * P0.3 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.2): `isPlatformAdmin` is an
 * INDEPENDENT security-class input, not derived from `roles`. `core.platform_admin`
 * is keyed by user id, not by role membership (`PlatformAdminService.isPlatformAdmin`),
 * so a platform admin with no manager-tier role previously fell through to
 * whichever target's own (possibly 90-day) policy applied. A platform admin's
 * session is always the strict 24h absolute / 30-minute idle policy, regardless of target or role, for the
 * same reason a manager-tier role is: selecting a mobile target must never be a
 * way to trade up to a longer session.
 */
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/**
 * OWNER DECISION 2026-10-14 (Twenty parity — TWENTY_GOOGLE_AUTH_GAP_ANALYSIS.md): web sessions for Managers, CEOs and
 * workspace members persist like Twenty's (`SESSION_ABSOLUTE_LIFETIME` 180d / `SESSION_IDLE_TIMEOUT` 30d), replacing the
 * earlier 24h / 30 min web policy. Platform administrators keep the strict 24h / 30 min policy on every target, and
 * sensitive actions keep password step-up. Mobile worker targets are unchanged. Higher session-theft exposure is
 * recorded in THREAT-MODEL.md.
 */
const ABSOLUTE_SESSION_TTL_MS: Record<ApplicationTarget, number> = {
  manager_web: 180 * ONE_DAY_MS,
  staff_app: 90 * ONE_DAY_MS,
  venue_manager_app: 90 * ONE_DAY_MS,
};

/** Platform administrators: always 24h absolute / 30 min idle, regardless of target or role. */
const PLATFORM_ADMIN_ABSOLUTE_TTL_MS = 24 * ONE_HOUR_MS;
const PLATFORM_ADMIN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Roles whose SESSION SECURITY CLASS is always the `manager_web` policy, whichever allowed target they used — see this file's doc comment. */
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
  if (isPlatformAdmin) return PLATFORM_ADMIN_ABSOLUTE_TTL_MS;
  if (roles.some((role) => MANAGER_TIER_ROLES.includes(role))) {
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
  return Math.max(...Object.values(ABSOLUTE_SESSION_TTL_MS), PLATFORM_ADMIN_ABSOLUTE_TTL_MS);
}

/**
 * P2.2 — idle-session timeout (`core.user_session.idle_expires_at`, present since P1B's
 * `UserSessionColumnPrivilegeTightening` migration but explicitly "not enforced... reserved for
 * P2" until now). A session with no activity for this long is denied even though its absolute
 * deadline and refresh-token family are both still otherwise live — the gap the original
 * `manager_web` 24h absolute policy (now platform administrators only) said it closes ("a shared/borrowed office machine should not stay
 * signed in indefinitely") but doesn't, by itself, actually close.
 *
 * HISTORY (P2.2): the values first chosen here were `manager_web` 30 minutes and mobile 7 days,
 * flagged as an assumption pending owner sign-off. CURRENT values (the table below is the only
 * source of truth): `manager_web` 30 DAYS idle / 180 days absolute since the owner decision of
 * 2026-10-14 (Twenty parity, see the comment above `ABSOLUTE_SESSION_TTL_MS`); `staff_app` /
 * `venue_manager_app` 7 days idle / 90 days absolute; platform administrators 30 minutes idle /
 * 24 hours absolute on every target. The "shared office machine" rationale below described the
 * original 24h/30-minute web policy, which now applies to platform administrators only.
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
  manager_web: 30 * ONE_DAY_MS,
  staff_app: 7 * ONE_DAY_MS,
  venue_manager_app: 7 * ONE_DAY_MS,
};

/**
 * The idle timeout that overrides the session row's own `application_target`, from CURRENT role data: platform
 * administrators always get the strict 30 minutes; manager-tier roles get the `manager_web` value whichever target
 * they used (the same role list `absoluteSessionTtlMsFor` uses); everyone else (mobile workers) gets `null` — the
 * row's own per-target value applies.
 */
export function idleOverrideMsFor(roles: readonly string[], isPlatformAdmin = false): number | null {
  if (isPlatformAdmin) return PLATFORM_ADMIN_IDLE_TIMEOUT_MS;
  if (roles.some((role) => MANAGER_TIER_ROLES.includes(role))) return IDLE_SESSION_TIMEOUT_MS.manager_web;
  return null;
}

/** Whether this caller's session class is the strict platform-administrator class (24h / 30 min). */
export function isPrivilegedIdleClass(roles: readonly string[], isPlatformAdmin = false): boolean {
  void roles;
  return isPlatformAdmin;
}

export function idleSessionTimeoutMsFor(applicationTarget: ApplicationTarget, overrideMs: number | null = null): number {
  if (!APPLICATION_TARGETS.includes(applicationTarget)) {
    throw new Error(`No idle-session policy defined for application target "${applicationTarget}".`);
  }
  return overrideMs ?? IDLE_SESSION_TIMEOUT_MS[applicationTarget];
}

/** Raw per-target idle durations, in milliseconds — for the SQL `CASE` in `SessionValidityService`'s bump, which keys off the row's own stored `application_target` UNLESS the caller's current role resolves `isPrivilegedIdleClass() === true`, in which case the `manager_web` value applies regardless. */
export function idleSessionTimeoutMsByTarget(): Record<ApplicationTarget, number> {
  return { ...IDLE_SESSION_TIMEOUT_MS };
}
