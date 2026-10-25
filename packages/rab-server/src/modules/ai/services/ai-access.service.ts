import { AiUnavailableReason, AiUnavailableReasonType, PermissionFlag, PermissionFlagType, UserStatus } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { SessionValidityService } from '../../../engine/core-modules/auth/services/session-validity.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiAccessRevokedError, AiNotAvailableException } from '../exceptions/ai.exceptions';
import { AiConfigService } from './ai-config.service';

export type AiAvailability = { available: true } | { available: false; reason: AiUnavailableReasonType };

/** Flags an AI tool may require (each tool declares one). */
export const AI_TOOL_PERMISSION_FLAGS: readonly PermissionFlagType[] = [PermissionFlag.SCHEDULE_VIEW, PermissionFlag.ATTENDANCE_VIEW, PermissionFlag.PAYROLL_VIEW, PermissionFlag.VENUE_VIEW];

/**
 * The caller's AI authority as the Worker REBUILT it from PostgreSQL — never from job data, a JWT or a cache. `permissions`
 * holds only the tool flags the user holds right now; `timezone` is the organisation's (date ranges are local days).
 */
export interface AiActor {
  organisationId: string;
  workspaceId: string;
  userId: string;
  sessionId: string;
  timezone: string;
  permissions: ReadonlySet<PermissionFlagType>;
}

/** The tenant context every AI query binds (never platform/owner context). */
export function aiTenantContext(actor: Pick<AiActor, 'organisationId' | 'workspaceId' | 'userId' | 'sessionId'>): AuthContext {
  return { organisationId: actor.organisationId, workspaceId: actor.workspaceId, userId: actor.userId, role: '', sessionId: actor.sessionId };
}

/**
 * Two-level enablement + AI_USE + eligibility, in ONE place, re-run at every point the owner listed (docs/ai/PHASE1_PLAN.md
 * §4): opening/listing/reading (request guard + service), submit, before enqueue, Worker start (`rebuildForWorker`),
 * before each tool is offered (the actor's permission set), immediately before each tool runs (`assertStillAllowed`) and
 * while streaming (SSE re-validation).
 *
 * AI is available to a request only when ALL hold:
 *   1. the platform kill switch AI_ENABLED is on;
 *   2. the request is not an Admin Inspect session (an inspecting administrator never reads another user's transcripts);
 *   3. the user holds `ai.use` (resolved server-side per request — the security snapshot, never the JWT);
 *   4. the user is the organisation's CEO or its CURRENT Initial Manager (`core.ai_actor_eligible()`, the same predicate
 *      the RLS WITH CHECK enforces on every AI insert);
 *   5. the session has a workspace (AI is single-workspace: conversations and every tool read are bound to it);
 *   6. the organisation's AI switch (`core.organisation_ai_setting`, default OFF) is on.
 * Account status, organisation suspension, maintenance and the manager_web application target are enforced for every
 * request by JwtAuthGuard / @ManagerApplication before this runs; the Worker re-checks them itself.
 */
@Injectable()
export class AiAccessService {
  constructor(
    private readonly config: AiConfigService,
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly sessionValidity: SessionValidityService,
    private readonly dataSource: DataSource,
  ) {}

  /** Request-time evaluation (the `GET /ai/availability` answer and the basis of every route's uniform 404). */
  async evaluate(ctx: AuthContext): Promise<AiAvailability> {
    if (!this.config.enabled) return { available: false, reason: AiUnavailableReason.PLATFORM_DISABLED };
    if (ctx.inspectedBy) return { available: false, reason: AiUnavailableReason.NOT_PERMITTED };
    if (!ctx.organisationId || !ctx.security?.effectivePermissions.has(PermissionFlag.AI_USE)) {
      return { available: false, reason: AiUnavailableReason.NOT_PERMITTED };
    }
    if (!ctx.workspaceId) return { available: false, reason: AiUnavailableReason.NO_WORKSPACE };
    const facts = await this.tenantContext.runInTenantContext({ ...ctx, role: '' }, (m) => this.readFacts(m, ctx.organisationId!));
    if (!facts.eligible) return { available: false, reason: AiUnavailableReason.NOT_PERMITTED };
    if (!facts.organisationEnabled) return { available: false, reason: AiUnavailableReason.ORGANISATION_DISABLED };
    return { available: true };
  }

  /** Layer 2 for every AI service entry point: anything short of "available" is the uniform 404. */
  async assertAvailable(ctx: AuthContext): Promise<void> {
    if (!(await this.evaluate(ctx)).available) throw new AiNotAvailableException();
  }

