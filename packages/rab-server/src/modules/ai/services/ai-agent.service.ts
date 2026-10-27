import { AI_AGENT_LIMITS, AiAgentCreateRequest, AiAgentModelSelection, AiAgentStorageView, AiAgentUpdateRequest, AiAgentWriteReason } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditActionType, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { catalogueEntry } from '../../../engine/core-modules/ai/models/catalog';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { MemberRolePolicyService } from '../../identity/services/member-role-policy.service';
import { agentTextRefusals } from '../agents/agent-content-rules';
import { AiRecordNotFoundException } from '../exceptions/ai.exceptions';
import {
  AiAgentContentRefusedException,
  AiAgentInvalidException,
  AiAgentLimitReachedException,
  AiAgentNameTakenException,
  AiAgentNothingToChangeException,
} from '../exceptions/ai-agent.exceptions';
import { AiAgentAuthority } from './ai-agent-authority.service';
import { agentView, AgentRow, listAgentViews, lockCustomAgent, mapAgentWriteError, Scope, scopeOf, sha256 } from './ai-agent-store';
import { AiConfigService } from './ai-config.service';
import { returningRows } from './ai-query-rows';

/** Body of a create, as the controller maps it explicitly from the DTO (never a spread). */
export type AiAgentCreateInput = AiAgentCreateRequest & AiAgentWriteReason;
/** Body of a PATCH (the name never changes). */
export type AiAgentUpdateInput = AiAgentUpdateRequest & AiAgentWriteReason;

/**
 * AI Phase 6a — agent DEFINITIONS (docs/ai/PHASE6_TWENTY_PLAN.md §3.1 / §4). Storage only: the owner deferred EX-3, so
 * nothing here (or anywhere) runs an agent, enables a trigger or calls a model for an agent.
 *
 * Five layers on every operation (CLAUDE.md):
 *   1. controller: JwtAuthGuard + @ManagerApplication + AiAgentsSwitchGuard + PermissionGuard(ai.agents.manage);
 *   2. HERE: AiAgentAuthority (Inspect refused, both platform switches, the flag re-read, the CEO, the organisation's AI
 *      and agents switches) inside the transaction — and again inside every write transaction after the step-up — plus
 *      a reason, the content rules, the model / role / format checks and the 20-agent limit (a clean 409);
 *   3. every query names the caller's organisation AND workspace;
 *   4. FORCE RLS on `core.ai_agent`: the bound organisation + workspace; readers `core.ai_actor_eligible()`;
 *   5. writers `core.ai_agent_writer()` (CEO) + `updated_by = core.current_uid()` + `kind = 'custom'`; column grants
 *      (no `kind`, `config_version`, `is_active`, `name` update; no DELETE). A refused write (42501) is answered 404.
 * Audit rows carry ids, the name, changed field NAMES, text lengths and SHA-256 hashes and the reason — NEVER the
 * instruction text, label or description.
 */
@Injectable()
export class AiAgentService {
  constructor(
    private readonly authority: AiAgentAuthority,
    private readonly config: AiConfigService,
    private readonly memberRoles: MemberRolePolicyService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(ctx: AuthContext): Promise<AiAgentStorageView[]> {
    return this.tenantContext.runInTenantContext(this.authority.bound(ctx), async (m) => {
      await this.authority.assertManagerTx(m, ctx);
      await m.query('SET TRANSACTION READ ONLY');
      return listAgentViews(m, scopeOf(ctx));
    });
  }

  async get(ctx: AuthContext, id: string): Promise<AiAgentStorageView> {
    return this.tenantContext.runInTenantContext(this.authority.bound(ctx), async (m) => {
      await this.authority.assertManagerTx(m, ctx);
      await m.query('SET TRANSACTION READ ONLY');
      return agentView(m, scopeOf(ctx), id);
    });
  }

  async create(ctx: AuthContext, input: AiAgentCreateInput): Promise<AiAgentStorageView> {
    const reason = await this.authority.authorizeWrite(ctx, input?.reason);
    const description = emptyToNull(input.description);
    this.assertText({ name: input.name, label: input.label, description: description ?? undefined, prompt: input.prompt });
    const model = this.assertModel(input.model);
    this.assertFormat(input.responseFormat);
    const roleId = this.roleIdOf(input.roleId);
    return this.writeTx(ctx, async (m, scope) => {
      // The same advisory key the limit trigger takes: concurrent creates in one workspace serialise, so this count is
      // exact and the 21st gets this clean 409 (the trigger stays the database-level backstop).
      await m.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai_agent:' || $1::uuid::text, 0))`, [scope.workspaceId]);
      const [{ n }] = await m.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM core.ai_agent WHERE organisation_id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
        [scope.organisationId, scope.workspaceId],
      );
      if (n >= AI_AGENT_LIMITS.agentsPerWorkspace) throw new AiAgentLimitReachedException();
      const [taken] = await m.query<Array<{ id: string }>>(
        `SELECT id FROM core.ai_agent WHERE organisation_id = $1 AND workspace_id = $2 AND name = $3 AND deleted_at IS NULL`,
        [scope.organisationId, scope.workspaceId, input.name],
      );
      if (taken) throw new AiAgentNameTakenException();
      if (roleId) await this.assertRoleAttachable(m, ctx, roleId);
      const [row] = await m.query<Array<{ id: string; config_version: number }>>(
        `INSERT INTO core.ai_agent (organisation_id, workspace_id, name, label, description, prompt, model_tier, model_id, response_format, role_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'text', $9, $10, $10) RETURNING id, config_version`,
        [scope.organisationId, scope.workspaceId, input.name, input.label, description, input.prompt, model.tier, model.modelId, roleId, ctx.userId],
      );
      await this.auditAgent(m, ctx, AuditAction.AI_AGENT_CREATED, row!.id, {
        name: input.name,
        modelTier: model.tier,
        modelId: model.modelId,
        roleId,
        configVersion: Number(row!.config_version),
        ...textFacts({ label: input.label, description, prompt: input.prompt }),
        reason,
      });
      return row!.id;
    });
  }

