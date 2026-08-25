import { PermissionFlagType } from '@rab/shared';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { CreateRoleDto } from '../dto/create-role.dto';
import { UpdateRoleDto } from '../dto/update-role.dto';
import { Permission, Role, RolePermission, UserRole } from '../entities';

export interface RoleSummary {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  assignedUserCount: number;
}

export interface RoleDetail extends RoleSummary {
  permissionKeys: string[];
}

export interface PermissionCatalogEntry {
  key: string;
  resource: string;
  action: string;
  description: string | null;
}

@Injectable()
export class RoleService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
  ) {}

  async list(ctx: AuthContext): Promise<RoleSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const rows = await manager
        .createQueryBuilder(Role, 'r')
        .leftJoin(UserRole, 'ur', 'ur.role_id = r.id')
        .select('r.id', 'id')
        .addSelect('r.key', 'key')
        .addSelect('r.name', 'name')
        .addSelect('r.is_system', 'isSystem')
        .addSelect('COUNT(ur.user_id)', 'assignedUserCount')
        .groupBy('r.id')
        .orderBy('r.name', 'ASC')
        .getRawMany<{ id: string; key: string; name: string; isSystem: boolean; assignedUserCount: string }>();

      return rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        isSystem: r.isSystem,
        assignedUserCount: Number(r.assignedUserCount),
      }));
    });
  }

  async get(ctx: AuthContext, id: string): Promise<RoleDetail> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const role = await manager.findOne(Role, { where: { id } });
      if (!role) throw new NotFoundException('Role not found.');

      const assignedUserCount = await manager.count(UserRole, { where: { roleId: id } });
      const permissionRows = await manager
        .createQueryBuilder(RolePermission, 'rp')
        .innerJoin(Permission, 'p', 'p.id = rp.permission_id')
        .where('rp.role_id = :id', { id })
        .select('p.key', 'key')
        .getRawMany<{ key: string }>();

      return {
        id: role.id,
        key: role.key,
        name: role.name,
        isSystem: role.isSystem,
        assignedUserCount,
        permissionKeys: permissionRows.map((p) => p.key),
      };
    });
  }

  async listPermissionCatalog(ctx: AuthContext): Promise<PermissionCatalogEntry[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const rows = await manager.find(Permission, { order: { resource: 'ASC', action: 'ASC' } });
      return rows.map((p) => ({ key: p.key, resource: p.resource, action: p.action, description: p.description ?? null }));
    });
  }

  async create(ctx: AuthContext, dto: CreateRoleDto): Promise<RoleDetail> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // key is a stable, internal, never-renamed identifier (see Role
      // entity) — slugify the display name for it, disambiguating on
      // collision rather than failing, since the client only ever supplies
      // `name`.
      const baseKey = dto.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role';
      let key = baseKey;
      let suffix = 1;
      while (await manager.findOne(Role, { where: { organisationId: ctx.organisationId!, key } })) {
        key = `${baseKey}_${++suffix}`;
      }

      const result = await manager.insert(Role, {
        organisationId: ctx.organisationId!,
        key,
        name: dto.name,
        isSystem: false,
      });
      const roleId = result.identifiers[0]!.id as string;

      await this.setPermissions(manager, ctx.organisationId!, roleId, dto.permissionKeys);
      await this.auditService.record(manager, ctx, AuditAction.ROLE_CREATED, {
        entityType: 'role',
        entityId: roleId,
        metadata: { name: dto.name },
      });

      return this.get(ctx, roleId);
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateRoleDto): Promise<RoleDetail> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const role = await manager.findOne(Role, { where: { id } });
      if (!role) throw new NotFoundException('Role not found.');
      if (role.isSystem && dto.name !== undefined) {
        throw new ConflictException('System roles cannot be renamed.');
      }

      if (dto.name !== undefined) {
        await manager.update(Role, id, { name: dto.name });
        await this.auditService.record(manager, ctx, AuditAction.ROLE_UPDATED, {
          entityType: 'role',
          entityId: id,
          metadata: { name: dto.name },
        });
      }

      if (dto.permissionKeys !== undefined) {
        const before = await manager
          .createQueryBuilder(RolePermission, 'rp')
          .innerJoin(Permission, 'p', 'p.id = rp.permission_id')
          .where('rp.role_id = :id', { id })
          .select('p.key', 'key')
          .getRawMany<{ key: string }>();
        const beforeKeys = new Set(before.map((b) => b.key));
        const afterKeys = new Set<string>(dto.permissionKeys);

        await this.setPermissions(manager, ctx.organisationId!, id, dto.permissionKeys);

        const added = dto.permissionKeys.filter((k) => !beforeKeys.has(k));
        const removed = [...beforeKeys].filter((k) => !afterKeys.has(k));
        await this.auditService.record(manager, ctx, AuditAction.ROLE_PERMISSIONS_UPDATED, {
          entityType: 'role',
          entityId: id,
          metadata: { added, removed },
        });
      }

      return this.get(ctx, id);
    });
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
  }
}
