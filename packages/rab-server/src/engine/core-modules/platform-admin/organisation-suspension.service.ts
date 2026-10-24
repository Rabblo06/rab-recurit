import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Organisation } from '../../../modules/identity/entities';
import { AuditAction, AuditService } from '../audit/audit.service';
import { SecurityVersionService } from '../auth/services/security-version.service';
import { StepUpReauthService } from '../auth/services/step-up-reauth.service';
import { RefreshTokenService } from '../auth/token/services/refresh-token.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import { WorkspaceHostResolverService } from '../workspace-host/workspace-host-resolver.service';
import { PlatformAdminService } from './platform-admin.service';

export interface OrganisationSuspensionStatus {
  organisationId: string;
  suspended: boolean;
  suspendedAt: Date | null;
  suspendedBy: string | null;
  suspendedReason: string | null;
  reactivatedAt: Date | null;
  reactivatedBy: string | null;
}

/**
 * P2.8 — reversible organisation suspension, platform-admin-only, never a hard delete (see the
 * owner's own 12-point spec in docs/HANDOFF.md's P2.8 entry).
 *
 * Tenant-context binding is the one non-obvious part of this service: `core.organisation` carries
 * its own RLS policy (`organisation_self`, `USING/WITH CHECK (id = core.current_org())`) despite
 * having no `organisation_id` column of its own — a session may only read/write the ONE row whose
 * `id` equals whatever `rab.organisation_id` is currently bound to. A platform admin suspending
 * someone else's organisation is NOT that organisation's own member, so every call below binds
 * `organisationId: targetOrganisationId` (the row being acted on), not the actor's own org — the
 * actor's identity/authority is established separately via `PlatformAdminService.isPlatformAdmin`,
 * which is itself unaffected by which org is bound (it reads the global, SECURITY DEFINER
 * `core.is_active_platform_admin()`). This also lets the audit entry for this event land under the
 * TARGET organisation's own audit trail (satisfies `audit_log`'s identical `organisation_id =
 * current_org()` FORCEd policy), which is where "an admin suspended this org" belongs.
 *
 * `security_version` is bumped via the existing `SecurityVersionService.bumpOrganisation` (reused,
 * never reimplemented, per the owner's explicit instruction) as a SEPARATE statement from the
 * suspension-column UPDATE — `core.enforce_organisation_security_version_monotonic()` rejects any
 * single UPDATE that moves `security_version` by anything other than exactly 0 or +1, so two
 * narrow statements (one untouched, one +1) satisfy it trivially where one combined statement
 * would need the same arithmetic spelled out by hand. The version bump changes this organisation's
 * `AuthContextCacheService` cache key (`organisationVersion` is one of the six inputs), so every
 * request after this transaction commits misses cache and re-reads `suspended_at` fresh from
 * Postgres — this IS the "session invalidation" the owner's spec asks this feature to reuse rather
 * than reimplement; see `OrganisationSuspendedGuard`.
 */
