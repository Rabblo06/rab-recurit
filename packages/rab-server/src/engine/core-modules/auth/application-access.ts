import { ForbiddenException } from '@nestjs/common';

export const APPLICATION_TARGETS = ['manager_web', 'venue_manager_app', 'staff_app'] as const;
export type ApplicationTarget = typeof APPLICATION_TARGETS[number];

export function applicationAllowed(roles: readonly string[], target: ApplicationTarget, platformAdmin = false): boolean {
  // Existing administrative identities retain their console entry on mobile.
  // The client keeps that presentation; this does not create a staff profile.
  if (platformAdmin) return true;
  // Match the existing restrictive mixed-role scope; a venue role is not
  // upgraded merely because another role was accidentally assigned too.
  if (roles.includes('venue_manager')) return target === 'venue_manager_app';
  if (roles.includes('manager')) return true;
  if (roles.some(role => ['ceo', 'org_admin', 'super_admin', 'admin'].includes(role))) return true;
  return roles.includes('staff') && target === 'staff_app';
}

export function applicationDenied(target: ApplicationTarget): ForbiddenException {
  const name = { manager_web: 'Manager system', venue_manager_app: 'Venue Manager app', staff_app: 'Staff app' }[target];
  return new ForbiddenException({ code: 'APPLICATION_ACCESS_DENIED', message: `This account does not have access to the ${name}.` });
}

export function defaultApplication(roles: readonly string[]): ApplicationTarget {
  if (roles.includes('venue_manager')) return 'venue_manager_app';
  if (roles.includes('manager') || roles.some(role => ['ceo', 'org_admin', 'super_admin', 'admin'].includes(role))) return 'manager_web';
  return 'staff_app';
}
