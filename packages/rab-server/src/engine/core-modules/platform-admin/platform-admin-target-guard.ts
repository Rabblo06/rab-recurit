import { NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/**
 * Defence in depth for the platform administrator account (security review of #264, F2). A tenant-side actor must never be
 * able to act on an account that holds the platform-admin claim: re-point its pending email, resend or cancel its
 * invitation, or delete it. Re-pointing the email of a pending platform admin would hand the activation link — and with it
 * platform-wide authority — to an address the tenant chooses.
 *
 * Refused with 404 (CLAUDE.md: a 403 would confirm the account exists and is special) unless the ACTOR is itself an active
 * platform admin. Both answers come from the SECURITY DEFINER `core.is_active_platform_admin(uuid)` (platform_admin's own
 * RLS shows a caller only their own row). Same transaction as the caller's mutation; layer 2, in the service, so jobs and
 * other services that skip the route guard are covered too.
 */
export async function assertPlatformAdminTargetAllowed(
  manager: EntityManager,
  actorUserId: string | null | undefined,
  targetUserId: string,
  notFoundMessage: string,
): Promise<void> {
  const [row] = await manager.query<Array<{ target: boolean; actor: boolean }>>(
    `SELECT core.is_active_platform_admin($1::uuid) AS target,
            CASE WHEN $2::uuid IS NULL THEN false ELSE core.is_active_platform_admin($2::uuid) END AS actor`,
    [targetUserId, actorUserId ?? null],
  );
  // Fail closed: no answer is treated as "the target is protected and the actor is not an admin".
  if (!row || (row.target !== false && row.actor !== true)) throw new NotFoundException(notFoundMessage);
}
