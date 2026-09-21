import { NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';

/** Enforce team selection for Venue Managers, including direct API requests. */
export async function assertVenueTeamSelection(manager: EntityManager, ctx: AuthContext, ids: string[], workspaceId?: string): Promise<void> {
  const roles = await manager.query(`SELECT 1 FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id
    WHERE ur.user_id = $1 AND r.key = 'venue_manager'`, [ctx.userId]);
  if (!roles.length) return;
  const rows = await manager.query(`SELECT t.staff_profile_id AS id FROM core.venue_manager_staff t
    JOIN core.manager_profile mp ON mp.id = t.manager_profile_id
    JOIN core.staff_profile sp ON sp.id = t.staff_profile_id
    JOIN core."user" u ON u.id = sp.user_id
    WHERE t.organisation_id = $1 AND mp.user_id = $2 AND t.staff_profile_id = ANY($3::uuid[])
      AND t.workspace_id = $4 AND sp.workspace_id = t.workspace_id AND u.status = 'active'`,
    [ctx.organisationId, ctx.userId, ids, workspaceId ?? null]);
  const found = new Set(rows.map((r: { id: string }) => r.id));
  if (ids.some((id) => !found.has(id))) throw new NotFoundException('Selected staff member not found in your team.');
}
