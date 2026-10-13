import { UserStatusType } from '@rab/shared';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import type { AuthSecuritySnapshot } from '../../tenant/auth-context.interface';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { AuthContextCacheService } from './auth-context-cache.service';
import { SecurityVersionService } from './security-version.service';
import { SessionValidityService } from './session-validity.service';
import { isPrivilegedIdleClass } from '../session-policy';
import { timeStage } from '../../../observability/request-context';

export type { AuthSecuritySnapshot };

/**
 * P1C (FULL-ARCHITECTURE-UPGRADE-PLAN.md — P1 program): ONE canonical, request-local,
 * authoritative PostgreSQL security snapshot — the consolidation of what was previously seven
 * separate `runInTenantContext` transactions chained through `JwtAuthGuard` (session validity,
 * role resolution, platform-admin, active-account, must-reset-password, maintenance-mode) plus
 * `PermissionGuard`'s own per-route transaction, each re-paying its own `bindGucs`/
 * `bindSearchPath` overhead for the exact same identity within the exact same request.
 *
 * Reuses, never reimplements:
 *   - `core.resolve_membership_for_session` (the existing, unmodified SECURITY DEFINER
 *     function `WorkspaceResolverService` already called) — live workspace/org/user resolution,
 *     never from the JWT claim or `user_session.workspace_id` alone.
 *   - `SessionValidityService.assertActive` (the existing, unmodified P1B/P1B.1 service) — same
 *     family-liveness check, same `UserSession` revocation/cutover semantics, same bounded
 *     5-minute `last_seen_at` bump. Called with THIS transaction's own manager, not a fresh one —
 *     zero duplicated session-liveness logic, zero extra transaction.
 *   - `TenantContextService.bindCoreIdentityGucs` (new, but a thin public wrapper around that
 *     service's own existing private `bindGucs` — not a second tenant-context implementation).
 *
 * AUTHORIZATION LINEARIZATION POINT (P1C §9): this transaction's `REPEATABLE READ` snapshot,
 * acquired at its first statement, IS the point in time this request's authorization decision is
 * considered to have observed authoritative state. A revocation (session, role, permission,
 * membership) that COMMITTED before this snapshot's first statement is always observed here
 * (fail-closed). A revocation that commits AFTER this snapshot was acquired is NOT retroactively
 * visible to an already-in-progress request holding this snapshot — that request completes under
 * the state it already captured, and the VERY NEXT request (a fresh snapshot) observes the new
 * state immediately. This is not a "time travel" revocation guarantee; it is the explicit,
 * deliberately narrow boundary P1D's future security-version-vector work is designed to build on.
 *
 * ONE short-lived `REPEATABLE READ` transaction (not the global default) — every statement inside
 * sees the SAME consistent point-in-time snapshot, so "session live" + "roles" + "platform-admin"
 * + "effective permissions" can never observably disagree about when they were each true, which a
 * sequence of separate READ-COMMITTED transactions (the previous design) could never guarantee.
 * `REPEATABLE READ` can raise a `40001` serialization failure on the `last_seen_at` bump UPDATE
 * under genuine same-row concurrent writers (two requests for the same session landing at nearly
 * the same instant) — retried a bounded number of times below; this is the standard, documented
 * Postgres pattern for this isolation level, not a new correctness risk.
 *
 * Request-local ONLY: built once per request by `JwtAuthGuard`, attached to `request.authContext
 * .security`, read (never recomputed, never DB-queried again) by every later guard in the SAME
 * request (`ActiveAccountGuard`, `MustResetPasswordGuard`, `MaintenanceModeGuard`,
 * `PermissionGuard`). Never stored globally, in a module singleton, or across requests — that
 * would be a cache, which P1C is explicitly scoped to NOT introduce (Redis or otherwise).
 */
interface SecurityRow {
  status: UserStatusType;
  must_reset_password: boolean;
  roles: string[] | null;
  is_platform_admin: boolean;
  maintenance_enabled: boolean;
  organisation_suspended: boolean;
  effective_permissions: string[] | null;
}

const MAX_SERIALIZATION_RETRIES = 3;

