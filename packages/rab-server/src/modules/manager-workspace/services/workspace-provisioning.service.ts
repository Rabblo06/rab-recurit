import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { CoreEntityCacheService } from '../../../engine/core-modules/entity-cache/core-entity-cache.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceHostResolverService } from '../../../engine/core-modules/workspace-host/workspace-host-resolver.service';
import { ManagerWorkspace } from '../entities/manager-workspace.entity';

/**
 * - `READY`: this call built, verified and marked the schema READY (exactly once per workspace).
 * - `ALREADY_READY`: another call (a duplicate click, a second API replica, an earlier attempt) already did.
 * - `FAILED`: the attempt rolled back completely and FAILED was recorded; a later identical create() retries it.
 * - `DEFERRED`: the call could not complete (connection lost, statement/lock timeout, function unavailable after a
 *   rollback of 1786719500000). Its transaction rolled back, so the committed lifecycle (CREATING or FAILED) is
 *   unchanged and retryable. Never an error to the client: the workspace exists and reports its real state.
 */
export type WorkspaceProvisioningOutcome = 'READY' | 'ALREADY_READY' | 'FAILED' | 'DEFERRED';

const PG_NOT_FOUND = 'P0002';
const PG_OBJECT_NOT_IN_PREREQUISITE_STATE = '55000';

function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; driverError?: { code?: string } } | undefined;
  return e?.driverError?.code ?? e?.code;
}

/**
 * Server-path workspace provisioning (Twenty-style: the API creates the workspace schema in the request that activates
 * it). Runs on the API's ORDINARY restricted connection (`crewflow_app`) — there is no second, privileged connection and
 * no provisioning credential anywhere in the API environment. The DDL itself happens inside the narrow SECURITY DEFINER
 * function `core.provision_workspace(uuid)` (migration 1786719500000), which accepts only a workspace id and applies the
 * fixed, migration-frozen V1 template.
 *
 * Enforcement layers for this operation (CLAUDE.md):
 *   1. guard — only reachable from `ManagerWorkspaceService.create()` (JwtAuthGuard + @ManagerApplication on the route);
 *      there is no separate "run provisioning" endpoint.
 *   2. service — here: the workspace must be the caller's own (`owner_user_id = ctx.userId`) in the caller's
 *      organisation, and its lifecycle must be CREATING/FAILED (READY short-circuits).
 *   3. org-scoped query — the ownership read binds `organisationId` from the verified session (`runInTenantContext`).
 *   4. RLS — the function reads `manager_workspace` AS `crewflow` under its RLS (own workspace only) and FORCE RLS binds
 *      the registry.
 *   5. the function's own predicate — the bound organisation and user GUCs must equal the workspace's organisation and
 *      owner; a foreign or unknown id is "not found" (404, never 403).
 * The workspace id is always server-derived (the row create() just wrote or found for this owner), never a client value.
 */
@Injectable()
export class WorkspaceProvisioningService {
  private readonly logger = new Logger(WorkspaceProvisioningService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly entityCache: CoreEntityCacheService,
    private readonly hostResolver?: WorkspaceHostResolverService,
  ) {}

  async provisionOwnWorkspace(ctx: AuthContext, workspaceId: string): Promise<WorkspaceProvisioningOutcome> {
    if (!ctx.organisationId) throw new NotFoundException('Workspace not found.');
    // Provisioning is a core-only operation: never route it through the (not yet READY) workspace schema, which
    // HWS_RUNTIME_ENABLED=true would refuse for a CREATING workspace.
    const provisioningCtx: AuthContext = { ...ctx, workspaceId: null };

    let outcome: WorkspaceProvisioningOutcome;
    let subdomain: string | null = null;
    try {
      outcome = await this.tenantContext.runInTenantContext(provisioningCtx, async (manager) => {
        const workspace = await manager.findOne(ManagerWorkspace, {
          where: { id: workspaceId, ownerUserId: ctx.userId, organisationId: ctx.organisationId! },
        });
        if (!workspace) throw new NotFoundException('Workspace not found.');
        subdomain = workspace.subdomain;
        if (workspace.schemaStatus === 'READY') return 'ALREADY_READY';
        if (workspace.schemaStatus !== 'CREATING' && workspace.schemaStatus !== 'FAILED') {
          throw new ConflictException({ code: 'WORKSPACE_NOT_PROVISIONABLE', message: 'This workspace cannot be prepared from here.' });
        }

        const [row] = await manager.query<Array<{ outcome: 'READY' | 'ALREADY_READY' | 'FAILED' }>>(
          'SELECT core.provision_workspace($1) AS outcome',
          [workspaceId],
        );
        const result = row!.outcome;
        if (result === 'READY') {
          await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_PROVISIONED, {
            entityType: 'manager_workspace',
            entityId: workspaceId,
            metadata: { schemaVersion: 1, path: 'server' },
          });
        } else if (result === 'FAILED') {
          const [after] = await manager.query<Array<{ schema_last_error: string | null }>>(
            'SELECT schema_last_error FROM core.manager_workspace WHERE id = $1',
            [workspaceId],
          );
          await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_PROVISIONING_FAILED, {
            entityType: 'manager_workspace',
            entityId: workspaceId,
            // A fixed label or a SQLSTATE written by the function — never a driver message.
            metadata: { safeError: after?.schema_last_error ?? null, path: 'server' },
          });
        }
        return result;
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const code = sqlState(error);
      if (code === PG_NOT_FOUND) throw new NotFoundException('Workspace not found.');
      if (code === PG_OBJECT_NOT_IN_PREREQUISITE_STATE) {
        throw new ConflictException({ code: 'WORKSPACE_NOT_PROVISIONABLE', message: 'This workspace cannot be prepared from here.' });
      }
      // Infrastructure, not a business outcome: the transaction rolled back, nothing partial is left behind.
      this.logger.warn(`workspace provisioning deferred (workspace ${workspaceId}, SQLSTATE ${code ?? 'none'})`);
      outcome = 'DEFERRED';
    }

    // The lifecycle columns changed outside any cached read; best-effort, never throws, works without Redis.
    if (outcome === 'READY' || outcome === 'FAILED') {
      await this.entityCache.invalidate('manager_workspace', workspaceId);
      await this.entityCache.invalidate('manager_workspace_by_owner', ctx.userId);
      // Wave 3 lane H (C13): the label just became routable (READY) or stayed unroutable (FAILED) - drop its (possibly
      // negative) cached host answer so the workspace host resolves at once.
      await this.hostResolver?.invalidateLabels(subdomain);
    }
    return outcome;
  }
}
