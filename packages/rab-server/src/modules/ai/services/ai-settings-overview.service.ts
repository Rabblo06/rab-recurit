import { AiSettingsOverview, AiToolCatalogueEntryView, AiToolCatalogueView, PermissionFlag, PermissionFlagType } from '@rab/shared';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { ToolSet } from 'ai';
import { EntityManager } from 'typeorm';

import { AiModelPins } from '../../../engine/core-modules/ai/ai-readiness';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiNotAvailableException } from '../exceptions/ai.exceptions';
import { AiToolCatalogueLine } from '../contracts/tools';
import { AiToolRegistry } from '../tools/ai-tool-registry.service';
import { AiConfigService } from './ai-config.service';
import { AiSkillService } from './ai-skill.service';
import { isAiModelTier } from './ai-model-settings.service';

/**
 * What THIS server really serves (Phase 8, docs/ai/PHASE8_TWENTY_PLAN.md §2.1, brief 8a). A flag is true only once the
 * owning phase's API exists on this branch; Agent 9 flips each one in the merge commit of that phase. Never computed from
 * a client hint. `agentExecution` is the literal `false` until the owner approves EX-3.
 */
export const AI_SETTINGS_FEATURES: AiSettingsOverview['features'] = Object.freeze({
  /** Phase 4 core merged (p4, 39279012): Settings → AI → Skills CRUD. Composer tags arrive with 4w. */
  skills: true,
  /** The Phase 1 registry `catalogue()` exists (richer after Phase 3). */
  tools: true,
  /** Phase 7a merged: `GET /ai/settings/usage` (ai-usage-settings.controller.ts). */
  usage: true,
  /** `GET /ai/settings/prompt-preview` (this phase). */
  promptPreview: true,
  /** Phase 5b cards are not merged. */
  approvals: false,
  /** Phase 6a is not merged and `AI_AGENTS_ENABLED` does not exist yet. */
  agents: false,
  agentExecution: false,
  /** C1 (CD-3) backend merged: `GET/PUT/DELETE /ai/settings/assistant`. */
  assistant: true,
  /** C1 (CD-4) merged with p4: `GET/PUT/DELETE /ai/settings/instructions`. */
  instructions: true,
  /** C1 (CD-1/CD-2) backend merged: levels + policy in `GET /ai/settings/models`, `PUT /ai/settings/model-policy`. */
  levels: true,
  /** C1 (CD-8): `GET /ai/capabilities` (Phase 3w); not on this server yet. */
  capabilities: false,
});

/**
 * Fixed, plain-language name of each Phase 1 read tool for Settings → AI → Tools (no present tense: the chat has its own
 * running labels). Phase 3 moves labels into the registry (`DefineToolOptions`); until then an unknown name shows itself.
 */
export const AI_TOOL_SETTINGS_LABEL: Readonly<Record<string, string>> = Object.freeze({
  list_unfilled_shifts: 'Unfilled shifts',
  get_fill_rate: 'Fill rate',
  get_attendance_summary: 'Attendance summary',
  get_offer_status: 'Offer status counts',
  compare_payroll_runs: 'Payroll run comparison',
});

/** The caller's own tenant context (never platform/owner context); Admin Inspect is refused before anything else. */
export function boundSettingsContext(ctx: AuthContext): AuthContext {
  if (ctx.inspectedBy || !ctx.organisationId) throw new AiNotAvailableException();
  return { ...ctx, role: '' };
}

/**
 * Settings → AI read endpoints of Phase 8: `GET /ai/settings` (feature flags + limits) and `GET /ai/settings/tools` (the
 * registry catalogue + permission labels + whether THE CALLER holds each one). Read-only; nothing is written.
 *
 * Five layers (CLAUDE.md, same shape as AiModelSettingsService):
 *   1. controller: JwtAuthGuard + @ManagerApplication + PermissionGuard(ai.settings);
 *   2. this service (`authorizeTx`): Admin Inspect refused; `ai.settings` re-read from the database (403 like the guard);
 *      then the organisation's CEO (`core.ai_settings_writer()`), the platform kill switch and the organisation's AI
 *      switch — anything else is the uniform 404 (AI_NOT_AVAILABLE), so a non-CEO granted the flag learns nothing;
 *   3. every query is bound to the caller's organisation (`runInTenantContext`);
 *   4–5. RLS (FORCE) on `organisation_ai_setting` / `organisation_ai_model_preference`; `core.permission` is global
 *      reference data (no tenant rows).
 * Jobs and other services that call this service directly pass through layer 2 too (it is not a controller check).
 */