  async update(ctx: AuthContext, id: string, input: AiAgentUpdateInput): Promise<AiAgentStorageView> {
    const reason = await this.authority.authorizeWrite(ctx, input?.reason);
    const changes = {
      label: input.label,
      description: input.description,
      prompt: input.prompt,
      model: input.model,
      responseFormat: input.responseFormat,
      roleId: input.roleId,
    };
    const changed = (Object.keys(changes) as Array<keyof typeof changes>).filter((k) => changes[k] !== undefined);
    if (changed.length === 0) throw new AiAgentNothingToChangeException();
    const description = input.description === undefined ? undefined : emptyToNull(input.description);
    this.assertText({ label: input.label, description: description ?? undefined, prompt: input.prompt });
    const model = input.model === undefined ? undefined : this.assertModel(input.model);
    this.assertFormat(input.responseFormat);
    const roleId = input.roleId === undefined ? undefined : this.roleIdOf(input.roleId);
    return this.writeTx(ctx, async (m, scope) => {
      const before = await lockCustomAgent(m, scope, id);
      if (roleId) await this.assertRoleAttachable(m, ctx, roleId);
      const next = {
        label: input.label ?? before.label,
        description: description === undefined ? before.description : description,
        prompt: input.prompt ?? before.prompt,
        modelTier: model?.tier ?? before.model_tier,
        modelId: model === undefined ? before.model_id : model.modelId,
        roleId: roleId === undefined ? before.role_id : roleId,
      };
      const [row] = await returningRows<{ config_version: number }>(
        m,
        `UPDATE core.ai_agent SET label = $4, description = $5, prompt = $6, model_tier = $7, model_id = $8, role_id = $9, updated_by = $10, updated_at = now()
          WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3 AND kind = 'custom' AND deleted_at IS NULL RETURNING config_version`,
        [before.id, scope.organisationId, scope.workspaceId, next.label, next.description, next.prompt, next.modelTier, next.modelId, next.roleId, ctx.userId],
      );
      if (!row) throw new AiRecordNotFoundException();
      const configVersion = Number(row.config_version);
      // A run-relevant edit pauses the agent's ENABLED triggers in the same transaction (P6 §2 item 5). None can be
      // enabled before EX-3 (CHECK ai_agent_trigger_ex3_gate), so this is a no-op today and the rule is already in place.
      if (configVersion !== Number(before.config_version)) {
        await m.query(
          `UPDATE core.ai_agent_trigger SET enabled = false, paused_reason = 'config_changed', updated_by = $3, updated_at = now() WHERE agent_id = $1 AND workspace_id = $2 AND enabled`,
          [before.id, scope.workspaceId, ctx.userId],
        );
      }
      await this.auditAgent(m, ctx, AuditAction.AI_AGENT_UPDATED, before.id, {
        name: before.name,
        changed,
        modelTier: next.modelTier,
        modelId: next.modelId,
        roleId: next.roleId,
        configVersion,
        ...textFacts({ label: next.label, description: next.description, prompt: next.prompt }),
        previousPromptSha256: sha256(before.prompt),
        reason,
      });
      return before.id;
    });
  }

