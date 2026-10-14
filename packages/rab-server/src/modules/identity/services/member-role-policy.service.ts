import { isCustomRoleKey, MEMBER_ROLE_ALLOWED_PERMISSIONS, PermissionFlagType } from '@rab/shared';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { Permission, Role, RolePermission } from '../entities';

export interface AssignableMemberRole {
  id: string;
  key: string;
  name: string;
  permissionKeys: PermissionFlagType[];
}

const ALLOWED = new Set<string>(MEMBER_ROLE_ALLOWED_PERMISSIONS);

/**
 * The single place that decides whether a custom workspace-member role may be created, edited or ASSIGNED by an
 * actor — used by `RoleService` (create / edit) and `MemberInvitationService` (send, resend, and again at
 * acceptance with the inviter's authority). Every check runs inside the caller's own tenant-context transaction,
 * so `core.role`'s RLS already hides other workspaces' roles (→ 404, never 403).
 *
 * Rules (owner-approved 2026-10-14):
 *  1. A member role is never a system role, always belongs to the actor's CURRENT workspace and is keyed
 *     `custom_…` (also enforced by `role_member_key` / the composite invitation FK).
 *  2. Its permissions come only from `MEMBER_ROLE_ALLOWED_PERMISSIONS` (also enforced by the
 *     `role_permission_member_allowlist` trigger) — no leadership, role/user management or recruitment-Staff flags.
 *  3. No escalation: the actor must currently hold every permission the role grants (Twenty has no such check).
 */
@Injectable()
export class MemberRolePolicyService {
  constructor(private readonly permissions: PermissionsService) {}

  /** For create/edit: the requested permission set must be allowed for member roles AND held by the actor. */
  async assertGrantableTx(manager: EntityManager, ctx: AuthContext, permissionKeys: readonly PermissionFlagType[]): Promise<void> {
    const notAllowed = permissionKeys.filter((key) => !ALLOWED.has(key));
    if (notAllowed.length > 0) {
      throw new BadRequestException({
        code: 'PERMISSION_NOT_ALLOWED_FOR_MEMBER_ROLE',
        message: `These permissions cannot be given to a workspace-member role: ${notAllowed.join(', ')}.`,
      });
    }
    for (const key of permissionKeys) {
      if (!(await this.permissions.userHasPermissionTx(manager, ctx, key))) {
        throw new ForbiddenException({ code: 'ROLE_ESCALATION', message: 'You can only grant permissions that you hold yourself.' });
      }
    }
  }

  /**
   * For assignment: loads a role the actor may assign RIGHT NOW in `ctx.workspaceId`, or throws. A role that is
   * missing, belongs to another workspace, or is a system role (Manager, CEO, Staff, Venue Manager, …) is a 404 —
   * indistinguishable from a role that doesn't exist.
   */
  async loadAssignableTx(manager: EntityManager, ctx: AuthContext, roleId: string): Promise<AssignableMemberRole> {
    if (!ctx.workspaceId || !/^[0-9a-f-]{36}$/i.test(roleId)) throw new NotFoundException('Role not found.');
    const role = await manager.findOne(Role, { where: { id: roleId } });
    if (!role || role.isSystem || role.workspaceId !== ctx.workspaceId || !isCustomRoleKey(role.key)) {
      throw new NotFoundException('Role not found.');
    }
    const permissionKeys = await this.permissionKeysTx(manager, role.id);
    await this.assertGrantableTx(manager, ctx, permissionKeys);
    return { id: role.id, key: role.key, name: role.name, permissionKeys };
  }

  /** Assignable roles for the Invite selector: custom roles of the actor's workspace that pass every check. */
  async listAssignableTx(manager: EntityManager, ctx: AuthContext): Promise<AssignableMemberRole[]> {
    if (!ctx.workspaceId) return [];
    const roles = await manager.find(Role, { where: { workspaceId: ctx.workspaceId, isSystem: false }, order: { name: 'ASC' } });
    const result: AssignableMemberRole[] = [];
    for (const role of roles) {
      try {
        result.push(await this.loadAssignableTx(manager, ctx, role.id));
      } catch {
        // Not assignable by this actor (e.g. it grants a permission they no longer hold) — simply not offered.
      }
    }
    return result;
  }

  async permissionKeysTx(manager: EntityManager, roleId: string): Promise<PermissionFlagType[]> {
    const rows = await manager
      .createQueryBuilder(RolePermission, 'rp')
      .innerJoin(Permission, 'p', 'p.id = rp.permission_id')
      .where('rp.role_id = :roleId', { roleId })
      .select('p.key', 'key')
      .getRawMany<{ key: PermissionFlagType }>();
    return rows.map((r) => r.key);
  }
}