@Injectable()
export class AiSettingsOverviewService {
  constructor(
    private readonly config: AiConfigService,
    private readonly permissions: PermissionsService,
    private readonly tenantContext: TenantContextService,
    private readonly registry: AiToolRegistry,
    private readonly skills: AiSkillService,
  ) {}

  async overview(ctx: AuthContext): Promise<AiSettingsOverview> {
    const counts = await this.tenantContext.runInTenantContext(boundSettingsContext(ctx), async (m) => {
      await this.authorizeTx(m, ctx);
      return this.counts(m, ctx);
    });
    // CD-10: active skills (built-ins + custom), counted by the skill reader in its own tenant transaction as the caller.
    counts.activeSkills = await this.skills.countActive({ organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId!, userId: ctx.userId, sessionId: ctx.sessionId! });
    return {
      features: { ...AI_SETTINGS_FEATURES },
      counts,
      limits: {
        maxInputChars: this.config.maxInputChars,
        userRatePerMinute: this.config.userRatePerMinute,
        // Not enforced on this server before Phase 7b (AI_ORG_RATE_PER_MIN / AI_USER_TURNS_PER_DAY / the per-user cost
        // ceiling do not exist yet): 0 = "no such limit here". Contract request in handoff REQUEST.md (make them nullable).
        orgRatePerMinute: 0,
        userTurnsPerDay: 0,
        orgDailyTokenBudget: this.config.orgDailyTokenBudget,
        orgDailyCostCeilingMicros: this.config.dailyBudgetUsdMicros,
        userDailyCostCeilingMicros: 0,
      },
    };
  }

  /**
   * `GET /ai/settings/tools`: exactly `registry.catalogue()` (name, kind, permission, row cap) plus the fixed label, the
   * tool's own description (the same text the model is offered), the permission's catalogue description, and whether the
   * caller holds it RIGHT NOW (re-read from PostgreSQL, never the JWT). No schema internals, no arguments, no data.
   */
  async tools(ctx: AuthContext): Promise<AiToolCatalogueView> {
    return this.tenantContext.runInTenantContext(boundSettingsContext(ctx), async (m) => {
      await this.authorizeTx(m, ctx);
      const catalogue = this.registry.catalogue();
      // Phase 3 (p3 merge): meta tools (learn_tools, update_plan) carry no permission (null): every AI user has them.
      const flags = [...new Set(catalogue.map((t) => t.permission).filter((f): f is PermissionFlagType => f !== null))];
      const held = new Set<PermissionFlagType>();
      for (const flag of flags) if (await this.permissions.userHasPermissionTx(m, ctx, flag)) held.add(flag);
      const labels = await this.permissionLabels(m, flags);
      // p3 merge: the registry catalogue carries its own label, one-line summary, byte cap and parameters (CD-9). The
      // Phase 8 plain-language label wins where it exists; the summary is the catalogue line the model sees (3w).
      const tools: AiToolCatalogueEntryView[] = catalogue.map((t) => ({
        name: t.name,
        label: AI_TOOL_SETTINGS_LABEL[t.name] ?? t.label ?? t.name,
        summary: t.summary,
        kind: t.kind,
        permission: t.permission,
        permissionLabel: t.permission ? (labels.get(t.permission) ?? null) : null,
        held: t.permission === null || held.has(t.permission),
        maxRows: t.maxRows,
        maxBytes: t.maxBytes ?? null,
        requiresApproval: false,
        parameters: [...t.parameters],
      }));
      return { tools };
    });
  }

