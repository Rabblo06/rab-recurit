import { ForbiddenException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { MemberObjectKey, MEMBER_OBJECTS } from './member-object-registry';
import { andCompiled, compileRecordFilter, CompiledFilter } from './record-filter';

/**
 * The effective permissions of the CALLER on one object, resolved per request from PostgreSQL (never from a cache).
 *
 * `restricted: false` — the caller is not a pure custom workspace-member (owner, CEO, venue manager, staff, admin):
 * nothing changes for them; their existing scope rules apply exactly as before.
 *
 * `restricted: true` — a custom workspace-member reading their workspace owner's records. On top of the mandatory
 * organisation / workspace / owner scope the caller's service already applies, this adds:
 *   - object read: every custom role the member holds must allow it (override ?? the role's "All Objects" baseline);
 *   - fields: a property is returned only if EVERY role leaves its field visible (whitelist; unknown properties hidden);
 *   - records: every role's record filter is ANDed in.
 * Anything unexpected (no roles, unknown object, invalid stored filter) denies.
 */
export interface ObjectAccessPolicy {
  object: MemberObjectKey;
  restricted: boolean;
  canRead: boolean;
  visibleFields: Set<string>;
  visibleProperties: Set<string>;
  filters: unknown[];
}

@Injectable()
export class MemberAccessPolicyService {
  constructor(private readonly resourceScope: ResourceScopeService) {}

  async resolveTx(manager: EntityManager, ctx: AuthContext, objectKey: MemberObjectKey): Promise<ObjectAccessPolicy> {
    const object = MEMBER_OBJECTS[objectKey];
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (!(scope.kind === 'owner' && scope.delegated)) {
      return { object: objectKey, restricted: false, canRead: true, visibleFields: new Set(), visibleProperties: new Set(), filters: [] };
    }
    const deny: ObjectAccessPolicy = { object: objectKey, restricted: true, canRead: false, visibleFields: new Set(), visibleProperties: new Set(), filters: [] };
    if (!ctx.workspaceId) return deny;

    // Custom roles of THIS workspace only (role RLS also hides other workspaces' roles).
    const roles = await manager.query<Array<{ id: string; can_read_all_objects: boolean }>>(
      `SELECT r.id, r.can_read_all_objects
         FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND r.workspace_id = $2 AND r.is_system = false`,
      [ctx.userId, ctx.workspaceId],
    );
    if (roles.length === 0) return deny;
    const roleIds = roles.map((r) => r.id);
    const objectRows = await manager.query<Array<{ role_id: string; can_read: boolean | null; record_filter: unknown }>>(
      `SELECT role_id, can_read, record_filter FROM core.role_object_permission WHERE role_id = ANY($1::uuid[]) AND object_key = $2`,
      [roleIds, objectKey],
    );
    const fieldRows = await manager.query<Array<{ role_id: string; field_key: string; can_read: boolean }>>(
      `SELECT role_id, field_key, can_read FROM core.role_field_permission WHERE role_id = ANY($1::uuid[]) AND object_key = $2`,
      [roleIds, objectKey],
    );

    const canRead = roles.every((role) => {
      const override = objectRows.find((o) => o.role_id === role.id)?.can_read;
      return (override ?? role.can_read_all_objects) === true;
    });
    if (!canRead) return deny;

    const visibleFields = new Set<string>();
    for (const field of object.fields) {
      const visible = field.locked
        ? true
        : roles.every((role) => fieldRows.find((f) => f.role_id === role.id && f.field_key === field.key)?.can_read ?? field.defaultVisible);
      if (visible) visibleFields.add(field.key);
    }
    const visibleProperties = new Set<string>(object.baseProperties);
    for (const field of object.fields) if (visibleFields.has(field.key)) field.properties.forEach((p) => visibleProperties.add(p));

    const filters = objectRows.map((o) => o.record_filter).filter((f) => f !== null && f !== undefined);
    return { object: objectKey, restricted: true, canRead: true, visibleFields, visibleProperties, filters };
  }

  /** Throw 403 when a restricted caller may not read this object at all (route guards normally catch this first). */
  assertCanRead(policy: ObjectAccessPolicy): void {
    if (!policy.canRead) throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
  }

  /** Record filter for a TypeORM QueryBuilder: `qb.andWhere(where.sql, where.named)`. TRUE when unrestricted. */
  qbWhere(policy: ObjectAccessPolicy, alias: string): CompiledFilter {
    if (!policy.restricted) return { sql: 'TRUE', named: {}, positional: [] };
    if (!policy.canRead) return { sql: 'FALSE', named: {}, positional: [] };
    if (policy.filters.length === 0) return { sql: 'TRUE', named: {}, positional: [] };
    return andCompiled(policy.filters.map((f, i) => compileRecordFilter(policy.object, f, { mode: 'qb', alias, paramPrefix: `rf_${policy.object}_${i}_` })));
  }

  /** Record filter for raw SQL with positional parameters starting at `firstParam`. */
  rawWhere(policy: ObjectAccessPolicy, alias: string, firstParam: number): CompiledFilter {
    if (!policy.restricted) return { sql: 'TRUE', named: {}, positional: [] };
    if (!policy.canRead) return { sql: 'FALSE', named: {}, positional: [] };
    const parts: CompiledFilter[] = [];
    let next = firstParam;
    for (const f of policy.filters) {
      const part = compileRecordFilter(policy.object, f, { mode: 'raw', alias, firstParam: next });
      next += part.positional.length;
      parts.push(part);
    }
    return parts.length ? andCompiled(parts) : { sql: 'TRUE', named: {}, positional: [] };
  }

  isFieldVisible(policy: ObjectAccessPolicy, fieldKey: string): boolean {
    return !policy.restricted || policy.visibleFields.has(fieldKey);
  }

  /** Whitelist projection of one serialised record. Unrestricted callers get the record unchanged. */
  project<T extends object>(policy: ObjectAccessPolicy, record: T): T {
    if (!policy.restricted) return record;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) if (policy.visibleProperties.has(key)) out[key] = value;
    return out as T;
  }
}
