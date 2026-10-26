import { AI_AGENT_LIMITS, AiAgentEventType, AiAgentSchedule, AiAgentStorageView, AiAgentTriggerCreateRequest, AiAgentTriggerUpdateRequest, AiAgentWriteReason } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditActionType, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { normaliseTrigger, normaliseTriggerUpdate } from '../agents/agent-trigger-shape';
import { AI_AGENT_EXECUTION_APPROVED } from '../contracts/agents';
import { AiRecordNotFoundException } from '../exceptions/ai.exceptions';
import { AiAgentExecutionNotApprovedException, AiAgentInvalidException, AiAgentTriggerLimitReachedException } from '../exceptions/ai-agent.exceptions';
import { AiAgentAuthority } from './ai-agent-authority.service';
import { agentView, findAgent, findTrigger, lockCustomAgent, mapAgentWriteError, Scope, scopeOf } from './ai-agent-store';
import { returningRows } from './ai-query-rows';

export type AiAgentTriggerCreateInput = AiAgentTriggerCreateRequest & AiAgentWriteReason;
export type AiAgentTriggerUpdateInput = AiAgentTriggerUpdateRequest & AiAgentWriteReason;

/**
 * AI Phase 6a — agent TRIGGERS, STORED SWITCHED OFF (docs/ai/PHASE6_TWENTY_PLAN.md §3.1 / §5; owner decision 2026-10-25:
 * EX-3 deferred). A trigger is a schedule (restricted DSL, minimum one hour) or a list of record events; it can be
 * created, edited, deleted and disabled, but NEVER enabled:
 *   - `enable` refuses with 409 AI_AGENT_EXECUTION_NOT_APPROVED for every caller who may see the trigger (after the same
 *     authorisation, so an outsider still gets the uniform 404) — `AI_AGENT_EXECUTION_APPROVED` is the literal `false`;
 *   - the database refuses it independently: CHECK `ai_agent_trigger_ex3_gate` (no enabled row, no run-as user, no
 *     consent, no snapshot, no next fire), and crewflow_app has no UPDATE grant on the run-as / snapshot / schedule-time
 *     columns;
 *   - nothing computes a fire time, writes a due-work pointer, records an event, enqueues a job or builds a principal.
 * Layers as in AiAgentService; standard / system agents' triggers are read-only (409); a trigger is addressed only
 * through its own agent (`/ai/agents/:id/triggers/:triggerId`) — a trigger of another agent, workspace or organisation is
 * the uniform 404.
 */
