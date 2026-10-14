import { isCustomRoleKey, PermissionFlag, UserStatus } from '@rab/shared';
import { ForbiddenException, Injectable } from '@nestjs/common';

import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';

export type MemberStatus = 'active' | 'pending_setup' | 'suspended' | 'inactive';

export interface MemberListItem {
  userId: string;
  /** Empty while the person has not completed their profile — the UI then shows the email. */
  firstName: string;
  lastName: string;
  email: string;
  roles: Array<{ id: string; name: string; isMemberRole: boolean }>;
  status: MemberStatus;
  isOwner: boolean;
  isSelf: boolean;
}

/**
 * Settings → Members → Team: the REAL members of the caller's workspace — `core.workspace_membership` rows of that
 * workspace (active or suspended) — not a merge of recruitment directories. Recruitment Staff and Venue Managers also
 * hold a workspace membership, but they are managed on the Users page and are excluded here, so Team shows the
 * workspace owner and the people invited with a custom workspace-member role.
 *
 * Only the workspace OWNER (holding ROLE_VIEW) may list it: `workspace_membership_owner_select` lets exactly them
 * read other members' rows, and this service re-checks both (CLAUDE.md layer 2). Search and pagination are
 * server-side.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
  ) {}

  async list(ctx: AuthContext, opts: { search?: string; page: number; limit: number }): Promise<{ data: MemberListItem[]; total: number; page: number; limit: number }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const denied = new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
      if (!ctx.workspaceId) throw denied;
      if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.ROLE_VIEW))) throw denied;
      const [workspace] = await manager.query<Array<{ owner_user_id: string }>>(
        `SELECT owner_user_id FROM core.manager_workspace WHERE id = $1 AND status = 'active'`,
        [ctx.workspaceId],
      );
      if (!workspace || workspace.owner_user_id !== ctx.userId) throw denied;

      const params: unknown[] = [ctx.workspaceId];
      let searchSql = 'true';
      const search = opts.search?.trim();
      if (search) {
        params.push(`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        const p = `$${params.length}`;
        searchSql = `(u.first_name ILIKE ${p} OR u.last_name ILIKE ${p} OR (u.first_name || ' ' || u.last_name) ILIKE ${p} OR u.email::text ILIKE ${p})`;
      }
      const from = `
          FROM core.workspace_membership m
          JOIN core."user" u ON u.id = m.user_id
         WHERE m.workspace_id = $1
           AND m.status IN ('active', 'suspended')
           AND u.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id
              WHERE ur.user_id = u.id AND r.is_system AND r.key IN ('staff', 'venue_manager'))
           AND ${searchSql}`;
      const [{ count }] = await manager.query<Array<{ count: string }>>(`SELECT count(*)::text AS count ${from}`, params);
      const offset = (opts.page - 1) * opts.limit;
      const rows = await manager.query<Array<{ user_id: string; first_name: string; last_name: string; email: string; user_status: string; membership_status: string; roles: Array<{ id: string; name: string; key: string }> | null }>>(
        `SELECT u.id AS user_id, u.first_name, u.last_name, u.email::text AS email, u.status AS user_status, m.status AS membership_status,
                (SELECT json_agg(json_build_object('id', r.id, 'name', r.name, 'key', r.key) ORDER BY r.is_system DESC, r.name)
                   FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles
           ${from}
          ORDER BY (u.id = $${params.length + 3}) DESC, lower(u.first_name), lower(u.last_name), u.id
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, opts.limit, offset, workspace.owner_user_id],
      );
      return {
        data: rows.map((r) => ({
          userId: r.user_id,
          firstName: r.first_name ?? '',
          lastName: r.last_name ?? '',
          email: r.email,
          roles: (r.roles ?? []).map((role) => ({ id: role.id, name: role.name, isMemberRole: isCustomRoleKey(role.key) })),
          status: this.status(r.membership_status, r.user_status),
          isOwner: r.user_id === workspace.owner_user_id,
          isSelf: r.user_id === ctx.userId,
        })),
        total: Number(count),
        page: opts.page,
        limit: opts.limit,
      };
    });
  }

  private status(membership: string, user: string): MemberStatus {
    if (membership === 'suspended' || user === UserStatus.SUSPENDED) return 'suspended';
    if (user === UserStatus.ACTIVE) return 'active';
    // Accepted the invitation (own name + password set) but has not signed in for the first time yet.
    if (user === UserStatus.INVITED) return 'pending_setup';
    return 'inactive';
  }
}
