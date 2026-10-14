import { isCustomRoleKey } from '@rab/shared';
import { ForbiddenException } from '@nestjs/common';

export const APPLICATION_TARGETS = ['manager_web', 'venue_manager_app', 'staff_app'] as const;
export type ApplicationTarget = typeof APPLICATION_TARGETS[number];

export function applicationAllowed(roles: readonly string[], target: ApplicationTarget, platformAdmin = false): boolean {
  // Existing administrative identities retain their console entry on mobile.
  // The client keeps that presentation; this does not create a staff profile.
  if (platformAdmin) return true;
  if (roles.includes('venue_manager')) return target === 'venue_manager_app';
  // Internal Manager (and the admin-tier roles) get intentional, documented
  // multi-app access — see application-access.integration.spec.ts's
  // "complete application matrix" case and
  // test-identities.integration.spec.ts's "every application (intentional
  // multi-app access)" case, both pre-dating Phase 10. An earlier pass
  // through this file mistook this for an escalation gap and restricted
  // `manager` to `manager_web` only, which broke both of those tests — that
  // restriction has been reverted. Phase 10's per-application-target session
  // length policy is enforced independently, by role, in `session-policy.ts`
  // — it does NOT gate which targets a role may use, only how long the
  // resulting session lasts, so reverting this never re-opens AUTH-01/02.
  if (roles.some(role => ['ceo', 'org_admin', 'super_admin', 'admin', 'manager'].includes(role))) return true;
  if (roles.includes('staff')) return target === 'staff_app';
  // Custom workspace-member roles (owner decision 2026-10-14): the manager web console only. Recognised solely by
  // the `custom_` key prefix, which only RoleService.create can produce and the `role_member_key` CHECK reserves.
  // Never sufficient on its own — callers also refuse a member with no active workspace (`memberWithoutWorkspace`).
  if (roles.some(isCustomRoleKey)) return target === 'manager_web';
  return false;
}

/**
 * A workspace member's whole authority is their membership of ONE Manager-owned workspace. Without an active
 * membership (removed, suspended, workspace archived) they must not reach the console at all — fail closed rather
 * than serve an empty, context-less session. Holders of any system role are unaffected.
 */
export function memberWithoutWorkspace(roles: readonly string[], workspaceId: string | null | undefined, platformAdmin = false): boolean {
  if (platformAdmin || workspaceId) return false;
  return roles.some(isCustomRoleKey) && !roles.some((role) => !isCustomRoleKey(role));
}

export function applicationDenied(target: ApplicationTarget): ForbiddenException {
  const name = { manager_web: 'Manager system', venue_manager_app: 'Venue Manager app', staff_app: 'Staff app' }[target];
  return new ForbiddenException({ code: 'APPLICATION_ACCESS_DENIED', message: `This account does not have access to the ${name}.` });
}

export function defaultApplication(roles: readonly string[]): ApplicationTarget {
  if (roles.includes('venue_manager')) return 'venue_manager_app';
  if (roles.includes('manager') || roles.some(role => ['ceo', 'org_admin', 'super_admin', 'admin'].includes(role))) return 'manager_web';
  if (!roles.includes('staff') && roles.some(isCustomRoleKey)) return 'manager_web';
  return 'staff_app';
}