@Injectable()
export class AiAgentTriggerService {
  constructor(
    private readonly authority: AiAgentAuthority,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async create(ctx: AuthContext, agentId: string, input: AiAgentTriggerCreateInput): Promise<AiAgentStorageView> {
    const reason = await this.authority.authorizeWrite(ctx, input?.reason);
    const shape = normaliseTrigger(input?.kind, input?.schedule, input?.eventTypes);
    if (!shape) throw new AiAgentInvalidException('trigger');
    return this.writeTx(ctx, async (m, scope) => {
      const agent = await lockCustomAgent(m, scope, agentId);
      await m.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai_agent_trigger:' || $1::uuid::text, 0))`, [agent.id]);
      const [{ n }] = await m.query<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM core.ai_agent_trigger WHERE agent_id = $1 AND workspace_id = $2`, [agent.id, scope.workspaceId]);
      if (n >= AI_AGENT_LIMITS.triggersPerAgent) throw new AiAgentTriggerLimitReachedException();
      // `enabled` is not in the INSERT column grant: every trigger is born switched off (and the EX-3 CHECK agrees).
      const [row] = await m.query<Array<{ id: string }>>(
        `INSERT INTO core.ai_agent_trigger (organisation_id, workspace_id, agent_id, kind, schedule, event_types, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $7) RETURNING id`,
        [scope.organisationId, scope.workspaceId, agent.id, shape.kind, jsonOrNull(shape.schedule), shape.eventTypes, ctx.userId],
      );
      await this.auditTrigger(m, ctx, AuditAction.AI_AGENT_TRIGGER_CREATED, agent.id, row!.id, { kind: shape.kind, ...shapeFacts(shape.schedule, shape.eventTypes), reason });
      return agent.id;
    });
  }

  async update(ctx: AuthContext, agentId: string, triggerId: string, input: AiAgentTriggerUpdateInput): Promise<AiAgentStorageView> {
    const reason = await this.authority.authorizeWrite(ctx, input?.reason);
    return this.writeTx(ctx, async (m, scope) => {
      const agent = await lockCustomAgent(m, scope, agentId);
      const before = await findTrigger(m, scope, agent.id, triggerId, true);
      const shape = normaliseTriggerUpdate(before.kind, input?.schedule, input?.eventTypes);
      if (!shape) throw new AiAgentInvalidException('trigger');
      const rows = await returningRows<{ id: string }>(
        m,
        `UPDATE core.ai_agent_trigger SET schedule = $4::jsonb, event_types = $5::text[], updated_by = $6, updated_at = now()
          WHERE id = $1 AND agent_id = $2 AND workspace_id = $3 RETURNING id`,
        [before.id, agent.id, scope.workspaceId, jsonOrNull(shape.schedule), shape.eventTypes, ctx.userId],
      );
      if (rows.length !== 1) throw new AiRecordNotFoundException();
      await this.auditTrigger(m, ctx, AuditAction.AI_AGENT_TRIGGER_UPDATED, agent.id, before.id, { kind: before.kind, ...shapeFacts(shape.schedule, shape.eventTypes), reason });
      return agent.id;
    });
  }

  async remove(ctx: AuthContext, agentId: string, triggerId: string, reasonInput: unknown): Promise<AiAgentStorageView> {
    const reason = await this.authority.authorizeWrite(ctx, reasonInput);
    return this.writeTx(ctx, async (m, scope) => {
      const agent = await lockCustomAgent(m, scope, agentId);
      const before = await findTrigger(m, scope, agent.id, triggerId, true);
      const rows = await returningRows<{ id: string }>(m, `DELETE FROM core.ai_agent_trigger WHERE id = $1 AND agent_id = $2 AND workspace_id = $3 RETURNING id`, [
        before.id,
        agent.id,
        scope.workspaceId,
      ]);
      if (rows.length !== 1) throw new AiRecordNotFoundException();
      await this.auditTrigger(m, ctx, AuditAction.AI_AGENT_TRIGGER_DELETED, agent.id, before.id, { kind: before.kind, wasEnabled: before.enabled, reason });
      return agent.id;
    });
  }

  /**
   * EX-3 is not approved: REFUSED for everyone. Authorisation and scope come first (an outsider, a non-CEO or a foreign /
   * missing trigger gets exactly what any other route gives them), then the 409. No step-up is asked (nothing can
   * happen), nothing is written, no snapshot is taken and no pointer is created.
   */
  async enable(ctx: AuthContext, agentId: string, triggerId: string): Promise<never> {
    await this.tenantContext.runInTenantContext(this.authority.bound(ctx), async (m) => {
      await this.authority.assertManagerTx(m, ctx);
      await m.query('SET TRANSACTION READ ONLY');
      const scope = scopeOf(ctx);
      const agent = await findAgent(m, scope, agentId, false);
      await findTrigger(m, scope, agent.id, triggerId, false);
    });
    // `AI_AGENT_EXECUTION_APPROVED` is the literal `false` (contracts/agents.ts); flipping it is a reviewed Agent 9 commit
    // after the owner approves EX-3. This assignment then stops COMPILING, so the flip cannot ship without 6b replacing
    // this method. Until then there is no code path that enables a trigger.
    const gate: false = AI_AGENT_EXECUTION_APPROVED;
    void gate;
    throw new AiAgentExecutionNotApprovedException();
  }

  /** Always allowed (step-up + reason). Before EX-3 no trigger can be enabled, so this changes nothing and writes no audit row. */
  async disable(ctx: AuthContext, agentId: string, triggerId: string, reasonInput: unknown): Promise<AiAgentStorageView> {
    const reason = await this.authority.authorizeWrite(ctx, reasonInput);
    return this.writeTx(ctx, async (m, scope) => {
      const agent = await lockCustomAgent(m, scope, agentId);
      const before = await findTrigger(m, scope, agent.id, triggerId, true);
      const rows = await returningRows<{ id: string }>(
        m,
        `UPDATE core.ai_agent_trigger SET enabled = false, paused_reason = NULL, updated_by = $4, updated_at = now()
          WHERE id = $1 AND agent_id = $2 AND workspace_id = $3 AND enabled RETURNING id`,
        [before.id, agent.id, scope.workspaceId, ctx.userId],
      );
      if (rows.length === 1) await this.auditTrigger(m, ctx, AuditAction.AI_AGENT_TRIGGER_DISABLED, agent.id, before.id, { kind: before.kind, from: true, to: false, reason });
      return agent.id;
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private async writeTx(ctx: AuthContext, write: (m: EntityManager, scope: Scope) => Promise<string>): Promise<AiAgentStorageView> {
    try {
      return await this.tenantContext.runInTenantContext(this.authority.bound(ctx), async (m) => {
        await this.authority.assertManagerTx(m, ctx);
        const id = await write(m, scopeOf(ctx));
        return agentView(m, scopeOf(ctx), id);
      });
    } catch (error) {
      throw mapAgentWriteError(error);
    }
  }

  private async auditTrigger(m: EntityManager, ctx: AuthContext, action: AuditActionType, agentId: string, triggerId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.audit.record(m, ctx, action, { entityType: 'ai_agent_trigger', entityId: triggerId, metadata: { agentId, triggerId, ...metadata } });
  }
}

function jsonOrNull(value: AiAgentSchedule | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

/** The trigger's own shape is configuration (fixed enums and a time), never user text. */
function shapeFacts(schedule: AiAgentSchedule | null, eventTypes: AiAgentEventType[] | null): Record<string, unknown> {
  return schedule ? { schedule } : { eventTypes };
}
