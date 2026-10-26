import { AI_AGENT_ROLE_ALLOWLIST, PermissionFlag, PermissionFlagType } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DISPOSABLE_TEST_DATABASE_SETTING } from '../../../database/typeorm/core/test-database-guard';
import { AiModelPins } from '../../../engine/core-modules/ai/ai-readiness';
import { AiCatalogueModel, catalogueEntry, isRealProvider } from '../../../engine/core-modules/ai/models/catalog';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiAgentRunJobData } from '../../../engine/worker-shared/ai-jobs.contract';
import { AiAgentRunFacts, decideAgentRun } from '../agents/agent-principal.policy';
import { AI_AGENT_EXECUTION_APPROVED, AiAgentPrincipal, AiAgentPrincipalServiceContract, AiAgentRunRefusal } from '../contracts/agents';
import { AiAccessRevokedError } from '../exceptions/ai.exceptions';
import { realProviderPermitted } from './ai-access.service';
import { AiConfigService } from './ai-config.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LoadedFacts {
  facts: AiAgentRunFacts;
  timezone: string;
  synthetic: boolean;
  testMarked: boolean;
  pins: AiModelPins;
  agentModel: { tier: 'fast' | 'smart'; modelId: string | null } | null;
}

/**
 * AI Phase 6 — the delegated RUN-AS principal (docs/ai/PHASE6_TWENTY_PLAN.md §2, C1/C2; contract
 * `AiAgentPrincipalServiceContract`). The ONLY place that would build an agent actor.
 *
 * EX-3 IS NOT APPROVED (owner decision 2026-10-25): both methods refuse FIRST, before any database read or model
 * resolution — `rebuildForAgentRun` answers `{refused: true, reason: 'execution_not_approved'}` and
 * `assertAgentStillAllowed` throws `AiAccessRevokedError('execution_not_approved')`. Nothing in 6a calls either (no
 * processor, no scan, no runner agent mode: static test `ai-agents-no-execution.spec.ts`). The code after the gate is
 * the reviewed shape 6b will switch on: facts read in ONE REPEATABLE READ transaction under the RUN-AS USER's own tenant
 * context (organisation + workspace + user GUCs; never `actorType: 'worker'`, never `runScopedForOrg`, never an owner or
 * direct connection — rule 2.1, T6-P3), decided by the pure `decideAgentRun` (unit-tested), then item 8: the agent's
 * model (a catalogue lookup key of its tier, else the tier's resolution) and EX-1 `realProviderPermitted`.
 * Pausing a trigger on a **P** refusal is 6b's `core.ai_agent_trigger_pause()` definer, which does not exist yet.
 */
@Injectable()
export class AiAgentPrincipalService implements AiAgentPrincipalServiceContract {
  constructor(
    private readonly config: AiConfigService,
    private readonly env: EnvironmentService,
    private readonly permissions: PermissionsService,
    private readonly tenantContext: TenantContextService,
    private readonly dataSource: DataSource,
  ) {}

  async rebuildForAgentRun(job: AiAgentRunJobData): Promise<AiAgentPrincipal | AiAgentRunRefusal> {
    if (!AI_AGENT_EXECUTION_APPROVED) return { refused: true, reason: 'execution_not_approved' } as AiAgentRunRefusal;
    if (!job || job.kind !== 'agent-run' || ![job.organisationId, job.workspaceId, job.userId, job.agentId, job.turnId].every((id) => UUID.test(String(id)))) {
      return { refused: true, reason: 'paused', pauseReason: 'owner_ineligible' };
    }
    if (job.triggerId !== null && !UUID.test(String(job.triggerId))) return { refused: true, reason: 'paused', pauseReason: 'owner_ineligible' };
    const loaded = await this.loadFacts(job.organisationId, job.workspaceId, job.userId, job.agentId, job.triggerId);
    const decision = decideAgentRun(loaded.facts, new Date());
    if (!decision.ok) return decision.refusal;
    const model = this.resolveAgentModel(loaded);
    if (!model) return { refused: true, reason: 'no_model' };
    if (!realProviderPermitted(isRealProvider(model), { synthetic: loaded.synthetic, testMarked: loaded.testMarked })) return { refused: true, reason: 'real_provider_not_permitted' };
    const trigger = loaded.facts.trigger;
    return {
      kind: 'agent',
      organisationId: job.organisationId,
      workspaceId: job.workspaceId,
      runAsUserId: job.userId,
      agentId: job.agentId,
      triggerId: job.triggerId,
      turnId: job.turnId,
      timezone: loaded.timezone,
      effectivePermissions: decision.effectivePermissions,
      snapshot: {
        userSecurityVersion: Number(trigger?.snapUserSecurityVersion ?? loaded.facts.user.securityVersion ?? 0),
        agentConfigVersion: Number(trigger?.snapAgentConfigVersion ?? loaded.facts.agent?.configVersion ?? 0),
        rolePermissionVersion: trigger ? trigger.snapRolePermissionVersion : (loaded.facts.agent?.rolePermissionVersion ?? null),
        consentFlags: [...decision.effectivePermissions],
        consentAt: (trigger?.enabledAt ?? new Date()).toISOString(),
      },
      model,
      realProviderPermitted: true,
    };
  }