  /**
   * Soft delete of a CUSTOM agent (standard / system agents: 409). Its triggers are removed, its role reference cleared,
   * and its dedicated agent role deleted when no other agent references it. The row stays (deleted_at) for the audit trail.
   */
  async remove(ctx: AuthContext, id: string, reasonInput: unknown): Promise<{ deleted: true; id: string }> {
    const reason = await this.authority.authorizeWrite(ctx, reasonInput);
    let deletedId = '';
    await this.writeTx(ctx, async (m, scope) => {
      const before = await lockCustomAgent(m, scope, id);
      const triggers = await returningRows<{ id: string }>(m, `DELETE FROM core.ai_agent_trigger WHERE agent_id = $1 AND workspace_id = $2 RETURNING id`, [before.id, scope.workspaceId]);
      const deleted = await returningRows<{ id: string }>(
        m,
        `UPDATE core.ai_agent SET deleted_at = now(), role_id = NULL, updated_by = $4, updated_at = now()
          WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3 AND kind = 'custom' AND deleted_at IS NULL RETURNING id`,
        [before.id, scope.organisationId, scope.workspaceId, ctx.userId],
      );
      if (deleted.length !== 1) throw new AiRecordNotFoundException();
      const roleDeleted = before.role_id ? await this.deleteOrphanAgentRole(m, scope, before.role_id) : false;
      await this.auditAgent(m, ctx, AuditAction.AI_AGENT_DELETED, before.id, {
        name: before.name,
        triggersDeleted: triggers.length,
        roleId: before.role_id,
        roleDeleted,
        promptSha256: sha256(before.prompt),
        reason,
      });
      deletedId = before.id;
      return null;
    });
    return { deleted: true, id: deletedId };
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private assertText(fields: { name?: unknown; label?: unknown; description?: unknown; prompt?: unknown }): void {
    const refusals = agentTextRefusals(fields);
    if (refusals.length > 0) throw new AiAgentContentRefusedException(refusals);
  }

  /** A model choice is a TIER plus an optional catalogue lookup key OF THAT TIER (rule 4.2 / C11); never a free-form id. */
  private assertModel(model: unknown): AiAgentModelSelection {
    const value = model as Partial<AiAgentModelSelection> | undefined;
    if (!value || typeof value !== 'object' || (value.tier !== 'fast' && value.tier !== 'smart')) throw new AiAgentInvalidException('model');
    if (value.modelId === null || value.modelId === undefined) return { tier: value.tier, modelId: null };
    const entry = typeof value.modelId === 'string' ? catalogueEntry(value.modelId, this.config.catalogue) : null;
    if (!entry || entry.tier !== value.tier) throw new AiAgentInvalidException('model');
    return { tier: value.tier, modelId: entry.id };
  }

  private assertFormat(format: unknown): void {
    if (format !== undefined && format !== 'text') throw new AiAgentInvalidException('responseFormat');
  }

  private roleIdOf(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new AiAgentInvalidException('roleId');
    return value;
  }

  /** Only an agent role of this workspace whose flags the caller may grant (no escalation); otherwise 400, never a 404 leak. */
  private async assertRoleAttachable(m: EntityManager, ctx: AuthContext, roleId: string): Promise<void> {
    try {
      await this.memberRoles.loadAgentAssignableTx(m, ctx, roleId);
    } catch (error) {
      if ((error as { status?: number })?.status === 404) throw new AiAgentInvalidException('roleId');
      throw error;
    }
  }

  /** Deletes an agent role nothing references any more (crewflow_app, under role RLS: the current workspace only). */
  private async deleteOrphanAgentRole(m: EntityManager, scope: Scope, roleId: string): Promise<boolean> {
    const rows = await returningRows<{ id: string }>(
      m,
      `DELETE FROM core.role r WHERE r.id = $1 AND r.workspace_id = $2 AND r.assignable_to_agents
         AND NOT EXISTS (SELECT 1 FROM core.ai_agent a WHERE a.role_id = r.id) RETURNING r.id`,
      [roleId, scope.workspaceId],
    );
    return rows.length === 1;
  }

  /** The write transaction: authorisation re-checked inside it, the write and its audit row, then the fresh view. */
  private async writeTx(ctx: AuthContext, write: (m: EntityManager, scope: Scope) => Promise<string | null>): Promise<AiAgentStorageView> {
    try {
      return await this.tenantContext.runInTenantContext(this.authority.bound(ctx), async (m) => {
        await this.authority.assertManagerTx(m, ctx);
        const id = await write(m, scopeOf(ctx));
        return id ? agentView(m, scopeOf(ctx), id) : (null as unknown as AiAgentStorageView);
      });
    } catch (error) {
      throw mapAgentWriteError(error);
    }
  }

  private async auditAgent(m: EntityManager, ctx: AuthContext, action: AuditActionType, agentId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.audit.record(m, ctx, action, { entityType: 'ai_agent', entityId: agentId, metadata: { agentId, ...metadata } });
  }
}

function emptyToNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return value.trim() === '' ? null : value;
}

/** Lengths and hashes only — never the text. */
function textFacts(text: { label: string; description: string | null; prompt: string }): Record<string, unknown> {
  return {
    labelLength: text.label.length,
    descriptionLength: text.description?.length ?? 0,
    promptLength: text.prompt.length,
    promptSha256: sha256(text.prompt),
  };
}