  /**
   * Same checks inside an already-open, tenant-bound transaction (submit path: the check and the inserts share one
   * snapshot). `ai.use` is re-read from the database here, not from the request snapshot.
   */
  async assertAvailableTx(m: EntityManager, ctx: AuthContext): Promise<void> {
    if (!this.config.enabled || ctx.inspectedBy || !ctx.organisationId || !ctx.workspaceId) throw new AiNotAvailableException();
    if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_USE))) throw new AiNotAvailableException();
    const facts = await this.readFacts(m, ctx.organisationId);
    if (!facts.eligible || !facts.organisationEnabled) throw new AiNotAvailableException();
  }

  /**
   * Worker start: rebuild the actor from PostgreSQL only. The job's ids are LOOKUP INPUTS: the session must still be live
   * (read-only check — a background turn never extends an idle session), resolve to the SAME user, organisation and
   * workspace, the account must be active, the organisation not suspended and not in maintenance, and every AI gate must
   * still hold. Anything else throws AiAccessRevokedError (the turn stops; nothing is sent to the model).
   */
  async rebuildForWorker(input: { organisationId: string; workspaceId: string; userId: string; sessionId: string }): Promise<AiActor> {
    if (!this.config.enabled) throw new AiAccessRevokedError('platform_disabled');
    return this.dataSource.transaction('REPEATABLE READ', async (m) => {
      const [membership] = await m.query<Array<{ user_id: string; organisation_id: string; workspace_id: string | null }>>(
        'SELECT user_id, organisation_id, workspace_id FROM core.resolve_membership_for_session($1)',
        [input.sessionId],
      );
      if (!membership || membership.user_id !== input.userId || membership.organisation_id !== input.organisationId) throw new AiAccessRevokedError('session');
      if (membership.workspace_id !== input.workspaceId) throw new AiAccessRevokedError('workspace');
      const ctx = aiTenantContext(input);
      await this.tenantContext.bindCoreIdentityGucs(m, ctx);
      try {
        await this.sessionValidity.assertActiveReadOnly(m, { sid: input.sessionId, userId: input.userId, organisationId: input.organisationId });
      } catch {
        throw new AiAccessRevokedError('session');
      }
      const timezone = await this.assertAccountAndOrganisation(m, input.userId, input.organisationId);
      if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_USE))) throw new AiAccessRevokedError('permission');
      const facts = await this.readFacts(m, input.organisationId);
      if (!facts.eligible) throw new AiAccessRevokedError('eligibility');
      if (!facts.organisationEnabled) throw new AiAccessRevokedError('organisation_disabled');
      const permissions = new Set<PermissionFlagType>();
      for (const flag of AI_TOOL_PERMISSION_FLAGS) if (await this.permissions.userHasPermissionTx(m, ctx, flag)) permissions.add(flag);
      return { ...input, timezone, permissions };
    });
  }

  /**
   * Immediately before a tool runs (and periodically while a turn or stream is open): the session, account,
   * organisation, every AI gate and — when given — the tool's own permission, re-read in a fresh short transaction.
   */
  async assertStillAllowed(actor: Pick<AiActor, 'organisationId' | 'workspaceId' | 'userId' | 'sessionId'>, flag?: PermissionFlagType): Promise<void> {
    if (!this.config.enabled) throw new AiAccessRevokedError('platform_disabled');
    const ctx = aiTenantContext(actor);
    await this.tenantContext.runInTenantContext(ctx, async (m) => {
      try {
        await this.sessionValidity.assertActiveReadOnly(m, { sid: actor.sessionId, userId: actor.userId, organisationId: actor.organisationId });
      } catch {
        throw new AiAccessRevokedError('session');
      }
      await this.assertAccountAndOrganisation(m, actor.userId, actor.organisationId);
      if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_USE))) throw new AiAccessRevokedError('permission');
      if (flag && !(await this.permissions.userHasPermissionTx(m, ctx, flag))) throw new AiAccessRevokedError('tool_permission');
      const facts = await this.readFacts(m, actor.organisationId);
      if (!facts.eligible) throw new AiAccessRevokedError('eligibility');
      if (!facts.organisationEnabled) throw new AiAccessRevokedError('organisation_disabled');
    });
  }

  /** Eligibility (CEO / current Initial Manager) and the organisation switch, under the bound tenant context. */
  private async readFacts(m: EntityManager, organisationId: string): Promise<{ eligible: boolean; organisationEnabled: boolean }> {
    const [row] = await m.query<Array<{ eligible: boolean; enabled: boolean | null }>>(
      `SELECT core.ai_actor_eligible() AS eligible,
              (SELECT s.enabled FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS enabled`,
      [organisationId],
    );
    return { eligible: row?.eligible === true, organisationEnabled: row?.enabled === true };
  }

  /** Active account, organisation not suspended, platform not in maintenance. Returns the organisation's timezone. */
  private async assertAccountAndOrganisation(m: EntityManager, userId: string, organisationId: string): Promise<string> {
    const [row] = await m.query<Array<{ status: string | null; suspended: boolean | null; maintenance: boolean | null; timezone: string | null }>>(
      `SELECT (SELECT u.status FROM core."user" u WHERE u.id = $1) AS status,
              (SELECT o.suspended_at IS NOT NULL FROM core.organisation o WHERE o.id = $2) AS suspended,
              (SELECT o.timezone FROM core.organisation o WHERE o.id = $2) AS timezone,
              (SELECT pc.maintenance_mode_enabled FROM core.platform_config pc WHERE pc.organisation_id = $2) AS maintenance`,
      [userId, organisationId],
    );
    if (!row || row.status !== UserStatus.ACTIVE) throw new AiAccessRevokedError('account');
    if (row.suspended !== false) throw new AiAccessRevokedError('organisation_suspended');
    if (row.maintenance === true) throw new AiAccessRevokedError('maintenance');
    return row.timezone || 'Europe/London';
  }
}
