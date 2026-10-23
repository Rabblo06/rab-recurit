import { CUSTOM_ROLE_KEY_PREFIX, isCustomRoleKey, MEMBER_ROLE_ALLOWED_PERMISSIONS, PermissionFlag, PermissionFlagType } from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { SecurityVersionService } from '../../../engine/core-modules/auth/services/security-version.service';
import { PermissionCatalogueCacheService } from '../../../engine/core-modules/entity-cache/permission-catalogue-cache.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { ROLE_ICONS, RoleDefinitionDto } from '../dto/role-definition.dto';
import { Permission, Role, RolePermission } from '../entities';
import { MEMBER_OBJECT_KEYS, MEMBER_OBJECTS, MemberObjectKey, publicObjectMetadata } from '../member-access/member-object-registry';
import { RecordFilterError, validateRecordFilter } from '../member-access/record-filter';
import { MemberRolePolicyService } from './member-role-policy.service';

export interface RoleSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  isSystem: boolean;
  /** A custom role of THIS workspace that can be edited here and assigned through Invite. */
  isMemberRole: boolean;
  assignableToMembers: boolean;
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

export interface RoleObjectRule {
  object: MemberObjectKey;
  read: 'inherit' | 'grant' | 'deny';
  fields: Record<string, 'visible' | 'hidden'>;
  recordFilter: unknown | null;
}

