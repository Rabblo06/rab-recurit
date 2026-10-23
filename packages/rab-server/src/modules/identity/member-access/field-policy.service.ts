import { PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { FIELD_POLICY_OBJECTS, FieldPolicyObjectKey } from './field-policy.registry';

/** The effective field visibility of the CALLER on one financial/attendance object, resolved per request. */
export interface FieldPolicy {
  object: FieldPolicyObjectKey;
  hiddenFields: ReadonlySet<string>;
  hiddenProperties: ReadonlySet<string>;
}

/**
 * Layer 2 (service) enforcement of field-level read permissions on attendance / payroll read DTOs and exports.
 *
 * Resolution, all inside the caller's own tenant-bound transaction (never a cache, never the JWT):
 *   1. A field with `sensitiveAuthority` is hidden unless the caller holds that permission now
 *      (`PermissionsService.userHasPermissionTx`: overrides + role grants, server-side).
 *   2. A custom workspace-member (delegated owner scope) additionally needs EVERY one of their custom roles to leave the
 *      field visible (`core.role_field_permission`, default `memberDefaultVisible`); no custom role ⇒ every field hidden.
 * Fail closed: an unknown object key throws (the caller's request fails rather than returning unfiltered data), and a
 * permission lookup that throws propagates (deny).
 */
@Injectable()
export class FieldPolicyService {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly resourceScope: ResourceScopeService,
  ) {}

  async resolveTx(manager: EntityManager, ctx: AuthContext, objectKey: FieldPolicyObjectKey): Promise<FieldPolicy> {
    const object = FIELD_POLICY_OBJECTS[objectKey];
    if (!object) throw new Error(`FieldPolicyService: unknown object "${String(objectKey)}" — refusing to serialise unfiltered data.`);
    const hiddenFields = new Set<string>();

    const authorities = [...new Set(object.fields.map((f) => f.sensitiveAuthority).filter((a): a is NonNullable<typeof a> => !!a))];
    const held = new Map<string, boolean>();
    for (const authority of authorities) held.set(authority, await this.permissions.userHasPermissionTx(manager, ctx, authority));
    for (const field of object.fields) {
      if (field.sensitiveAuthority && held.get(field.sensitiveAuthority) !== true) hiddenFields.add(field.key);
    }

    const scope = await this.resourceScope.resolveTx(manager, ctx);
    // Venue Managers are categorically outside payroll (architecture §1.2 / §5.7, PayrollService.canAccessPayroll):
    // a payroll.view-gated field stays hidden for a venue-scoped caller even if the flag were ever granted by mistake.
    if (scope.kind === 'venue') {
      for (const field of object.fields) if (field.sensitiveAuthority === PermissionFlag.PAYROLL_VIEW) hiddenFields.add(field.key);
    }
    if (scope.kind === 'owner' && scope.delegated) {
      const roles = ctx.workspaceId
        ? await manager.query<Array<{ id: string }>>(
            `SELECT r.id FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id
              WHERE ur.user_id = $1 AND r.workspace_id = $2 AND r.is_system = false`,
            [ctx.userId, ctx.workspaceId],
          )
        : [];
      if (roles.length === 0) {
        for (const field of object.fields) hiddenFields.add(field.key);
      } else {
        const rows = await manager.query<Array<{ role_id: string; field_key: string; can_read: boolean }>>(
          `SELECT role_id, field_key, can_read FROM core.role_field_permission WHERE role_id = ANY($1::uuid[]) AND object_key = $2`,
          [roles.map((r) => r.id), objectKey],
        );
        for (const field of object.fields) {
          const visible = roles.every((role) => rows.find((r) => r.role_id === role.id && r.field_key === field.key)?.can_read ?? field.memberDefaultVisible);
          if (!visible) hiddenFields.add(field.key);
        }
      }
    }

    const hiddenProperties = new Set<string>();
    for (const field of object.fields) if (hiddenFields.has(field.key)) field.properties.forEach((p) => hiddenProperties.add(p));
    return { object: objectKey, hiddenFields, hiddenProperties };
  }

  isVisible(policy: FieldPolicy, fieldKey: string): boolean {
    return !policy.hiddenFields.has(fieldKey);
  }

  /** Removes every hidden property (absent from the JSON, not null — a null would still announce the field). */
  omit<T extends object>(policy: FieldPolicy, record: T): T {
    if (policy.hiddenProperties.size === 0) return record;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) if (!policy.hiddenProperties.has(key)) out[key] = value;
    return out as T;
  }
}
