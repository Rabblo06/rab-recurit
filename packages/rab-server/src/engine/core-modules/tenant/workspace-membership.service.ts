import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuthContext } from './auth-context.interface';

/**
 * Write paths for core.workspace_membership (USER → WORKSPACE). Every method takes the transactional EntityManager
 * of a tenant-context transaction, so the RLS insert predicate (organisation_id and workspace_id = the bound
 * context) is enforced by the database as well as by these callers.
 *
 * The workspace is always the SERVER-DERIVED one: ctx.workspaceId for staff and venue-manager creation, the
 * manager's own new workspace for workspace creation. No method accepts a workspace id from a request body.
 * An existing ACTIVE membership in a different workspace makes the INSERT fail on the one-active-per-user index,
 * which is the intended fail-closed behaviour.
 */
@Injectable()
export class WorkspaceMembershipService {
  /**
   * Adds `userId` to the caller's bound operational workspace. No workspace bound → no membership, which is the
   * same as the old resolver for a user without a workspace. A duplicate (user, workspace) raises: a write path that
   * creates membership is only ever for a NEW user, so a conflict is a bug and must fail closed. No ON CONFLICT here:
   * under FORCE RLS the conflict check would apply the SELECT policy to the new row and reject it.
   */
  async assignToWorkspace(manager: EntityManager, ctx: AuthContext, userId: string): Promise<void> {
    if (!ctx.workspaceId) return;
    await manager.query(
      `INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source)
       VALUES ($1, $2, $3, 'active', 'write_path')`,
      [ctx.organisationId, userId, ctx.workspaceId],
    );
  }

  /**
   * A Manager creating their OWN workspace. The request context has no workspace yet, so the new workspace id is
   * bound transaction-locally for the one INSERT, and the caller's previous value is restored before returning.
   */
  async assignOwnWorkspace(manager: EntityManager, ctx: AuthContext, workspaceId: string): Promise<void> {
    const [{ prev }] = await manager.query<Array<{ prev: string | null }>>(
      `SELECT NULLIF(current_setting('rab.workspace_id', true), '') AS prev`,
    );
    await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);
    // On failure the whole transaction is rolled back, including this set_config, so no restore is needed (and an
    // aborted transaction could not run one anyway). On success the caller's previous value is restored at once.
    await manager.query(
      `INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source)
       VALUES ($1, $2, $3, 'active', 'write_path')`,
      [ctx.organisationId, ctx.userId, workspaceId],
    );
    await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [prev ?? '']);
  }

  /** Suspended account (ActiveAccountGuard blocks it too). Reversible with reinstateForUser. */
  async suspendForUser(manager: EntityManager, userId: string): Promise<void> {
    await manager.query(`SELECT core.suspend_workspace_membership($1)`, [userId]);
  }

  /** Reactivated account. Only restores a membership that was suspended, never creates one. */
  async reinstateForUser(manager: EntityManager, userId: string): Promise<void> {
    await manager.query(`SELECT core.reinstate_workspace_membership($1)`, [userId]);
  }
}