  async assertAgentStillAllowed(principal: AiAgentPrincipal, flag?: PermissionFlagType): Promise<void> {
    if (!AI_AGENT_EXECUTION_APPROVED) throw new AiAccessRevokedError('execution_not_approved');
    const loaded = await this.loadFacts(principal.organisationId, principal.workspaceId, principal.runAsUserId, principal.agentId, principal.triggerId);
    const decision = decideAgentRun(loaded.facts, new Date());
    if (!decision.ok) throw new AiAccessRevokedError(decision.refusal.reason === 'paused' ? decision.refusal.pauseReason : decision.refusal.reason);
    if (flag && !(decision.effectivePermissions.has(flag) && principal.effectivePermissions.has(flag))) throw new AiAccessRevokedError('tool_permission');
    if (!this.config.isModelUsable(principal.model)) throw new AiAccessRevokedError('platform_not_ready');
    if (!realProviderPermitted(isRealProvider(principal.model), { synthetic: loaded.synthetic, testMarked: loaded.testMarked })) throw new AiAccessRevokedError('real_provider_not_permitted');
  }

  // ── internals (post-gate; unreachable in 6a) ──────────────────────────────────────────────────────────────────────

  /** Every fact of §2 items 1–7 in ONE REPEATABLE READ transaction, as the run-as user (RLS bound to them). */
  private async loadFacts(organisationId: string, workspaceId: string, userId: string, agentId: string, triggerId: string | null): Promise<LoadedFacts> {
    const ctx: AuthContext = { organisationId, workspaceId, userId, role: '' };
    return this.dataSource.transaction('REPEATABLE READ', async (m) => {
      await this.tenantContext.bindCoreIdentityGucs(m, ctx);
      await m.query('SET TRANSACTION READ ONLY');
      const [row] = await m.query<Array<Record<string, unknown>>>(
        `SELECT core.ai_actor_eligible() AS eligible,
                (SELECT s.enabled FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS org_ai,
                (SELECT s.agents_enabled FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS org_agents,
                (SELECT s.synthetic_data FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS synthetic,
                EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase, unnest(s.setconfig) cfg
                         WHERE d.datname = pg_catalog.current_database() AND s.setrole = 0 AND cfg = $4) AS test_marked,
                (SELECT o.suspended_at IS NOT NULL FROM core.organisation o WHERE o.id = $1) AS suspended,
                (SELECT o.timezone FROM core.organisation o WHERE o.id = $1) AS timezone,
                (SELECT pc.maintenance_mode_enabled FROM core.platform_config pc WHERE pc.organisation_id = $1) AS maintenance,
                (SELECT u.status FROM core."user" u WHERE u.id = $2) AS user_status,
                (SELECT u.must_reset_password FROM core."user" u WHERE u.id = $2) AS must_reset,
                (SELECT u.security_version FROM core."user" u WHERE u.id = $2) AS security_version,
                EXISTS (SELECT 1 FROM core.workspace_membership wm WHERE wm.user_id = $2 AND wm.workspace_id = $3 AND wm.organisation_id = $1 AND wm.status = 'active') AS membership,
                (SELECT jsonb_object_agg(p.tier, p.model_id) FROM core.organisation_ai_model_preference p WHERE p.organisation_id = $1) AS pins`,
        [organisationId, userId, workspaceId, `${DISPOSABLE_TEST_DATABASE_SETTING}=true`],
      );
      const [agent] = await m.query<Array<{ config_version: number; role_id: string | null; live: boolean; role_version: number | null; model_tier: 'fast' | 'smart'; model_id: string | null }>>(
        `SELECT a.config_version, a.role_id, a.deleted_at IS NULL AS live, r.permission_version AS role_version, a.model_tier, a.model_id
           FROM core.ai_agent a LEFT JOIN core.role r ON r.id = a.role_id AND r.assignable_to_agents
          WHERE a.id = $1 AND a.organisation_id = $2 AND a.workspace_id = $3`,
        [agentId, organisationId, workspaceId],
      );
      const roleFlags = agent?.role_id
        ? (
            await m.query<Array<{ key: PermissionFlagType }>>(
              `SELECT p.key FROM core.role_permission rp JOIN core.permission p ON p.id = rp.permission_id WHERE rp.role_id = $1`,
              [agent.role_id],
            )
          ).map((r) => r.key)
        : [];
      const [trigger] = triggerId
        ? await m.query<
            Array<{
              enabled: boolean;
              run_as_user_id: string | null;
              enabled_at: Date | null;
              consent_flags: string[] | null;
              snap_user_security_version: number | null;
              snap_agent_config_version: number | null;
              snap_role_permission_version: number | null;
            }>
          >(
            `SELECT enabled, run_as_user_id, enabled_at, consent_flags, snap_user_security_version, snap_agent_config_version, snap_role_permission_version
               FROM core.ai_agent_trigger WHERE id = $1 AND agent_id = $2 AND organisation_id = $3 AND workspace_id = $4`,
            [triggerId, agentId, organisationId, workspaceId],
          )
        : [];
      const userFlags = new Set<PermissionFlagType>();
      for (const flag of AI_AGENT_ROLE_ALLOWLIST) if (await this.permissions.userHasPermissionTx(m, ctx, flag)) userFlags.add(flag);
      const holdsAiUse = await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_USE);
      const holdsAgentsManage = await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_AGENTS_MANAGE);
      const pins: AiModelPins = {};
      for (const tier of ['fast', 'smart'] as const) {
        const id = (row?.pins as Record<string, unknown> | null)?.[tier];
        if (typeof id === 'string') pins[tier] = id;
      }
      return {
        facts: {
          switches: { aiEnabled: this.config.enabled, agentsEnabled: this.env.get('AI_AGENTS_ENABLED') === true, orgAiEnabled: row?.org_ai === true, orgAgentsEnabled: row?.org_agents === true },
          organisation: { suspended: row?.suspended !== false, maintenance: row?.maintenance === true },
          runAsUserId: userId,
          user: {
            status: typeof row?.user_status === 'string' ? row.user_status : null,
            mustResetPassword: row?.must_reset !== false,
            securityVersion: row?.security_version === null || row?.security_version === undefined ? null : Number(row.security_version),
          },
          membershipActive: row?.membership === true,
          eligible: row?.eligible === true,
          holdsAiUse,
          holdsAgentsManage,
          userFlags,
          agent: agent
            ? { live: agent.live === true, configVersion: Number(agent.config_version), roleId: agent.role_id, rolePermissionVersion: agent.role_version === null ? null : Number(agent.role_version), roleFlags }
            : null,
          trigger: trigger
            ? {
                enabled: trigger.enabled,
                runAsUserId: trigger.run_as_user_id,
                enabledAt: trigger.enabled_at ? new Date(trigger.enabled_at) : null,
                consentFlags: trigger.consent_flags,
                snapUserSecurityVersion: trigger.snap_user_security_version === null ? null : Number(trigger.snap_user_security_version),
                snapAgentConfigVersion: trigger.snap_agent_config_version === null ? null : Number(trigger.snap_agent_config_version),
                snapRolePermissionVersion: trigger.snap_role_permission_version === null ? null : Number(trigger.snap_role_permission_version),
              }
            : triggerId
              ? { enabled: false, runAsUserId: null, enabledAt: null, consentFlags: null, snapUserSecurityVersion: null, snapAgentConfigVersion: null, snapRolePermissionVersion: null }
              : null,
        },
        timezone: typeof row?.timezone === 'string' && row.timezone ? row.timezone : 'Europe/London',
        // Anything but an explicit true is "not synthetic"; a marker read that is not an explicit false is "test" (EX-1).
        synthetic: row?.synthetic === true,
        testMarked: row?.test_marked !== false,
        pins,
        agentModel: agent ? { tier: agent.model_tier, modelId: agent.model_id } : null,
      };
    });
  }

  /** Item 8 (C11): the agent's pinned catalogue model when it is still usable and of the agent's tier, else the tier's resolution. */
  private resolveAgentModel(loaded: LoadedFacts): AiCatalogueModel | null {
    if (!loaded.agentModel) return null;
    const pinned = catalogueEntry(loaded.agentModel.modelId, this.config.catalogue);
    if (pinned && pinned.tier === loaded.agentModel.tier && this.config.isModelUsable(pinned)) return pinned;
    return this.config.resolve(loaded.agentModel.tier, loaded.pins)?.model ?? null;
  }
}
