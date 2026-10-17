import { isCustomRoleKey, PermissionFlag, UserStatus } from '@rab/shared';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { SecurityVersionService } from '../../../engine/core-modules/auth/services/security-version.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceMembershipService } from '../../../engine/core-modules/tenant/workspace-membership.service';
import { UserRole } from '../../identity/entities';
import { MemberRolePolicyService } from '../../identity/services/member-role-policy.service';

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
    private readonly memberRolePolicy: MemberRolePolicyService,
    private readonly securityVersion: SecurityVersionService,
    private readonly workspaceMembership: WorkspaceMembershipService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Change a member's custom role (custom → custom only). Owner-only (ROLE_MANAGE, re-checked here); the new role
   * must be assignable by the owner right now (this workspace, "Assignable to Workspace Members", no escalation —
   * MemberRolePolicyService). Bumps the member's security version in the same transaction, so cached permissions
   * are dropped before the next request.
   */
  async changeRole(ctx: AuthContext, userId: string, roleId: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertOwnerTx(manager, ctx, PermissionFlag.ROLE_MANAGE);
      const target = await this.loadManagedMemberTx(manager, ctx, userId);
      const role = await this.memberRolePolicy.loadAssignableTx(manager, ctx, roleId);
      const previous = target.customRoleIds;
      if (previous.length === 1 && previous[0] === role.id) return;
      await manager.query(
        `DELETE FROM core.user_role ur USING core.role r
          WHERE ur.role_id = r.id AND ur.user_id = $1 AND r.workspace_id = $2 AND r.is_system = false`,
        [userId, ctx.workspaceId],
      );
      await manager.insert(UserRole, { userId, roleId: role.id, organisationId: ctx.organisationId! });
      await this.securityVersion.bumpUser(manager, userId);
      await this.audit.record(manager, ctx, AuditAction.MEMBER_ROLE_CHANGED, {
        entityType: 'user',
        entityId: userId,
        metadata: { fromRoleIds: previous, toRoleId: role.id, workspaceId: ctx.workspaceId },
      });
    });
  }

  /** Suspend a member's access to this workspace (reversible). Owner-only; never the owner themselves. */
  async suspend(ctx: AuthContext, userId: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertOwnerTx(manager, ctx, PermissionFlag.ROLE_MANAGE);
      const target = await this.loadManagedMemberTx(manager, ctx, userId);
      if (target.membershipStatus === 'suspended') return;
      // The SECURITY DEFINER function checks only the organisation; the workspace/owner/member checks above are the
      // authority for "may THIS caller suspend THIS person". It also bumps the membership security version.
      await this.workspaceMembership.suspendForUser(manager, userId);
      await this.securityVersion.bumpUser(manager, userId);
      await this.audit.record(manager, ctx, AuditAction.MEMBER_SUSPENDED, { entityType: 'user', entityId: userId, metadata: { workspaceId: ctx.workspaceId } });
    });
  }

  async reinstate(ctx: AuthContext, userId: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertOwnerTx(manager, ctx, PermissionFlag.ROLE_MANAGE);
      const target = await this.loadManagedMemberTx(manager, ctx, userId);
      if (target.membershipStatus === 'active') return;
      await this.workspaceMembership.reinstateForUser(manager, userId);
      await this.securityVersion.bumpUser(manager, userId);
      await this.audit.record(manager, ctx, AuditAction.MEMBER_REINSTATED, { entityType: 'user', entityId: userId, metadata: { workspaceId: ctx.workspaceId } });
    });
  }

  private async assertOwnerTx(manager: EntityManager, ctx: AuthContext, flag: typeof PermissionFlag.ROLE_VIEW | typeof PermissionFlag.ROLE_MANAGE): Promise<{ ownerUserId: string }> {
    const denied = new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
    if (!ctx.workspaceId) throw denied;
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, flag))) throw denied;
    const [workspace] = await manager.query<Array<{ owner_user_id: string }>>(
      `SELECT owner_user_id FROM core.manager_workspace WHERE id = $1 AND status = 'active'`,
      [ctx.workspaceId],
    );
    if (!workspace || workspace.owner_user_id !== ctx.userId) throw denied;
    return { ownerUserId: workspace.owner_user_id };
  }

  /**
   * A person the owner may manage from Team: a member of THIS workspace (active or suspended) who holds only custom
   * workspace-member roles. The owner themselves, recruitment Staff, Venue Managers, and anyone outside the workspace
   * are all a 404 — indistinguishable from a user that doesn't exist.
   */
  private async loadManagedMemberTx(manager: EntityManager, ctx: AuthContext, userId: string): Promise<{ membershipStatus: string; customRoleIds: string[] }> {
    const notFound = new NotFoundException('Member not found.');
    if (!/^[0-9a-f-]{36}$/i.test(userId) || userId === ctx.userId) throw notFound;
    const [row] = await manager.query<Array<{ status: string; role_keys: string[] | null; custom_role_ids: string[] | null }>>(
      `SELECT m.status,
              (SELECT array_agg(r.key) FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = m.user_id) AS role_keys,
              (SELECT array_agg(r.id) FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id
                WHERE ur.user_id = m.user_id AND r.workspace_id = $2 AND r.is_system = false) AS custom_role_ids
         FROM core.workspace_membership m
         JOIN core."user" u ON u.id = m.user_id AND u.deleted_at IS NULL
        WHERE m.user_id = $1 AND m.workspace_id = $2 AND m.status IN ('active', 'suspended')
        LIMIT 1`,
      [userId, ctx.workspaceId],
    );
    if (!row) throw notFound;
    const keys = row.role_keys ?? [];
    if (keys.length === 0 || !keys.every((key) => isCustomRoleKey(key))) {
      // Leadership, Staff and Venue Managers are managed elsewhere (Users page / organisation settings).
      throw new ConflictException('This person is not a workspace member with a custom role and cannot be changed here.');
    }
    return { membershipStatus: row.status, customRoleIds: row.custom_role_ids ?? [] };
  }

  async list(ctx: AuthContext, opts: { search?: string; page: number; limit: number }): Promise<{ data: MemberListItem[]; total: number; page: number; limit: number }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const workspace = { owner_user_id: (await this.assertOwnerTx(manager, ctx, PermissionFlag.ROLE_VIEW)).ownerUserId };

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
