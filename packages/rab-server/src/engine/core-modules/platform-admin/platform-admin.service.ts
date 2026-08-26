import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';

/**
 * The "first legitimate owner" mechanism (rab-workforce-architecture.md,
 * CLAUDE.md). Deliberately NOT a `PermissionFlag` — if platform-admin were
 * grantable through the ordinary role/permission-override system, any user
 * holding `user.manage_permissions` could self-grant it via the existing
 * `user_permission_override` endpoint, defeating the entire point of a
 * protected, non-reassignable single owner. This is checked only against
 * `platform_admin_claim`, whose primary key IS `organisation_id` — that's
 * what makes `tryClaim` race-safe (Postgres's own conflict resolution
 * decides the single winner, never an application-level count/id check)
 * and non-repromotable (a revoked claim's row is never deleted, so the PK
 * permanently blocks any later claim for that organisation).
 */
@Injectable()
export class PlatformAdminService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Called inside the same transaction as every user-creation path
   * (SeedCommand, StaffService.create, ManagerService.create) — safe and
   * correct by construction regardless of which code path gets there
   * first, and safe to call unconditionally (a no-op once an org already
   * has an owner). Returns whether this call was the one that won the claim.
   */
  async tryClaim(manager: EntityManager, organisationId: string, userId: string): Promise<boolean> {
    // Confirmed empirically: TypeORM's `manager.query()` returns the rows
    // array directly for INSERT ... RETURNING (unlike UPDATE/DELETE, which
    // return a `[rows, rowCount]` tuple instead — see `AdminInspectService`
    // and `offer.service.ts` for that variant).
    const result = await manager.query<Array<{ organisation_id: string }>>(
      `INSERT INTO core.platform_admin_claim (organisation_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (organisation_id) DO NOTHING
       RETURNING organisation_id`,
      [organisationId, userId],
    );
    return result.length > 0;
  }

  async isPlatformAdmin(ctx: AuthContext): Promise<boolean> {
    if (!ctx.organisationId) return false;
    return this.tenantContext.runInTenantContext(ctx, (manager) => this.isPlatformAdminTx(manager, ctx));
  }

  /**
   * Same check, for a caller that already has an open transaction's
   * `manager` from its own `runInTenantContext` block — avoids opening a
   * second, independent transaction just to answer "is this actor the
   * platform admin?" mid-request (used by the owner-or-admin resource
   * checks in StaffService/OfferService/SchedulingService).
   */
  async isPlatformAdminTx(manager: EntityManager, ctx: Pick<AuthContext, 'organisationId' | 'userId'>): Promise<boolean> {
    if (!ctx.organisationId) return false;
    const row = await manager.query<Array<{ user_id: string }>>(
      `SELECT user_id FROM core.platform_admin_claim
        WHERE organisation_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [ctx.organisationId, ctx.userId],
    );
    return row.length > 0;
  }
}