export interface RoleDefinition {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  isSystem: boolean;
  isMemberRole: boolean;
  assignableToMembers: boolean;
  readAllObjects: boolean;
  objects: RoleObjectRule[];
  /** Read-only roles (system roles) expose their flat flags instead of an editable definition. */
  permissionKeys: string[];
  updatedAt: Date;
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
const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Settings → Members → Roles. System roles (Manager, CEO, Staff, Venue Manager, …) are read-only here — their
 * permissions apply organisation-wide, so no single Manager may change them for everyone. Custom roles are
 * workspace-member roles: created inside the caller's own workspace, keyed `custom_…`, invisible to every other
 * workspace (RLS), limited to member-safe permissions and never granting more than the actor holds.
 *
 * A custom role's full definition — settings, the "All Objects" baseline, per-object read overrides, field visibility
 * and record filters — is saved in ONE transaction (`saveDefinition`). The effective object reads are materialised into
 * the existing `role_permission` flags in the same transaction and `role.permission_version` is bumped, so cached auth
 * snapshots are invalidated atomically with the change. Every method re-checks ROLE_VIEW / ROLE_MANAGE (layer 2).
 */
@Injectable()
export class RoleService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly securityVersion: SecurityVersionService,
    private readonly permissions: PermissionsService,
    private readonly memberRolePolicy: MemberRolePolicyService,
    // Wave 5 lane OPS: the static flag catalogue through the Redis/L1 metadata cache. Optional: absent = direct read.
    @Optional() private readonly permissionCatalogue?: PermissionCatalogueCacheService,
  ) {}

  private async assertPermissionTx(manager: EntityManager, ctx: AuthContext, flag: PermissionFlagType): Promise<void> {
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, flag))) {
      throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
    }
  }

  // ── read ───────────────────────────────────────────────────────────────────────────────────────────────

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
      // ROLE_VIEW stays a live, per-request check — only the (tenant-independent) catalogue rows are cached.
      await this.assertPermissionTx(manager, ctx, PermissionFlag.ROLE_VIEW);
      const rows = this.permissionCatalogue
        ? await this.permissionCatalogue.list(manager)
        : await manager.find(Permission, { order: { resource: 'ASC', action: 'ASC' } });
      return rows.map((p) => ({ key: p.key, resource: p.resource, action: p.action, description: p.description ?? null, memberAssignable: MEMBER_ALLOWED.has(p.key) }));
    });
  }

  /** Object / field / filter metadata for the editor, plus which sensitive fields THIS caller may grant. */
  async objectMetadata(ctx: AuthContext) {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertPermissionTx(manager, ctx, PermissionFlag.ROLE_VIEW);
      const held = new Set<string>();
      for (const key of new Set(MEMBER_OBJECT_KEYS.flatMap((k) => [MEMBER_OBJECTS[k].readFlag, ...MEMBER_OBJECTS[k].fields.map((f) => f.sensitiveAuthority).filter(Boolean)]))) {
        if (await this.permissions.userHasPermissionTx(manager, ctx, key as PermissionFlagType)) held.add(key as string);
      }
      return {
        objects: publicObjectMetadata().map((o) => ({
          ...o,
          grantable: held.has(MEMBER_OBJECTS[o.key].readFlag),
          fields: o.fields.map((f) => {
            const authority = MEMBER_OBJECTS[o.key].fields.find((x) => x.key === f.key)!.sensitiveAuthority;
            return { ...f, grantable: !authority || held.has(authority) };
          }),
        })),
        icons: ROLE_ICONS,
      };
    });
  }

  async getDefinition(ctx: AuthContext, id: string): Promise<RoleDefinition> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertPermissionTx(manager, ctx, PermissionFlag.ROLE_VIEW);
      return this.definitionTx(manager, ctx, id);
    });
  }

  // ── write ──────────────────────────────────────────────────────────────────────────────────────────────

  async create(ctx: AuthContext, dto: RoleDefinitionDto): Promise<RoleDefinition> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertPermissionTx(manager, ctx, PermissionFlag.ROLE_MANAGE);
      if (!ctx.workspaceId) throw new ForbiddenException('Complete your Workspace setup before creating roles — your account has no Workspace yet.');
      const plan = await this.validateDefinitionTx(manager, ctx, dto, null);

      // The key is internal and never renamed. Always `custom_…`: never equal to a privileged system key, and the
      // only marker authentication uses to recognise a workspace-member role. Keys are unique per organisation;
      // another workspace's role is invisible here, so a clash is retried with the next suffix.
      const slug = dto.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role';
      const baseKey = `${CUSTOM_ROLE_KEY_PREFIX}${slug}`.slice(0, 60);
      for (let suffix = 1; suffix <= 50; suffix++) {
        const key = suffix === 1 ? baseKey : `${baseKey}_${suffix}`;
        if (await manager.findOne(Role, { where: { organisationId: ctx.organisationId!, key } })) continue;
        const inserted = await this.insertRoleTx(manager, ctx, key, dto);
        if (!inserted) continue;
        await this.writeRulesTx(manager, ctx, inserted, plan);
        await this.auditService.record(manager, ctx, AuditAction.ROLE_CREATED, {
          entityType: 'role',
          entityId: inserted,
          metadata: { name: dto.name, permissionKeys: plan.flags, objects: plan.summary, workspaceId: ctx.workspaceId },
        });
        return this.definitionTx(manager, ctx, inserted);
      }
      throw new ConflictException('Could not create this role. Try a different name.');
    });
  }

  async update(ctx: AuthContext, id: string, dto: RoleDefinitionDto): Promise<RoleDefinition> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertPermissionTx(manager, ctx, PermissionFlag.ROLE_MANAGE);
      const role = await this.loadRoleTx(manager, id, true);
      if (!this.isMemberRole(role, ctx)) {
        throw new ConflictException('System roles apply to the whole organisation and cannot be changed here. Create a custom role instead.');
      }
      const plan = await this.validateDefinitionTx(manager, ctx, dto, role.id);
      const before = await this.definitionTx(manager, ctx, role.id);
      try {
        await manager.query(
          `UPDATE core.role SET name = $2, description = $3, icon = $4, assignable_to_members = $5, can_read_all_objects = $6, updated_at = now() WHERE id = $1`,
          [role.id, dto.name, dto.description || null, dto.icon || null, dto.assignableToMembers, dto.readAllObjects],
        );
      } catch (error) {
        throw this.mapUniqueName(error);
      }
      await this.writeRulesTx(manager, ctx, role.id, plan);
      await this.auditService.record(manager, ctx, AuditAction.ROLE_UPDATED, {
        entityType: 'role',
        entityId: role.id,
        metadata: {
          renamed: before.name !== dto.name ? { from: before.name, to: dto.name } : undefined,
          permissionKeys: plan.flags,
          objects: plan.summary,
          assignableToMembers: dto.assignableToMembers,
        },
      });
      return this.definitionTx(manager, ctx, role.id);
    });
  }

  /** Custom roles only; refused while any member holds it or any invitation (live or historical) references it. */
  async delete(ctx: AuthContext, id: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertPermissionTx(manager, ctx, PermissionFlag.ROLE_MANAGE);
      const role = await this.loadRoleTx(manager, id, true);
      if (!this.isMemberRole(role, ctx)) throw new ConflictException('System roles cannot be deleted.');
      const [{ holders }] = await manager.query<Array<{ holders: number }>>(`SELECT count(*)::int AS holders FROM core.user_role WHERE role_id = $1`, [role.id]);
      const [{ invitations }] = await manager.query<Array<{ invitations: number }>>(
        `SELECT count(*)::int AS invitations FROM core.member_invitation WHERE role_id = $1`,
        [role.id],
      );
      if (holders > 0 || invitations > 0) {
        throw new ConflictException({
          code: 'ROLE_IN_USE',
          message: `This role is still in use (${holders} member${holders === 1 ? '' : 's'}, ${invitations} invitation${invitations === 1 ? '' : 's'}). Move members to another role first.`,
          holders,
          invitations,
        });
      }
      await manager.query(`DELETE FROM core.role WHERE id = $1`, [role.id]);
      await this.auditService.record(manager, ctx, AuditAction.ROLE_DELETED, { entityType: 'role', entityId: role.id, metadata: { name: role.name } });
    });
  }

  // ── validation & persistence ───────────────────────────────────────────────────────────────────────────

  private async validateDefinitionTx(
    manager: EntityManager,
    ctx: AuthContext,
    dto: RoleDefinitionDto,
    roleId: string | null,
  ): Promise<{ flags: PermissionFlagType[]; rules: RoleObjectRule[]; summary: Record<string, string> }> {
    const fail = (message: string, field?: string) => new BadRequestException({ code: 'INVALID_ROLE_DEFINITION', message, field });
    if (!dto.name.trim()) throw fail('Enter a role name.', 'name');

    // Names: unique (case-insensitive) within the workspace, and never a system role's name (no look-alike roles).
    const clash = await manager.query<Array<{ id: string }>>(
      `SELECT id FROM core.role WHERE lower(btrim(name)) = lower(btrim($1)) AND (workspace_id = $2 OR is_system) AND ($3::uuid IS NULL OR id <> $3::uuid) LIMIT 1`,
      [dto.name, ctx.workspaceId, roleId],
    );
    if (clash.length) throw new ConflictException({ code: 'ROLE_NAME_TAKEN', message: 'A role with this name already exists.', field: 'name' });

    const seen = new Set<string>();
    const rules: RoleObjectRule[] = [];
    for (const rule of dto.objects) {
      if (seen.has(rule.object)) throw fail(`${MEMBER_OBJECTS[rule.object].labelPlural} has more than one rule.`);
      seen.add(rule.object);
      const object = MEMBER_OBJECTS[rule.object];
      const fields: Record<string, 'visible' | 'hidden'> = {};
      for (const [key, value] of Object.entries(rule.fields ?? {})) {
        const field = object.fields.find((f) => f.key === key);
        if (!field) throw fail(`Unknown field "${key}" on ${object.labelPlural}.`);
        if (value !== 'visible' && value !== 'hidden') throw fail(`${field.label}: choose visible or hidden.`);
        if (field.locked && value === 'hidden') throw fail(`${field.label} is always visible to anyone who can see ${object.labelPlural}.`);
        if (value === 'visible' && field.sensitiveAuthority && !(await this.permissions.userHasPermissionTx(manager, ctx, field.sensitiveAuthority))) {
          throw new ForbiddenException({ code: 'ROLE_ESCALATION', message: `You can't make "${field.label}" visible because you don't have access to it yourself.` });
        }
        if (!field.locked) fields[key] = value;
      }
      let recordFilter: unknown = null;
      if (rule.recordFilter) {
        try {
          const validated = validateRecordFilter(rule.object, rule.recordFilter);
          await this.assertRelationsInScopeTx(manager, ctx, validated.relationIds);
          recordFilter = validated.filter;
        } catch (error) {
          if (error instanceof RecordFilterError) throw fail(`${object.labelPlural} record filter: ${error.message}`);
          throw error;
        }
      }
      rules.push({ object: rule.object, read: rule.read, fields, recordFilter });
    }

    // Materialise effective reads into the existing route flags; MemberRolePolicyService enforces the member allowlist
    // and that the actor holds every flag (no escalation).
    const flags: PermissionFlagType[] = [];
    const summary: Record<string, string> = {};
    for (const key of MEMBER_OBJECT_KEYS) {
      const rule = rules.find((r) => r.object === key);
      const read = rule?.read === 'grant' ? true : rule?.read === 'deny' ? false : dto.readAllObjects;
      summary[key] = read ? 'see' : 'none';
      if (read) flags.push(MEMBER_OBJECTS[key].readFlag);
    }
    await this.memberRolePolicy.assertGrantableTx(manager, ctx, flags);
    return { flags, rules, summary };
  }

  /** Relation ids used in filters must be records the actor can see in this workspace (no probing other workspaces). */
  private async assertRelationsInScopeTx(manager: EntityManager, ctx: AuthContext, relationIds: Record<string, string[]>): Promise<void> {
    for (const [table, ids] of Object.entries(relationIds)) {
      if (table !== 'venue' && table !== 'job_role') throw new RecordFilterError('Unsupported relation.');
      const rows = await manager.query<Array<{ id: string }>>(
        `SELECT id FROM core.${table} WHERE id = ANY($1::uuid[]) AND workspace_id = $2`,
        [ids, ctx.workspaceId],
      );
      if (rows.length !== ids.length) throw new RecordFilterError('One of the selected records no longer exists.');
    }
  }

  private async insertRoleTx(manager: EntityManager, ctx: AuthContext, key: string, dto: RoleDefinitionDto): Promise<string | null> {
    try {
      const rows = await manager.query<Array<{ id: string }>>(
        `INSERT INTO core.role (organisation_id, workspace_id, key, name, is_system, description, icon, assignable_to_members, can_read_all_objects)
         VALUES ($1, $2, $3, $4, false, $5, $6, $7, $8)
         ON CONFLICT (organisation_id, key) DO NOTHING
         RETURNING id`,
        [ctx.organisationId, ctx.workspaceId, key, dto.name, dto.description || null, dto.icon || null, dto.assignableToMembers, dto.readAllObjects],
      );
      return rows[0]?.id ?? null;
    } catch (error) {
      throw this.mapUniqueName(error);
    }
  }

  private mapUniqueName(error: unknown): unknown {
    if (error instanceof QueryFailedError && (error as unknown as { constraint?: string }).constraint === 'role_member_name_per_workspace') {
      return new ConflictException({ code: 'ROLE_NAME_TAKEN', message: 'A role with this name already exists.', field: 'name' });
    }
    return error;
  }

  private async writeRulesTx(
    manager: EntityManager,
    ctx: AuthContext,
    roleId: string,
    plan: { flags: PermissionFlagType[]; rules: RoleObjectRule[] },
  ): Promise<void> {
    await manager.query(`DELETE FROM core.role_object_permission WHERE role_id = $1`, [roleId]);
    await manager.query(`DELETE FROM core.role_field_permission WHERE role_id = $1`, [roleId]);
    for (const rule of plan.rules) {
      const canRead = rule.read === 'inherit' ? null : rule.read === 'grant';
      await manager.query(
        `INSERT INTO core.role_object_permission (role_id, workspace_id, organisation_id, object_key, can_read, record_filter, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [roleId, ctx.workspaceId, ctx.organisationId, rule.object, canRead, rule.recordFilter === null ? null : JSON.stringify(rule.recordFilter), ctx.userId],
      );
      for (const [fieldKey, value] of Object.entries(rule.fields)) {
        await manager.query(
          `INSERT INTO core.role_field_permission (role_id, workspace_id, organisation_id, object_key, field_key, can_read) VALUES ($1, $2, $3, $4, $5, $6)`,
          [roleId, ctx.workspaceId, ctx.organisationId, rule.object, fieldKey, value === 'visible'],
        );
      }
    }
    // Flags + permission_version bump, in this same transaction (invalidates cached snapshots atomically).
    await this.setPermissions(manager, ctx.organisationId!, roleId, plan.flags);
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────────────

  private isMemberRole(role: Role, ctx: AuthContext): boolean {
    return !role.isSystem && !!ctx.workspaceId && role.workspaceId === ctx.workspaceId && isCustomRoleKey(role.key);
  }

  private async loadRoleTx(manager: EntityManager, id: string, lock = false): Promise<Role> {
    if (!UUID.test(id)) throw new NotFoundException('Role not found.');
    const role = await manager.findOne(Role, { where: { id }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!role) throw new NotFoundException('Role not found.');
    return role;
  }

  private toSummary(role: Role, ctx: AuthContext, assignedUserCount: number): RoleSummary {
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description ?? null,
      icon: role.icon ?? null,
      isSystem: role.isSystem,
      isMemberRole: this.isMemberRole(role, ctx),
      assignableToMembers: role.assignableToMembers,
      assignedUserCount,
    };
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

  private async definitionTx(manager: EntityManager, ctx: AuthContext, id: string): Promise<RoleDefinition> {
    const role = await this.loadRoleTx(manager, id);
    const permissionKeys = await this.memberRolePolicy.permissionKeysTx(manager, role.id);
    const objectRows = await manager.query<Array<{ object_key: MemberObjectKey; can_read: boolean | null; record_filter: unknown }>>(
      `SELECT object_key, can_read, record_filter FROM core.role_object_permission WHERE role_id = $1 ORDER BY object_key`,
      [role.id],
    );
    const fieldRows = await manager.query<Array<{ object_key: MemberObjectKey; field_key: string; can_read: boolean }>>(
      `SELECT object_key, field_key, can_read FROM core.role_field_permission WHERE role_id = $1`,
      [role.id],
    );
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description ?? null,
      icon: role.icon ?? null,
      isSystem: role.isSystem,
      isMemberRole: this.isMemberRole(role, ctx),
      assignableToMembers: role.assignableToMembers,
      readAllObjects: role.canReadAllObjects,
      objects: objectRows.map((o) => ({
        object: o.object_key,
        read: o.can_read === null ? 'inherit' : o.can_read ? 'grant' : 'deny',
        fields: Object.fromEntries(fieldRows.filter((f) => f.object_key === o.object_key).map((f) => [f.field_key, f.can_read ? 'visible' : 'hidden'])),
        recordFilter: o.record_filter ?? null,
      })),
      permissionKeys,
      updatedAt: role.updatedAt,
    };
  }

  private async detailTx(manager: EntityManager, ctx: AuthContext, id: string): Promise<RoleDetail> {
    const role = await this.loadRoleTx(manager, id);
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
    return { ...this.toSummary(role, ctx, members.length), permissionKeys: await this.memberRolePolicy.permissionKeysTx(manager, id), members };
  }

  private async setPermissions(manager: EntityManager, organisationId: string, roleId: string, permissionKeys: PermissionFlagType[]): Promise<void> {
    const permissions = permissionKeys.length
      ? await manager.createQueryBuilder(Permission, 'p').where('p.key IN (:...keys)', { keys: permissionKeys }).getMany()
      : [];
    await manager.delete(RolePermission, { roleId });
    if (permissions.length > 0) {
      await manager.insert(RolePermission, permissions.map((p) => ({ roleId, permissionId: p.id, organisationId })));
    }
    // P1D: one bump per role definition change — invalidates every cached snapshot of every holder (the version
    // vector sums role.permission_version), in the same transaction as the change itself.
    await this.securityVersion.bumpRole(manager, roleId);
  }
}