@Injectable()
export class AuthSecuritySnapshotService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly sessionValidity: SessionValidityService,
    private readonly securityVersion: SecurityVersionService,
    private readonly authContextCache: AuthContextCacheService,
  ) {}

  /**
   * `sid`/`sub`/`org` are the JWT's own already-cryptographically-verified claims — used here
   * purely as bounded LOOKUP INPUTS (P1C §7), never as live authority. Every field on the returned
   * snapshot comes from this one PostgreSQL transaction; the JWT claims are only ever compared
   * against the resolved row (`sub`/`org` must agree), never substituted for it.
   *
   * Returns `null` when the session cannot be resolved at all (unknown/foreign `sid`, or the
   * resolved family's own user/org disagrees with what the token claims) — the caller (JwtAuthGuard)
   * treats that identically to today's existing failure path: a 401, fail closed.
   *
   * Throws whatever `SessionValidityService.assertActive` throws (always `UnauthorizedException`)
   * when the session itself is not currently active — propagated unchanged, exactly as today.
   */
  async build(params: { sid: string; sub: string; org: string }): Promise<AuthSecuritySnapshot | null> {
    return this.withSerializationRetry(() =>
      this.dataSource.transaction('REPEATABLE READ', async (manager) => {
        const resolved = await timeStage('security_membership', () => this.resolveMembership(manager, params.sid));
        if (!resolved || resolved.userId !== params.sub || resolved.organisationId !== params.org) {
          return null;
        }

        await this.tenantContext.bindCoreIdentityGucs(manager, {
          organisationId: resolved.organisationId,
          workspaceId: resolved.workspaceId,
          userId: resolved.userId,
          role: '',
        });

        // P2.2 — roles/isPlatformAdmin are resolved BEFORE the session-liveness check now (moved
        // up from after it), specifically so the idle-timeout policy's privileged override (owner
        // correction, overnight P2/P3 mandate: "a platform administrator must receive the stricter
        // 30-minute inactivity policy regardless of... application target") can use THIS request's
        // own freshly-resolved role data, never a value frozen at session creation — see
        // `isPrivilegedIdleClass()`'s own doc comment in session-policy.ts. The one cost of this
        // reordering: an already-dead session now also pays for a cache lookup (or `loadSecurityRow`
        // on a cache miss) before being rejected, where it previously failed fast — accepted
        // deliberately, since correctness here matters more than that one rare-path cost.
        //
        // P1E: entirely skipped when AUTH_CONTEXT_CACHE_ENABLED is false (the default) — the
        // disabled path below is byte-for-byte what P1C already shipped, with zero added queries,
        // never just a no-op cache lookup bolted onto the same cost. `cacheKey` stays null, `get`
        // is never called, and the single `loadSecurityRow` + below is unchanged.
        let cacheKey: string | null = null;
        let cachedSnapshot: Omit<AuthSecuritySnapshot, 'userId' | 'organisationId' | 'workspaceId'> | null = null;
        if (this.authContextCache.isEnabled()) {
          const versions = await timeStage('security_versions', () =>
            this.securityVersion.readVector(manager, {
              sessionId: params.sid,
              userId: resolved.userId,
              organisationId: resolved.organisationId,
              workspaceId: resolved.workspaceId,
            }),
          );
          cacheKey = this.authContextCache.buildKey({
            sid: params.sid,
            organisationId: resolved.organisationId,
            workspaceId: resolved.workspaceId,
            versions,
          });
          const cached = await timeStage('security_cache_get', () => this.authContextCache.get(cacheKey!));
          if (cached) {
            cachedSnapshot = {
              accountStatus: cached.accountStatus,
              mustResetPassword: cached.mustResetPassword,
              roles: cached.roles,
              isPlatformAdmin: cached.isPlatformAdmin,
              maintenanceModeEnabled: cached.maintenanceModeEnabled,
              organisationSuspended: cached.organisationSuspended,
              effectivePermissions: new Set(cached.effectivePermissions),
            };
          }
        }

        const security = cachedSnapshot ?? {
          ...(await timeStage('security_roles_permissions', async () => {
            const row = await this.loadSecurityRow(manager, resolved.userId, resolved.organisationId);
            return {
              accountStatus: row.status,
              mustResetPassword: row.must_reset_password,
              roles: row.roles ?? [],
              isPlatformAdmin: row.is_platform_admin,
              maintenanceModeEnabled: row.maintenance_enabled,
              organisationSuspended: row.organisation_suspended,
              effectivePermissions: new Set(row.effective_permissions ?? []),
            };
          })),
        };

        // Reused, unmodified family-liveness/UserSession-revocation/cutover/last_seen logic — same
        // as every other caller of this service — PLUS the idle-timeout privileged override,
        // computed from the roles/isPlatformAdmin just resolved above. Throws UnauthorizedException
        // on failure; propagated as-is, never caught/reinterpreted here.
        await timeStage('security_session', () =>
          this.sessionValidity.assertActive(manager, {
            userId: resolved.userId,
            organisationId: resolved.organisationId,
            sid: params.sid,
            privileged: isPrivilegedIdleClass(security.roles, security.isPlatformAdmin),
          }),
        );

        if (cacheKey && !cachedSnapshot) {
          // Fire-and-forget from the caller's point of view (awaited here only so the write
          // completes before this transaction commits and the manager becomes unusable — `set()`
          // itself never throws and never blocks on a slow/unreachable Redis beyond its own
          // bounded client timeout, see AuthCacheRedisClientProvider).
          await timeStage('security_cache_set', () =>
            this.authContextCache.set(cacheKey!, {
              accountStatus: security.accountStatus,
              mustResetPassword: security.mustResetPassword,
              roles: security.roles,
              isPlatformAdmin: security.isPlatformAdmin,
              maintenanceModeEnabled: security.maintenanceModeEnabled,
              organisationSuspended: security.organisationSuspended,
              effectivePermissions: [...security.effectivePermissions],
            }),
          );
        }

        return {
          userId: resolved.userId,
          organisationId: resolved.organisationId,
          workspaceId: resolved.workspaceId,
          ...security,
        } satisfies AuthSecuritySnapshot;
      }),
    );
  }

  private async resolveMembership(
    manager: EntityManager,
    sid: string,
  ): Promise<{ userId: string; organisationId: string; workspaceId: string | null } | null> {
    // Identical call `WorkspaceResolverService.resolveForSession` already makes — same SECURITY
    // DEFINER function, same pre-auth semantics (no GUCs need to be bound yet; this is what
    // establishes the identity those GUCs will then be bound to). Run here, inside THIS
    // transaction, rather than on a separate unbound connection, so it participates in the same
    // REPEATABLE READ snapshot as everything that follows it.
    const [row] = await manager.query<Array<{ user_id: string; organisation_id: string; workspace_id: string | null }>>(
      'SELECT user_id, organisation_id, workspace_id FROM core.resolve_membership_for_session($1)',
      [sid],
    );
    if (!row) return null;
    return { userId: row.user_id, organisationId: row.organisation_id, workspaceId: row.workspace_id ?? null };
  }

  /**
   * ONE statement for every remaining security input: account status/must-reset (`core."user"`),
   * roles (`core.user_role`/`core.role`), platform-admin (the existing, unmodified
   * `core.is_active_platform_admin` SECURITY DEFINER function), maintenance mode
   * (`core.platform_config`), and effective permissions (`core.user_role` → `core.role_permission`
   * → `core.permission`, overridden by `core.user_permission_override` — the exact same
   * override-then-role precedence `PermissionsService.userHasPermissionTx` already implements,
   * generalised here to every permission key at once instead of one at a time).
   *
   * CTEs purely for readability — this is one SQL statement, not several round trips. Kept as a
   * single query deliberately (P1C §8: "do not create an unreadable giant query simply to reach
   * '1 SQL' — correctness and maintainability outrank an artificial statement-count target"); each
   * named CTE below is independently as simple as the single-purpose query it replaces.
   */
  private async loadSecurityRow(manager: EntityManager, userId: string, organisationId: string): Promise<SecurityRow> {
    const [row] = await manager.query<SecurityRow[]>(
      `WITH user_row AS (
         SELECT status, must_reset_password FROM core."user" WHERE id = $1 LIMIT 1
       ),
       role_keys AS (
         SELECT array_agg(DISTINCT r.key) AS keys
           FROM core.user_role ur
           JOIN core.role r ON r.id = ur.role_id
          WHERE ur.user_id = $1
       ),
       platform_admin AS (
         SELECT core.is_active_platform_admin($1) AS is_admin
       ),
       maintenance AS (
         SELECT maintenance_mode_enabled FROM core.platform_config WHERE organisation_id = $2
       ),
       org_suspension AS (
         SELECT suspended_at FROM core.organisation WHERE id = $2
       ),
       role_perms AS (
         SELECT DISTINCT p.key
           FROM core.user_role ur
           JOIN core.role_permission rp ON rp.role_id = ur.role_id
           JOIN core.permission p ON p.id = rp.permission_id
          WHERE ur.user_id = $1
       ),
       overrides AS (
         SELECT p.key, upo.effect
           FROM core.user_permission_override upo
           JOIN core.permission p ON p.id = upo.permission_id
          WHERE upo.user_id = $1
       ),
       effective AS (
         SELECT array_agg(DISTINCT key) AS keys FROM (
           SELECT key FROM role_perms WHERE key NOT IN (SELECT key FROM overrides WHERE effect = 'revoke')
           UNION
           SELECT key FROM overrides WHERE effect = 'grant'
         ) combined
       )
       SELECT
         (SELECT status FROM user_row) AS status,
         COALESCE((SELECT must_reset_password FROM user_row), false) AS must_reset_password,
         (SELECT keys FROM role_keys) AS roles,
         COALESCE((SELECT is_admin FROM platform_admin), false) AS is_platform_admin,
         COALESCE((SELECT maintenance_mode_enabled FROM maintenance), false) AS maintenance_enabled,
         (SELECT suspended_at FROM org_suspension) IS NOT NULL AS organisation_suspended,
         (SELECT keys FROM effective) AS effective_permissions`,
      [userId, organisationId],
    );
    if (!row || row.status === undefined || row.status === null) {
      // The user row vanished between session resolution and here within the SAME snapshot —
      // structurally shouldn't happen (FK CASCADE would have already torn down the session too),
      // but fail closed rather than return a snapshot with no account status at all.
      throw new UnauthorizedException('Please sign in again.');
    }
    return row;
  }

  /**
   * `REPEATABLE READ`'s documented failure mode: a concurrent, already-committed write to a row
   * this transaction also tries to write (the `last_seen_at` bump, via `assertActive`) raises
   * SQLSTATE 40001. Retried a bounded number of times, same as Postgres's own recommended pattern
   * for this isolation level — never silently swallowed, never retried unboundedly.
   */
  private async withSerializationRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SERIALIZATION_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if ((error as { code?: string })?.code !== '40001') throw error;
      }
    }
    throw lastError;
  }
}
