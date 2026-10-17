import { SetMetadata } from '@nestjs/common';

import { ApplicationTarget } from '../application-access';

export const MOBILE_APPLICATION = 'mobileApplication';

export type MobileApplicationTarget = Exclude<ApplicationTarget, 'manager_web'>;

/**
 * CF-08 (owner decision 2026-10-15, option C): a credential issued to a MOBILE application target (`staff_app`,
 * `venue_manager_app`) is refused by JwtAuthGuard on every route that does not carry this decorator naming that target.
 * Mobile access is an explicit allow-list per route, never inherited from the user's other roles: a stolen phone token of a
 * manager-tier identity therefore cannot reach manager or admin APIs, whatever that identity may do on the web.
 *
 * Only add a target after confirming the mobile app genuinely calls the route; the route's own PermissionGuard, the
 * service-layer checks and RLS still apply on top. No arguments = both mobile apps.
 */
export const MobileApplication = (...targets: MobileApplicationTarget[]) =>
  SetMetadata(MOBILE_APPLICATION, targets.length ? targets : (['staff_app', 'venue_manager_app'] as MobileApplicationTarget[]));
