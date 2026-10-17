import { EntityManager } from 'typeorm';

/**
 * CF-07 (October 15 audit): a promotion to platform admin must not turn the user's existing, long-lived, lower-privilege
 * sessions into platform-admin sessions. Session lifetimes are fixed at issue (`session-policy.ts`): a dormant 180-day
 * manager web session promoted in place would keep its 180-day absolute deadline, contradicting the 24 h / 30 min
 * platform-admin policy. So every grant path ends every session the target holds, in the grant's own transaction, and
 * bumps their security version; the next sign-in issues a session of the platform-admin class.
 *
 * Platform admin is platform-wide, so the target may belong to a different organisation than the actor. Identity rows
 * are organisation-scoped by RLS, so this binds the TARGET's organisation (resolved through the existing SECURITY DEFINER
 * `resolve_membership_for_user`) for the revocation, then restores the caller's binding. Same transaction throughout:
 * if any step fails, the grant itself rolls back (fail closed, never "granted but old sessions kept").
 *
 * Shared by PlatformAdminService.grant and both CLIs (grant-platform-admin, bootstrap-admin) so no grant path can skip it.
 */
export async function revokeSessionsForPrivilegedGrant(manager: EntityManager, targetUserId: string): Promise<{ revokedSessions: number }> {
  const [membership] = await manager.query<Array<{ organisation_id: string }>>(
    `SELECT organisation_id FROM core.resolve_membership_for_user($1)`,
    [targetUserId],
  );
  if (!membership) throw new Error('platform-admin grant target does not exist');
  const [{ previous }] = await manager.query<Array<{ previous: string | null }>>(`SELECT current_setting('rab.organisation_id', true) AS previous`);
  await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [membership.organisation_id]);
  try {
    await manager.query(`UPDATE core.refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [targetUserId]);
    const [, revokedSessions] = await manager.query<[unknown[], number]>(
      `UPDATE core.user_session
          SET revoked_at = now(), revoked_reason = 'platform_admin_granted', security_version = security_version + 1
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [targetUserId],
    );
    await manager.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [targetUserId]);
    return { revokedSessions: revokedSessions ?? 0 };
  } finally {
    await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [previous ?? '']);
  }
}
