import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { AdminInspectSession, User } from '../../../modules/identity/entities';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';

export interface ActiveInspectTarget {
  targetUserId: string;
}

/**
 * Server-side state machine for "Admin Inspect" — never a JWT claim (see
 * `AdminInspectSession`'s own docstring for why). `start`/`end` always run
 * against the CALLING admin's own real, already-verified `ctx` — the admin's
 * true identity is never derived from anything client-supplied. `start`
 * takes a `targetUserId` path param, but that's just "who to look at" — it
 * never grants access on its own; every subsequent read still runs through
 * the ordinary guard → service → RLS chain, scoped to the target's identity,
 * exactly as if the target had made the request themselves (read-only,
 * enforced separately by `PermissionGuard`).
 */
@Injectable()
export class AdminInspectService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
  ) {}

  async start(ctx: AuthContext, targetUserId: string): Promise<{ sessionId: string }> {
    if (targetUserId === ctx.userId) {
      throw new BadRequestException('Cannot inspect your own account');
    }

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const target = await manager.findOne(User, { where: { id: targetUserId, organisationId: ctx.organisationId! } });
      if (!target) throw new NotFoundException('User not found');

      // Never stack sessions — a second `start` implicitly ends any prior
      // live session for this admin first, so exactly one target is ever
      // "live" for a given admin at a time.
      await manager.query(
        `UPDATE core.admin_inspect_session SET ended_at = now()
          WHERE admin_user_id = $1 AND legacy_organisation_id = $2 AND ended_at IS NULL`,
        [ctx.userId, ctx.organisationId],
      );

      const inserted = await manager.insert(AdminInspectSession, {
        legacyOrganisationId: ctx.organisationId!,
        adminUserId: ctx.userId,
        targetUserId,
      });
      const sessionId = inserted.identifiers[0]!.id as string;

      await this.auditService.record(manager, ctx, AuditAction.ADMIN_INSPECT_STARTED, {
        targetUserId,
        metadata: { inspectedTargetUserId: targetUserId },
      });

      return { sessionId };
    });
  }

  async end(ctx: AuthContext): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // A plain SELECT-then-UPDATE, deliberately not `UPDATE ... RETURNING`
      // — TypeORM's raw `manager.query()` returns a `[rows, rowCount]` tuple
      // for UPDATE/DELETE (unlike a bare SELECT, which returns `rows`
      // directly), so `result[0]` there is the rows array, not a row.
      const rows = await manager.query<Array<{ id: string; target_user_id: string }>>(
        `SELECT id, target_user_id FROM core.admin_inspect_session
          WHERE admin_user_id = $1 AND legacy_organisation_id = $2 AND ended_at IS NULL`,
        [ctx.userId, ctx.organisationId],
      );
      if (rows.length === 0) return;
      const { id, target_user_id: targetUserId } = rows[0]!;

      await manager.query(`UPDATE core.admin_inspect_session SET ended_at = now() WHERE id = $1`, [id]);

      await this.auditService.record(manager, ctx, AuditAction.ADMIN_INSPECT_ENDED, {
        targetUserId,
        metadata: { inspectedTargetUserId: targetUserId },
      });
    });
  }

  /**
   * Called by `JwtAuthGuard` on every request carrying an `X-Inspect-Session-Id`
   * header. `adminCtx` is the admin's own token identity, already verified —
   * the header is only ever a lookup key into a session row that must also
   * belong to this exact admin. A forged, foreign (another admin's), or
   * already-ended session id all resolve to `null` here, indistinguishable
   * from "no header sent" to the caller — fail-closed to the admin's own
   * real identity, never an error.
   */
  async resolveActiveTarget(
    adminCtx: Pick<AuthContext, 'organisationId' | 'userId' | 'workspaceId'>,
    sessionId: string,
  ): Promise<ActiveInspectTarget | null> {
    if (!adminCtx.organisationId) return null;
    const rows = await this.tenantContext.runInTenantContext(
      { organisationId: adminCtx.organisationId, workspaceId: adminCtx.workspaceId, userId: adminCtx.userId, role: '' },
      (manager) =>
        manager.query<Array<{ target_user_id: string }>>(
          `SELECT target_user_id FROM core.admin_inspect_session
            WHERE id = $1 AND admin_user_id = $2 AND legacy_organisation_id = $3 AND ended_at IS NULL`,
          [sessionId, adminCtx.userId, adminCtx.organisationId],
        ),
    );
    if (rows.length === 0) return null;
    return { targetUserId: rows[0]!.target_user_id };
  }
}
