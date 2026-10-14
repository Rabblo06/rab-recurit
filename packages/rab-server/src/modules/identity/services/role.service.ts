import { CUSTOM_ROLE_KEY_PREFIX, isCustomRoleKey, MEMBER_ROLE_ALLOWED_PERMISSIONS, PermissionFlag, PermissionFlagType } from '@rab/shared';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { SecurityVersionService } from '../../../engine/core-modules/auth/services/security-version.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { CreateRoleDto } from '../dto/create-role.dto';
import { UpdateRoleDto } from '../dto/update-role.dto';
import { Permission, Role, RolePermission } from '../entities';
import { MemberRolePolicyService } from './member-role-policy.service';

export interface RoleSummary {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  /** A custom role of THIS workspace that can be edited here and assigned through Invite. */
  isMemberRole: boolean;
  /** Holders with an active membership in the caller's workspace — never an organisation-wide figure. */
  assignedUserCount: number;
}

export interface RoleMember {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface RoleDetail extends RoleSummary {
  permissionKeys: string[];
  members: RoleMember[];
}

export interface PermissionCatalogEntry {
  key: string;
  resource: string;
  action: string;
  description: string | null;
  /** Whether a custom workspace-member role may hold this permission. */
  memberAssignable: boolean;
}

const MEMBER_ALLOWED = new Set<string>(MEMBER_ROLE_ALLOWED_PERMISSIONS);

/**
 * Settings → Members → Roles. System roles (Manager, CEO, Staff, Venue Manager, …) are read-only here — their
 * permissions apply organisation-wide, so no single Manager may change them for everyone. Custom roles are
 * workspace-member roles: created inside the caller's own workspace, keyed `custom_…`, invisible to every other
 * workspace (RLS), limited to member-safe permissions and never granting more than the actor holds
 * (`MemberRolePolicyService`). Every method re-checks ROLE_VIEW / ROLE_MANAGE itself (CLAUDE.md layer 2).
 */
@Injectable()
export class RoleService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly securityVersion: SecurityVersionService,
    private readonly permissions: PermissionsService,
    private readonly memberRolePolicy: MemberRolePolicyService,
  ) {}

  private async assertPermissionTx(manager: EntityManager, ctx: AuthContext, flag: PermissionFlagType): Promise<void> {
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, flag))) {
      throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
    }
  }

  async list(ctx: AuthContext): Promise<RoleSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertPermissionTx(manager, ctx, PermissionFlag.ROLE_VIEW);
      const roles = await manager.find(Role, { order: { isSystem: 'DESC', name: 'ASC' } });
      const counts = await this.memberCountsTx(manager, ctx);
      return roles.map((role) => this.toSummary(role, ctx, counts.get(role.id) ?? 0));
    });
  }

  async get(ctx: AuthContext, id: string): Promise<RoleDetail> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertPermissionTx(manager, ctx, PermissionFlag.ROLE_VIEW);
      return this.detailTx(manager, ctx, id);
    });
  }

  async listPermissionCatalog(ctx: AuthContext): Promise<PermissionCatalogEntry[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertPermissionTx(manager, ctx, PermissionFlag.ROLE_VIEW);
      const rows = await manager.find(Permission, { order: { resource: 'ASC', action: 'ASC' } });
      return rows.map((p) => ({
        key: p.key,
        resource: p.resource,
        action: p.action,
        description: p.description ?? null,
        memberAssignable: MEMBER_ALLOWED.has(p.key),
      }));
    });
  }

  async create(ctx: AuthContext, dto: CreateRoleDto): Promise<RoleDetail> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertPermissionTx(manager, ctx, PermissionFlag.ROLE_MANAGE);
      if (!ctx.workspaceId) {
        throw new ForbiddenException('Complete your Workspace setup before creating roles — your account has no Workspace yet.');
      }
      await this.memberRolePolicy.assertGrantableTx(manager, ctx, dto.permissionKeys);

      // The key is internal and never renamed. Always `custom_…`: it can never equal a privileged system key, and
      // authentication recognises workspace-member roles only by this prefix.
      const slug = dto.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role';
      const baseKey = `${CUSTOM_ROLE_KEY_PREFIX}${slug}`.slice(0, 60);
      let key = baseKey;
      let suffix = 1;
      // Keys are unique per organisation; another workspace's role is invisible here, so a clash surfaces as a
      // unique violation instead — retried with the next suffix.
      for (;;) {
        if (!(await manager.findOne(Role, { where: { organisationId: ctx.organisationId!, key } }))) {
          const inserted = await manager
            .createQueryBuilder()
            .insert()
            .into(Role)
            .values({ organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId, key, name: dto.name.trim(), isSystem: false })
            .orIgnore()
            .returning('id')
            .execute();
          const roleId = inserted.raw?.[0]?.id as string | undefined;
          if (roleId) {
            await this.setPermissions(manager, ctx.organisationId!, roleId, dto.permissionKeys);
            await this.auditService.record(manager, ctx, AuditAction.ROLE_CREATED, {
              entityType: 'role',
              entityId: roleId,
              metadata: { name: dto.name.trim(), permissionKeys: dto.permissionKeys, workspaceId: ctx.workspaceId },
            });
            return this.detailTx(manager, ctx, roleId);
          }
        }
        key = `${baseKey}_${++suffix}`;
        if (suffix > 50) throw new ConflictException('Could not create this role. Try a different name.');
      }
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateRoleDto): Promise<RoleDetail> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertPermissionTx(manager, ctx, PermissionFlag.ROLE_MANAGE);
      const role = await manager.findOne(Role, { where: { id } });
      if (!role) throw new NotFoundException('Role not found.');
      if (!this.isMemberRole(role, ctx)) {
        throw new ConflictException('System roles apply to the whole organisation and cannot be changed here. Create a custom role instead.');
      }

      if (dto.name !== undefined && dto.name.trim() !== role.name) {
        await manager.update(Role, id, { name: dto.name.trim() });
        await this.auditService.record(manager, ctx, AuditAction.ROLE_UPDATED, { entityType: 'role', entityId: id, metadata: { name: dto.name.trim() } });
      }

      if (dto.permissionKeys !== undefined) {
        await this.memberRolePolicy.assertGrantableTx(manager, ctx, dto.permissionKeys);
        const beforeKeys = new Set<string>(await this.memberRolePolicy.permissionKeysTx(manager, id));
        const afterKeys = new Set<string>(dto.permissionKeys);
        await this.setPermissions(manager, ctx.organisationId!, id, dto.permissionKeys);
        await this.auditService.record(manager, ctx, AuditAction.ROLE_PERMISSIONS_UPDATED, {
          entityType: 'role',
          entityId: id,
          metadata: { added: dto.permissionKeys.filter((k) => !beforeKeys.has(k)), removed: [...beforeKeys].filter((k) => !afterKeys.has(k)) },
        });
      }

      return this.detailTx(manager, ctx, id);
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────────────

  private isMemberRole(role: Role, ctx: AuthContext): boolean {
    return !role.isSystem && !!ctx.workspaceId && role.workspaceId === ctx.workspaceId && isCustomRoleKey(role.key);
  }

  private toSummary(role: Role, ctx: AuthContext, assignedUserCount: number): RoleSummary {
    return { id: role.id, key: role.key, name: role.name, isSystem: role.isSystem, isMemberRole: this.isMemberRole(role, ctx), assignedUserCount };
  }

  /** Holder counts limited to active members of the caller's workspace (membership RLS: owner sees all, others themselves). */
  private async memberCountsTx(manager: EntityManager, ctx: AuthContext): Promise<Map<string, number>> {
    if (!ctx.workspaceId) return new Map();
    const rows = await manager.query<Array<{ role_id: string; count: string }>>(
      `SELECT ur.role_id, count(DISTINCT ur.user_id)::text AS count
         FROM core.user_role ur
         JOIN core.workspace_membership m ON m.user_id = ur.user_id AND m.workspace_id = $1 AND m.status = 'active'
        GROUP BY ur.role_id`,
      [ctx.workspaceId],
    );
    return new Map(rows.map((r) => [r.role_id, Number(r.count)]));
  }

  private async detailTx(manager: EntityManager, ctx: AuthContext, id: string): Promise<RoleDetail> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Role not found.');
    const role = await manager.findOne(Role, { where: { id } });
    if (!role) throw new NotFoundException('Role not found.');
    const members: RoleMember[] = ctx.workspaceId
      ? (
          await manager.query<Array<{ user_id: string; first_name: string; last_name: string; email: string }>>(
            `SELECT u.id AS user_id, u.first_name, u.last_name, u.email::text AS email
               FROM core.user_role ur
               JOIN core.workspace_membership m ON m.user_id = ur.user_id AND m.workspace_id = $2 AND m.status = 'active'
               JOIN core."user" u ON u.id = ur.user_id
              WHERE ur.role_id = $1
              ORDER BY u.first_name, u.last_name
              LIMIT 200`,
            [id, ctx.workspaceId],
          )
        ).map((m) => ({ userId: m.user_id, firstName: m.first_name, lastName: m.last_name, email: m.email }))
      : [];
    return {
      ...this.toSummary(role, ctx, members.length),
      permissionKeys: await this.memberRolePolicy.permissionKeysTx(manager, id),
      members,
    };
  }

  private async setPermissions(
    manager: EntityManager,
    organisationId: string,
    roleId: string,
    permissionKeys: PermissionFlagType[],
  ): Promise<void> {
    const permissions = permissionKeys.length
      ? await manager.createQueryBuilder(Permission, 'p').where('p.key IN (:...keys)', { keys: permissionKeys }).getMany()
      : [];

    await manager.delete(RolePermission, { roleId });
    if (permissions.length > 0) {
      await manager.insert(
        RolePermission,
        permissions.map((p) => ({ roleId, permissionId: p.id, organisationId })),
      );
    }
    // P1D: bumped here (not only from update()) so create()'s own first-ever setPermissions call
    // is covered too — harmless on creation (nothing holds this role yet to invalidate) and keeps
    // this the single place that ever changes core.role_permission in sync with the one place
    // that ever needs to signal it changed.
    await this.securityVersion.bumpRole(manager, roleId);
  }
}