  /**
   * Layer 2, shared by every Phase 8 settings read (the prompt preview calls it too). Must run inside the caller's
   * tenant transaction.
   */
  async authorizeTx(m: EntityManager, ctx: AuthContext): Promise<void> {
    if (ctx.inspectedBy) throw new AiNotAvailableException();
    if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_SETTINGS))) {
      throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
    }
    const [row] = await m.query<Array<{ writer: boolean; enabled: boolean | null }>>(
      `SELECT core.ai_settings_writer() AS writer, (SELECT s.enabled FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS enabled`,
      [ctx.organisationId],
    );
    if (row?.writer !== true || !this.config.enabled || row.enabled !== true) throw new AiNotAvailableException();
  }

  /**
   * C1 (CD-10) at-a-glance counts — COUNTS ONLY, never content (rule 11.4):
   *   myConversations      the caller's OWN conversations (owner RLS on ai_conversation; the explicit user filter is a
   *                        second net — a CEO cannot count other people's threads);
   *   orgQuestionsThisMonth the organisation's turns this UTC month from `ai_usage_daily` (organisation RLS);
   *   activeSkills         filled by the overview from `AiSkillService.countActive` (p4 merge; 0 here);
   *   tools                the read tools the caller holds right now (the Phase 1 registry; Phase 3 replaces it).
   */
  private async counts(m: EntityManager, ctx: AuthContext): Promise<NonNullable<AiSettingsOverview['counts']>> {
    const [row] = await m.query<Array<{ mine: string; questions: string | null }>>(
      `SELECT (SELECT count(*) FROM core.ai_conversation c WHERE c.organisation_id = $1 AND c.user_id = $2) AS mine,
              (SELECT COALESCE(sum(u.turns), 0) FROM core.ai_usage_daily u
                WHERE u.organisation_id = $1 AND u.usage_date >= date_trunc('month', (now() AT TIME ZONE 'UTC'))::date) AS questions`,
      [ctx.organisationId, ctx.userId],
    );
    const catalogue = this.registry.catalogue();
    let tools = 0;
    for (const flag of new Set(catalogue.map((t) => t.permission))) {
      // A tool with no permission (Phase 3 meta tools) is available to every AI user.
      if (flag === null || (await this.permissions.userHasPermissionTx(m, ctx, flag))) tools += catalogue.filter((t) => t.permission === flag).length;
    }
    return { myConversations: Number(row?.mine ?? 0), orgQuestionsThisMonth: Number(row?.questions ?? 0), activeSkills: 0, tools };
  }

  /** The organisation's model pins (lookup keys only), read in the caller's tenant transaction (RLS-bound). */
  async readPins(m: EntityManager, organisationId: string): Promise<AiModelPins> {
    const rows = await m.query<Array<{ tier: string; model_id: string }>>(
      `SELECT tier, model_id FROM core.organisation_ai_model_preference WHERE organisation_id = $1`,
      [organisationId],
    );
    const pins: AiModelPins = {};
    for (const r of rows) if (isAiModelTier(r.tier)) pins[r.tier] = r.model_id;
    return pins;
  }

  /** The organisation's timezone (the prompt's local date), read in the caller's tenant transaction. */
  async readTimezone(m: EntityManager, organisationId: string): Promise<string> {
    const [row] = await m.query<Array<{ timezone: string | null }>>(`SELECT o.timezone FROM core.organisation o WHERE o.id = $1`, [organisationId]);
    // Same fallback as AiAccessService (the Worker's actor rebuild), so the preview equals what a turn would send.
    return row?.timezone || 'Europe/London';
  }

  /** `core.permission.description` (global reference data) for the given flags. */
  private async permissionLabels(m: EntityManager, flags: PermissionFlagType[]): Promise<Map<string, string>> {
    if (!flags.length) return new Map();
    const rows = await m.query<Array<{ key: string; description: string | null }>>(`SELECT key, description FROM core.permission WHERE key = ANY($1::text[])`, [flags]);
    return new Map(rows.filter((r) => r.description).map((r) => [r.key, r.description!]));
  }

  /**
   * The SDK tools a turn offers the model (3w: the fixed meta tools, the same `sdkToolDefinitions` the runner binds):
   * definitions only, never executed. `held` is accepted for symmetry; the meta set does not depend on it.
   */
  offeredTools(_held: ReadonlySet<PermissionFlagType>): ToolSet {
    return this.registry.sdkToolDefinitions();
  }

  /** Every permission flag a registered tool needs (the set the runner's session checker reads), deduplicated. */
  toolFlags(): PermissionFlagType[] {
    return [...new Set(this.registry.catalogue().flatMap((t) => (t.permission ? [t.permission] : [])))];
  }

  /** The permitted read tools as the system prompt's catalogue lists them (name-sorted, fixed text). */
  toolCatalogue(held: ReadonlySet<PermissionFlagType>): AiToolCatalogueLine[] {
    return this.registry.catalogueFor(held);
  }
}