@Injectable()
export class OrganisationSuspensionService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly stepUpReauth: StepUpReauthService,
    private readonly securityVersion: SecurityVersionService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly refreshToken: RefreshTokenService,
    private readonly hostResolver: WorkspaceHostResolverService,
  ) {}

  async getStatus(
    actorCtx: Pick<AuthContext, 'userId' | 'organisationId'>,
    targetOrganisationId: string,
  ): Promise<OrganisationSuspensionStatus> {
    await this.assertActorIsPlatformAdmin(actorCtx);
    return this.tenantContext.runInTenantContext(
      { organisationId: targetOrganisationId, workspaceId: null, userId: actorCtx.userId, role: '' },
      (manager) => this.loadStatus(manager, targetOrganisationId),
    );
  }

  /** Idempotent — suspending an already-suspended organisation returns its current status, no second audit entry. */
  async suspend(
    actorCtx: Pick<AuthContext, 'userId' | 'organisationId' | 'sessionId' | 'inspectedBy'>,
    targetOrganisationId: string,
    input: { reason: string; confirmSlug: string; currentPassword: string },
  ): Promise<OrganisationSuspensionStatus> {
    // Step-up reauth runs against the ACTOR's own bound identity (never the target's), same
    // pattern as PlatformAdminService.grant/revoke — verified before the admin-status check so a
    // non-admin caller learns nothing about whether their password was even reached.
    await this.stepUpReauth.assertCurrentPassword(
      // Lane D (M10-2): the session id travels with the actor (recent step-up grant; Admin Inspect refused).
      { organisationId: actorCtx.organisationId, workspaceId: null, userId: actorCtx.userId, sessionId: actorCtx.sessionId, inspectedBy: actorCtx.inspectedBy },
      input.currentPassword,
    );
    await this.assertActorIsPlatformAdmin(actorCtx);

    const status = await this.tenantContext.runInTenantContext(
      { organisationId: targetOrganisationId, workspaceId: null, userId: actorCtx.userId, role: '' },
      async (manager) => {
        const org = await manager.findOne(Organisation, { where: { id: targetOrganisationId } });
        if (!org) throw new NotFoundException('Organisation not found.');

        // Explicit confirmation (owner's requirement 2, on top of step-up reauth): the caller must
        // echo the target's own slug, verified against the real row — never a bare boolean the UI
        // could send without the admin ever having seen which organisation this is.
        if (org.slug !== input.confirmSlug) {
          throw new ForbiddenException("Confirmation text did not match this organisation's slug.");
        }

        // CAS on `suspended_at IS NULL`, not a separate read-then-write — two concurrent suspend
        // calls for the same organisation both pass the `org.suspendedAt` read above (neither has
        // committed yet under READ COMMITTED); only the atomic UPDATE's WHERE clause, re-evaluated
        // against the row lock, correctly lets exactly one of them proceed. Same CAS idiom
        // `RefreshTokenService.revokeFamily`/`revokeAllForUser` already use. `manager.query` for an
        // UPDATE returns a `[rows, rowCount]` tuple, not a bare rows array (the documented gotcha
        // repeated elsewhere in this codebase).
        const [, rowCount] = await manager.query<[unknown[], number]>(
          `UPDATE core.organisation SET suspended_at = now(), suspended_by = $2, suspended_reason = $3 WHERE id = $1 AND suspended_at IS NULL`,
          [targetOrganisationId, actorCtx.userId, input.reason],
        );
        if (rowCount === 0) {
          return this.loadStatus(manager, targetOrganisationId);
        }
        await this.securityVersion.bumpOrganisation(manager, targetOrganisationId);
        await this.refreshToken.revokeAllForOrganisation(manager, targetOrganisationId, 'organisation_suspended');

        await this.auditService.record(
          manager,
          { organisationId: targetOrganisationId, userId: actorCtx.userId, inspectedBy: undefined },
          AuditAction.ORGANISATION_SUSPENDED,
          { entityType: 'organisation', entityId: targetOrganisationId, metadata: { reason: input.reason } },
        );

        return this.loadStatus(manager, targetOrganisationId);
      },
    );
    // Wave 3 lane H (C13): a suspended organisation's workspace hosts stop routing (the resolver excludes suspended
    // organisations); drop every cached host label after the commit. Best-effort, never throws.
    await this.hostResolver.invalidateAll();
    return status;
  }

  /** Idempotent — reactivating an already-active organisation returns its current status, no second audit entry. Does NOT restore any session revoked while suspended (owner's requirement 8) — only lifts the login/API/refresh block. */
  async reactivate(
    actorCtx: Pick<AuthContext, 'userId' | 'organisationId' | 'sessionId' | 'inspectedBy'>,
    targetOrganisationId: string,
    input: { currentPassword: string },
  ): Promise<OrganisationSuspensionStatus> {
    await this.stepUpReauth.assertCurrentPassword(
      // Lane D (M10-2): the session id travels with the actor (recent step-up grant; Admin Inspect refused).
      { organisationId: actorCtx.organisationId, workspaceId: null, userId: actorCtx.userId, sessionId: actorCtx.sessionId, inspectedBy: actorCtx.inspectedBy },
      input.currentPassword,
    );
    await this.assertActorIsPlatformAdmin(actorCtx);

    const status = await this.tenantContext.runInTenantContext(
      { organisationId: targetOrganisationId, workspaceId: null, userId: actorCtx.userId, role: '' },
      async (manager) => {
        const org = await manager.findOne(Organisation, { where: { id: targetOrganisationId } });
        if (!org) throw new NotFoundException('Organisation not found.');

        // Same CAS idiom as `suspend()` above — see its comment.
        const [, rowCount] = await manager.query<[unknown[], number]>(
          `UPDATE core.organisation
              SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL, reactivated_at = now(), reactivated_by = $2
            WHERE id = $1 AND suspended_at IS NOT NULL`,
          [targetOrganisationId, actorCtx.userId],
        );
        if (rowCount === 0) {
          return this.loadStatus(manager, targetOrganisationId);
        }
        await this.securityVersion.bumpOrganisation(manager, targetOrganisationId);

        await this.auditService.record(
          manager,
          { organisationId: targetOrganisationId, userId: actorCtx.userId, inspectedBy: undefined },
          AuditAction.ORGANISATION_REACTIVATED,
          { entityType: 'organisation', entityId: targetOrganisationId },
        );

        return this.loadStatus(manager, targetOrganisationId);
      },
    );
    await this.hostResolver.invalidateAll();
    return status;
  }

  private async loadStatus(manager: EntityManager, organisationId: string): Promise<OrganisationSuspensionStatus> {
    const org = await manager.findOneOrFail(Organisation, { where: { id: organisationId } });
    return {
      organisationId: org.id,
      suspended: org.suspendedAt != null,
      suspendedAt: org.suspendedAt ?? null,
      suspendedBy: org.suspendedBy ?? null,
      suspendedReason: org.suspendedReason ?? null,
      reactivatedAt: org.reactivatedAt ?? null,
      reactivatedBy: org.reactivatedBy ?? null,
    };
  }

  private async assertActorIsPlatformAdmin(actorCtx: Pick<AuthContext, 'userId'>): Promise<void> {
    if (!(await this.platformAdmin.isPlatformAdmin(actorCtx))) {
      throw new ForbiddenException('Only a platform administrator can manage organisation suspension.');
    }
  }
}
