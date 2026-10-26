import { AI_AGENT_REASON_LIMITS, AI_AGENT_STEP_UP_ACTION, PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { StepUpReauthService } from '../../../engine/core-modules/auth/services/step-up-reauth.service';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiNotAvailableException } from '../exceptions/ai.exceptions';
import { AiAgentReasonRequiredException } from '../exceptions/ai-agent.exceptions';
import { AiConfigService } from './ai-config.service';

/**
 * Layer 2 of Settings → AI → Agents (docs/ai/PHASE6_TWENTY_PLAN.md §4, P6-D7 / P6-D12), in ONE place every agent service
 * calls — inside the caller's own tenant transaction, again inside every write transaction. Order (a later gate is
 * disclosed only to a caller who passed every earlier one):
 *   1. an Admin Inspect session, no organisation / workspace / user              → the uniform 404 AI_NOT_AVAILABLE;
 *   2. the platform switches `AI_AGENTS_ENABLED` (default false) and `AI_ENABLED` → the same 404 (the feature is invisible);
 *   3. `ai.use` and `ai.agents.manage` re-read from PostgreSQL (overrides, then roles visible under RLS) → the uniform 404
 *      (p6 merge: like every AI route, AiDecidableGuard / p5 Q4 — never a 403 that discloses the feature);
 *   4. the bound user is the organisation's CEO (`core.ai_agent_writer()`), the organisation's AI switch and its agents
 *      switch (`organisation_ai_setting.enabled` / `.agents_enabled`, both default false) → the same 404 (a custom grant of
 *      the flag gives a non-CEO nothing, and an outsider learns nothing about the configuration).
 * Writes then need a recent step-up of THIS session (`organisation.ai.agent.update`) and a reason of 3..500 characters.
 * Every refusal throws — never a boolean a caller could forget to check.
 */
@Injectable()
export class AiAgentAuthority {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly config: AiConfigService,
    private readonly env: EnvironmentService,
    private readonly stepUp: StepUpReauthService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** `AI_AGENTS_ENABLED` — read per call (never cached), so an operator's change and a test override apply at once. */
  get agentsEnabled(): boolean {
    return this.env.get('AI_AGENTS_ENABLED') === true;
  }

  /** Steps 1–2 only (no database): the route guard's check, and the first thing every service method does. */
  assertSwitchedOn(ctx: AuthContext | undefined): void {
    if (!ctx || ctx.inspectedBy || !ctx.organisationId || !ctx.workspaceId || !ctx.userId) throw new AiNotAvailableException();
    if (!this.agentsEnabled || !this.config.enabled) throw new AiNotAvailableException();
  }

  /** Layer 1 (the route guard): steps 1–4 in a short tenant transaction of the caller's own. Every refusal is the 404. */
  async assertManager(ctx: AuthContext | undefined): Promise<void> {
    this.assertSwitchedOn(ctx);
    await this.tenantContext.runInTenantContext(this.bound(ctx!), (m) => this.assertManagerTx(m, ctx!));
  }

  /** Steps 1–4 inside an open, tenant-bound transaction. */
  async assertManagerTx(m: EntityManager, ctx: AuthContext): Promise<void> {
    this.assertSwitchedOn(ctx);
    // p6 merge (coordinator, p5 Q4 decision): `ai.use` and `ai.agents.manage` missing are the SAME uniform 404 as every
    // other AI gate — a 403 would confirm the feature exists to a user who may not see it.
    if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_USE))) throw new AiNotAvailableException();
    if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_AGENTS_MANAGE))) throw new AiNotAvailableException();
    const [row] = await m.query<Array<{ writer: boolean; enabled: boolean | null; agents: boolean | null }>>(
      `SELECT core.ai_agent_writer() AS writer,
              (SELECT s.enabled FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS enabled,
              (SELECT s.agents_enabled FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS agents`,
      [ctx.organisationId],
    );
    if (row?.writer !== true || row.enabled !== true || row.agents !== true) throw new AiNotAvailableException();
  }

  /**
   * Before any write: authorisation first (a stranger learns nothing and is never asked to step up), then the step-up of
   * this session, then the reason. The write transaction re-runs `assertManagerTx` (the facts may change in between).
   */
  async authorizeWrite(ctx: AuthContext, reason: unknown): Promise<string> {
    await this.tenantContext.runInTenantContext(this.bound(ctx), (m) => this.assertManagerTx(m, ctx));
    await this.stepUp.assertRecentStepUp(ctx, AI_AGENT_STEP_UP_ACTION);
    if (typeof reason !== 'string' || reason.trim().length < AI_AGENT_REASON_LIMITS.minChars || reason.length > AI_AGENT_REASON_LIMITS.maxChars) {
      throw new AiAgentReasonRequiredException();
    }
    return reason;
  }

  /** The caller's own tenant context (never platform/owner context); Admin Inspect and missing ids refused first. */
  bound(ctx: AuthContext): AuthContext {
    this.assertSwitchedOn(ctx);
    return { ...ctx, role: '' };
  }
}
