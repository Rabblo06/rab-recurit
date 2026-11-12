import { PermissionFlagType } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import {
  Permission,
  Role,
  RolePermission,
  UserPermissionOverride,
  UserRole,
} from '../../../modules/identity/entities';

/**
 * Resolved server-side per request, never read off the JWT (§5.2) — a
 * revoked permission takes effect on the next request, not after a 15-min
 * access-token TTL expires. `userHasPermission` opens its own short-lived
 * `runInTenantContext` transaction for a standalone caller. A caller that
 * already holds a tenant-bound `EntityManager` (e.g. a handler checking
 * several flags in the course of one request) should call
 * `userHasPermissionTx` instead — same query, no extra
 * BEGIN/set_config/COMMIT round trips per check. This became a real cost
 * once a caller started checking 4 flags per request (dashboard.service.ts)
 * — see the 2026-09-25 performance audit in docs/HANDOFF.md.
 */
@Injectable()
export class PermissionsService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Phase X SC-05: display hints for many flags at once (`GET /auth/capabilities`), never an authorisation decision — every
   * action keeps its own route guard and service re-check.
   *
   *  - Common case: answered from the request's own security snapshot (`ctx.security.effectivePermissions`), the exact set
   *    `PermissionGuard` authorises every route of this request from. Zero SQL, zero transactions (previously one
   *    transaction and two queries per flag, 18 concurrent transactions per call against a 9-connection pool).
   *  - The snapshot is used ONLY when it describes exactly this identity (same user, organisation and workspace, no Admin
   *    Inspect). Under Admin Inspect `ctx` is the TARGET while `security` is still the ADMIN's, so the target's set is
   *    resolved instead, in ONE tenant transaction with ONE query (`effectivePermissionsTx`) — never the admin's grants.
   *    Any other mismatch (or no snapshot at all) takes the same one-transaction path: fail closed to a live read, never
   *    to someone else's set.
   */
  async displayHints<F extends PermissionFlagType>(ctx: AuthContext, flags: readonly F[]): Promise<Record<F, boolean>> {
    const snapshot = ctx.security;
    const snapshotIsThisIdentity =
      !ctx.inspectedBy &&
      snapshot !== undefined &&
      snapshot.userId === ctx.userId &&
      snapshot.organisationId === ctx.organisationId &&
      snapshot.workspaceId === ctx.workspaceId;
    const effective: ReadonlySet<string> = snapshotIsThisIdentity
      ? snapshot.effectivePermissions
      : await this.tenantContext.runInTenantContext(ctx, (manager) => this.effectivePermissionsTx(manager, ctx));
    return Object.fromEntries(flags.map((flag) => [flag, effective.has(flag)])) as Record<F, boolean>;
  }

  /**
   * Every permission key `ctx.userId` holds in this transaction, in ONE statement: role grants (only roles visible under RLS,
   * so another workspace's custom role never contributes; G5) minus per-user `revoke` overrides, plus `grant` overrides.
   * The same precedence `userHasPermissionTx` applies one flag at a time (an override wins over roles; one override per
   * (user, permission), the table's primary key), and the same `effective` CTE the request security snapshot uses.
   * Equivalence for every flag is pinned by sc05-capabilities.integration.spec.ts.
   */
  async effectivePermissionsTx(manager: EntityManager, ctx: AuthContext): Promise<Set<string>> {
    const rows = await manager.query<Array<{ key: string }>>(
      `WITH role_perms AS (
         SELECT DISTINCT p.key
           FROM core.user_role ur
           JOIN core.role r ON r.id = ur.role_id
           JOIN core.role_permission rp ON rp.role_id = ur.role_id
           JOIN core.permission p ON p.id = rp.permission_id
          WHERE ur.user_id = $1
       ),
       overrides AS (
         SELECT p.key, upo.effect
           FROM core.user_permission_override upo
           JOIN core.permission p ON p.id = upo.permission_id
          WHERE upo.user_id = $1
       )
       SELECT key FROM role_perms WHERE key NOT IN (SELECT key FROM overrides WHERE effect = 'revoke')
       UNION
       SELECT key FROM overrides WHERE effect = 'grant'`,
      [ctx.userId],
    );
    return new Set(rows.map((row) => row.key));
  }

  async userHasPermission(ctx: AuthContext, permission: PermissionFlagType): Promise<boolean> {
    return this.tenantContext.runInTenantContext(ctx, (manager) =>
      this.userHasPermissionTx(manager, ctx, permission),
    );
  }

  async userHasPermissionTx(
    manager: EntityManager,
    ctx: AuthContext,
    permission: PermissionFlagType,
  ): Promise<boolean> {
    const override = await manager
      .createQueryBuilder(UserPermissionOverride, 'upo')
      .innerJoin(Permission, 'p', 'p.id = upo.permission_id')
      .where('upo.user_id = :userId', { userId: ctx.userId })
      .andWhere('p.key = :permission', { permission })
      .select('upo.effect', 'effect')
      .getRawOne<{ effect: 'grant' | 'revoke' }>();

    if (override?.effect === 'grant') return true;
    if (override?.effect === 'revoke') return false;

    const count = await manager
      .createQueryBuilder(UserRole, 'ur')
      // Only roles visible under RLS: a custom role of ANOTHER workspace (hidden by role RLS) never grants here.
      .innerJoin(Role, 'r', 'r.id = ur.role_id')
      .innerJoin(RolePermission, 'rp', 'rp.role_id = ur.role_id')
      .innerJoin(Permission, 'p', 'p.id = rp.permission_id')
      .where('ur.user_id = :userId', { userId: ctx.userId })
      .andWhere('p.key = :permission', { permission })
      .getCount();

    return count > 0;
  }
}
