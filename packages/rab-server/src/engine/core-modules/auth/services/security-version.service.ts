import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Organisation } from '../../../../modules/identity/entities/organisation.entity';
import { PlatformAdmin } from '../../../../modules/identity/entities/platform-admin.entity';
import { Role } from '../../../../modules/identity/entities/role.entity';
import { User } from '../../../../modules/identity/entities/user.entity';

/**
 * P1D — the authoritative security-version bump/read primitives. See
 * `SecurityVersionVectors1786683000000`'s own doc comment for the full six-domain design
 * (session, user, role-permission, workspace-membership, platform-admin, organisation).
 *
 * Every bump method here must be called from WITHIN the same transaction as the mutation it
 * accompanies — a separate post-commit bump is not equivalent and is never correct (a crash or
 * rollback between the two would let a stale version survive a real authority change). Every
 * caller already runs inside `TenantContextService.runInTenantContext`/`runInWorkspaceContext`,
 * so the `EntityManager` passed in here is always that same open transaction's manager.
 *
 * `workspace_membership`'s own version bump lives inside `suspend_workspace_membership`/
 * `reinstate_workspace_membership` themselves (both SECURITY DEFINER, both the sole mutation path
 * for that transition already) — not duplicated here, since there is no TypeScript call site that
 * mutates that table's status directly.
 */
@Injectable()
export class SecurityVersionService {
  /** Bump after any mutation to this user's OWN account authority (password set/changed/reset, status change). */
  async bumpUser(manager: EntityManager, userId: string): Promise<void> {
    await manager.increment(User, { id: userId }, 'securityVersion', 1);
  }

  /** Bump after `core.role_permission` changes for this role — once per role, never fanned out to its holders. */
  async bumpRole(manager: EntityManager, roleId: string): Promise<void> {
    await manager.increment(Role, { id: roleId }, 'permissionVersion', 1);
  }

  /** Bump after an organisation-level security-configuration change (auth-provider toggles, maintenance mode). */
  async bumpOrganisation(manager: EntityManager, organisationId: string): Promise<void> {
    await manager.increment(Organisation, { id: organisationId }, 'securityVersion', 1);
  }

  /** Bump after a platform-admin grant/revoke. Called from all three real write paths (service + two CLIs). */
  async bumpPlatformAdmin(manager: EntityManager, userId: string): Promise<void> {
    await manager.increment(PlatformAdmin, { userId }, 'securityVersion', 1);
  }

  /**
   * The cheap, version-only read a future cache consumer (P1E) checks a cached decision against —
   * ONE statement, no business data, nothing cacheable itself. Must run under the caller's own
   * bound tenant context (RLS applies to every table read here exactly as it does everywhere
   * else; this performs no bypass).
   *
   * `rolePermissionVersion` is `0` when the user holds no role (never `null` — a plain number the
   * caller can compare with `!==` without a null check) and otherwise the SUM of `permission
   * _version` across every role currently held — NOT `MAX`. A real bug in an earlier version of
   * this method used MAX and was wrong: for a user holding two roles at versions (10, 1), a real
   * edit to the SECOND role bumping it 1 -> 2 leaves `MAX(10, 2) = 10` unchanged, silently hiding
   * a genuine permission-definition change behind a role this same user ALSO happens to hold.
   * `SUM` does not have this blind spot: because `SecurityVersionMonotonicGuard1786684000000`'s
   * own trigger guarantees every `permission_version` only ever moves by exactly +1 (never
   * decreases), the sum over a FIXED set of held roles is strictly monotonic — any single term
   * increasing strictly increases the total, with no way for a concurrent decrease elsewhere to
   * cancel it out, because there are no decreases. Gaining/losing a role (changing the SET being
   * summed) is a separate dimension, covered by `userVersion` (bumped wherever `core.user_role`
   * changes — see this service's own callers), not by this field.
   *
   * `workspaceMembershipVersion` is `null` when `workspaceId` is `null` (no resolved workspace for
   * this session) or no membership row exists for that exact (user, workspace) pair — a `null`
   * here is meaningful (there is no membership authority to compare against), never coerced to 0.
   *
   * `platformAdminVersion` is `0` when the user has never been granted platform-admin at all (no
   * row exists) — distinct from a real version number, same reasoning as `rolePermissionVersion`.
   */
  async readVector(
    manager: EntityManager,
    params: { sessionId: string; userId: string; organisationId: string; workspaceId: string | null },
  ): Promise<SecurityVersionVector> {
    const [row] = await manager.query<
      Array<{
        session_version: string | null;
        user_version: string | null;
        role_permission_version: string;
        workspace_membership_version: string | null;
        platform_admin_version: string;
        organisation_version: string | null;
      }>
    >(
      `SELECT
         (SELECT security_version FROM core.user_session WHERE id = $1) AS session_version,
         (SELECT security_version FROM core."user" WHERE id = $2) AS user_version,
         COALESCE(
           (SELECT SUM(r.permission_version) FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = $2),
           0
         ) AS role_permission_version,
         (SELECT security_version FROM core.workspace_membership WHERE user_id = $2 AND workspace_id = $4) AS workspace_membership_version,
         COALESCE((SELECT security_version FROM core.platform_admin WHERE user_id = $2), 0) AS platform_admin_version,
         (SELECT security_version FROM core.organisation WHERE id = $3) AS organisation_version`,
      [params.sessionId, params.userId, params.organisationId, params.workspaceId],
    );
    return {
      sessionVersion: row?.session_version !== null && row?.session_version !== undefined ? Number(row.session_version) : null,
      userVersion: row?.user_version !== null && row?.user_version !== undefined ? Number(row.user_version) : null,
      rolePermissionVersion: Number(row?.role_permission_version ?? 0),
      workspaceMembershipVersion:
        row?.workspace_membership_version !== null && row?.workspace_membership_version !== undefined
          ? Number(row.workspace_membership_version)
          : null,
      platformAdminVersion: Number(row?.platform_admin_version ?? 0),
      organisationVersion: row?.organisation_version !== null && row?.organisation_version !== undefined ? Number(row.organisation_version) : null,
    };
  }
}

/**
 * A `null` field means "no such row" (unknown session, deleted user, no resolved workspace
 * membership, no organisation row) — a future cache consumer must treat that as "cannot validate,
 * fail closed," never coerce it to a comparable number.
 */
export interface SecurityVersionVector {
  sessionVersion: number | null;
  userVersion: number | null;
  rolePermissionVersion: number;
  workspaceMembershipVersion: number | null;
  platformAdminVersion: number;
  organisationVersion: number | null;
}
