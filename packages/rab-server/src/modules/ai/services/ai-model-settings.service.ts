import {
  AI_MODEL_LEVELS,
  AI_MODEL_STATE_LABEL,
  AI_MODEL_TIERS,
  AiAvailabilityLevelsView,
  AiLevelView,
  AiModelLevel,
  AiModelPolicyUpdateRequest,
  AiModelPolicyView,
  AiModelSettingsViewV2,
  AiModelTier,
  AiModelView,
  AiModelViewV2,
  AiTierSettingView,
  PermissionFlag,
} from '@rab/shared';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AiLevelPinsFacts, AiLevelResult, AiModelPolicyFacts, isAiModelLevel, levelPinsFromRows, policyFromRow, residencyAllows } from '../../../engine/core-modules/ai/ai-levels';
import { AiAvailabilityContext, AiModelPins, AiModelStateCode, isUsableState, modelState, resolveModel, setupNeeded } from '../../../engine/core-modules/ai/ai-readiness';
import { AiCatalogueModel } from '../../../engine/core-modules/ai/models/catalog';
import { worstCaseStepUsdMicros } from '../../../engine/core-modules/ai/models/cost';
import { AI_LEVEL_DEFINITIONS, verifiedEfforts } from '../../../engine/core-modules/ai/models/model-levels';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { StepUpReauthService } from '../../../engine/core-modules/auth/services/step-up-reauth.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AI_STEP_INPUT_TOKEN_ALLOWANCE } from '../constants/ai.constants';
import { AiModelNotAvailableException, AiNotAvailableException } from '../exceptions/ai.exceptions';
import { AiConfigService } from './ai-config.service';

const micros = (n: number) => n / 1_000_000;

/** One catalogue model as Settings → AI and the Admin Panel show it: facts + platform state (+ the Phase 7 `promptCache` fact). Never a key. */
export function toModelView(model: AiCatalogueModel, state: AiModelStateCode): AiModelView & Pick<AiModelViewV2, 'promptCache'> {
  return {
    id: model.id,
    label: model.label,
    provider: model.provider,
    tier: model.tier,
    region: model.region,
    dataRegion: model.dataRegion,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    // As CHARGED by the budget meter (regional uplift included, D14).
    priceUsdPerMTok: {
      input: micros(model.price.inputUsdMicrosPerMTok),
      cachedInput: micros(model.price.cachedInputUsdMicrosPerMTok),
      cacheWrite: model.price.cacheWriteUsdMicrosPerMTok === null ? null : micros(model.price.cacheWriteUsdMicrosPerMTok),
      output: micros(model.price.outputUsdMicrosPerMTok),
    },
    deprecated: model.deprecated,
    promptCache: model.promptCache,
    state,
    stateLabel: AI_MODEL_STATE_LABEL[state],
    selectable: state === 'available',
  };
}

/** C1 / CD-1 + Phase 7: the V2 model view (catalogue `promptCache` fact, VERIFIED efforts, sources, verifiedAt). */
export function toModelViewV2(model: AiCatalogueModel, state: AiModelStateCode): AiModelViewV2 {
  return { ...toModelView(model, state), supportedEfforts: [...verifiedEfforts(model)], sources: [...model.sources], verifiedAt: model.verifiedAt };
}

export function isAiModelTier(value: string): value is AiModelTier {
  return (AI_MODEL_TIERS as readonly string[]).includes(value);
}

interface PinRow {
  tier: string;
  model_id: string;
  updated_at: Date;
}

type PolicyWithDate = AiModelPolicyFacts & { updatedAt: string | null };

/**
 * Settings → AI "AI models" (docs/ai/PHASE1_TWENTY_PLAN.md §7, D6/D7; C1 / TWENTY_UI_CONTRACT_DELTAS CD-1 / CD-2): the
 * organisation's CEO chooses the model of each LEVEL among the models that are security-approved in code AND available on
 * the platform AND support the level's effort as a verified fact, or "Choose automatically" (no pin); and the model
 * policy (chat level, allowed levels, residency). The pin is a LOOKUP KEY into the frozen catalogue — re-validated on write
 * (here) and on every use (the one level resolver skips a stale pin); the SDK only ever receives `providerModelId`.
 *
 * Five layers:
 *   1. controller: JwtAuthGuard + @ManagerApplication + PermissionGuard(ai.settings);
 *   2. this service: refuses Admin Inspect, re-checks `ai.settings` from the database, requires the bound user to be the
 *      organisation's CEO (`core.ai_settings_writer()`), the platform kill switch and the organisation's AI switch
 *      (anything else is the uniform 404), and for a write a recent STEP-UP (`organisation.ai.model.update`) and a reason;
 *   3. every query is scoped to the caller's organisation;
 *   4. RLS (FORCE) on `organisation_ai_model_preference` / `organisation_ai_model_policy`: the bound organisation only;
 *   5. INSERT/UPDATE/DELETE additionally require `core.ai_settings_writer()` — a custom role carrying the flag grants
 *      nothing to a non-CEO.
 * Every write is audited (`ai.default_changed {tier, from, to, reason}`, `ai.model_policy_changed {from, to, reason}`) in
 * the same transaction.
 */
@Injectable()
export class AiModelSettingsService {
  constructor(
    private readonly config: AiConfigService,
    private readonly permissions: PermissionsService,
    private readonly stepUp: StepUpReauthService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async view(ctx: AuthContext): Promise<AiModelSettingsViewV2> {
    return this.tenantContext.runInTenantContext(this.bound(ctx), async (m) => {
      await this.authorizeTx(m, ctx);
      return this.buildView(await this.readPins(m, ctx.organisationId!), await this.readPolicy(m, ctx.organisationId!));
    });
  }

  /** Pins `modelId` as the organisation's model for a level key (a named action, never a raw state). */
  async pin(ctx: AuthContext, level: string, modelId: string, reason: string): Promise<AiModelSettingsViewV2> {
    return this.write(ctx, level, reason, modelId);
  }

  /** "Choose automatically": removes the level's pin. */
  async unpin(ctx: AuthContext, level: string, reason: string): Promise<AiModelSettingsViewV2> {
    return this.write(ctx, level, reason, null);
  }

  /**
   * `PUT /ai/settings/model-policy`: chat level, agent level (shown disabled until EX-3), allowed levels, data residency.
   * Same layers and step-up as a pin; reason required; audited `ai.model_policy_changed` with old/new enum values only.
   */
  async updatePolicy(ctx: AuthContext, dto: AiModelPolicyUpdateRequest): Promise<AiModelSettingsViewV2> {
    await this.tenantContext.runInTenantContext(this.bound(ctx), (m) => this.authorizeTx(m, ctx));
    await this.stepUp.assertRecentStepUp(ctx, 'organisation.ai.model.update');
    return this.tenantContext.runInTenantContext(this.bound(ctx), async (m) => {
      await this.authorizeTx(m, ctx);
      const before = await this.readPolicy(m, ctx.organisationId!);
      const allowedLevels = dto.allowedLevels ? AI_MODEL_LEVELS.map((l) => l.level).filter((l) => dto.allowedLevels!.includes(l)) : [...before.allowedLevels];
      const next: AiModelPolicyFacts = {
        chatLevel: dto.chatLevel ?? before.chatLevel,
        agentLevel: dto.agentLevel ?? before.agentLevel,
        allowedLevels,
        dataResidency: dto.dataResidency ?? before.dataResidency,
      };
      // The chat level must be one the users may pick (the DB CHECK says the same): one fixed 400 otherwise.
      if (allowedLevels.length === 0 || !allowedLevels.includes(next.chatLevel)) throw new AiModelNotAvailableException();
      await m.query(
        `INSERT INTO core.organisation_ai_model_policy (organisation_id, chat_level, agent_level, allowed_levels, data_residency, updated_by, reason)
         VALUES ($1, $2, $3, $4::text[], $5, $6, $7)
         ON CONFLICT (organisation_id) DO UPDATE SET chat_level = EXCLUDED.chat_level, agent_level = EXCLUDED.agent_level,
           allowed_levels = EXCLUDED.allowed_levels, data_residency = EXCLUDED.data_residency, updated_by = EXCLUDED.updated_by,
           reason = EXCLUDED.reason, updated_at = now()`,
        [ctx.organisationId, next.chatLevel, next.agentLevel, [...next.allowedLevels], next.dataResidency, ctx.userId, dto.reason],
      );
      const plain = (p: AiModelPolicyFacts) => ({ chatLevel: p.chatLevel, agentLevel: p.agentLevel, allowedLevels: [...p.allowedLevels], dataResidency: p.dataResidency });
      await this.audit.record(m, ctx, AuditAction.AI_MODEL_POLICY_CHANGED, {
        entityType: 'organisation',
        entityId: ctx.organisationId!,
        metadata: { from: plain(before), to: plain(next), reason: dto.reason },
      });
      return this.buildView(await this.readPins(m, ctx.organisationId!), await this.readPolicy(m, ctx.organisationId!));
    });
  }

  /**
   * The composer's level picker for any `ai.use` user (part of `GET /ai/availability`), inside the caller's own tenant
   * transaction (RLS: the bound organisation's policy and pins). No model id or price is disclosed here.
   */
  async availabilityLevels(m: EntityManager, organisationId: string, synthetic: boolean): Promise<AiAvailabilityLevelsView> {
    const policy = await this.readPolicy(m, organisationId);
    const pins = levelPinsFromRows(await this.readPins(m, organisationId));
    return {
      chatLevel: policy.chatLevel,
      options: AI_MODEL_LEVELS.filter((l) => policy.allowedLevels.includes(l.level)).map((l) => {
        const r = this.config.resolveLevel(l.level, policy, pins, { synthetic });
        return { level: l.level, label: l.label, bars: l.bars, available: r.ok, unavailableReason: r.ok ? null : r.reason };
      }),
    };
  }

  private async write(ctx: AuthContext, key: string, reason: string, modelId: string | null): Promise<AiModelSettingsViewV2> {
    // The path key is a LEVEL key (the five levels; existing `fast` / `smart` pins are level keys). Unknown = uniform 404.
    if (!isAiModelLevel(key)) throw new AiNotAvailableException();
    // Authorisation first (a stranger learns nothing and is not asked to step up), then the step-up, then the input.
    await this.tenantContext.runInTenantContext(this.bound(ctx), (m) => this.authorizeTx(m, ctx));
    await this.stepUp.assertRecentStepUp(ctx, 'organisation.ai.model.update');
    if (modelId !== null) {
      const entry = this.config.entry(modelId);
      const def = AI_LEVEL_DEFINITIONS[key];
      // Only a model AVAILABLE right now (approved, in the build, keyed, not disabled, environment permits, not deprecated)
      // of the level's tier, whose VERIFIED efforts include the level's effort, may become a new pin. One fixed 400.
      if (!entry || entry.tier !== def.tier || this.config.modelState(entry) !== 'available' || !verifiedEfforts(entry).includes(def.effort)) {
        throw new AiModelNotAvailableException();
      }
    }
    return this.tenantContext.runInTenantContext(this.bound(ctx), async (m) => {
      await this.authorizeTx(m, ctx);
      const [before] = await m.query<Array<{ model_id: string }>>(
        `SELECT model_id FROM core.organisation_ai_model_preference WHERE organisation_id = $1 AND tier = $2 FOR UPDATE`,
        [ctx.organisationId, key],
      );
      if (modelId === null) {
        await m.query(`DELETE FROM core.organisation_ai_model_preference WHERE organisation_id = $1 AND tier = $2`, [ctx.organisationId, key]);
      } else {
        await m.query(
          `INSERT INTO core.organisation_ai_model_preference (organisation_id, tier, model_id, updated_by, reason) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (organisation_id, tier) DO UPDATE SET model_id = EXCLUDED.model_id, updated_by = EXCLUDED.updated_by, reason = EXCLUDED.reason, updated_at = now()`,
          [ctx.organisationId, key, modelId, ctx.userId, reason],
        );
      }
      await this.audit.record(m, ctx, AuditAction.AI_DEFAULT_CHANGED, {
        entityType: 'organisation',
        entityId: ctx.organisationId!,
        metadata: { tier: key, from: before?.model_id ?? null, to: modelId, reason },
      });
      return this.buildView(await this.readPins(m, ctx.organisationId!), await this.readPolicy(m, ctx.organisationId!));
    });
  }

  /** The caller's own tenant context (never platform/owner context). */
  private bound(ctx: AuthContext): AuthContext {
    if (ctx.inspectedBy || !ctx.organisationId) throw new AiNotAvailableException();
    return { ...ctx, role: '' };
  }

  /**
   * Layer 2. Admin Inspect is refused before anything (bound()). `ai.settings` is re-read from the database (403 like the
   * guard); then a non-CEO, the platform kill switch or the organisation's AI switch are the same uniform 404.
   */
  private async authorizeTx(m: EntityManager, ctx: AuthContext): Promise<void> {
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

  private async readPins(m: EntityManager, organisationId: string): Promise<PinRow[]> {
    return m.query<PinRow[]>(`SELECT tier, model_id, updated_at FROM core.organisation_ai_model_preference WHERE organisation_id = $1 ORDER BY tier`, [organisationId]);
  }

  private async readPolicy(m: EntityManager, organisationId: string): Promise<PolicyWithDate> {
    const [row] = await m.query<Array<Record<string, unknown>>>(
      `SELECT chat_level, agent_level, allowed_levels, data_residency, updated_at FROM core.organisation_ai_model_policy WHERE organisation_id = $1`,
      [organisationId],
    );
    return { ...policyFromRow(row ?? null), updatedAt: row?.updated_at ? new Date(row.updated_at as string).toISOString() : null };
  }

  private buildView(rows: PinRow[], policy: PolicyWithDate): AiModelSettingsViewV2 {
    const ctx: AiAvailabilityContext = this.config.availabilityContext();
    const pins: AiModelPins = {};
    for (const r of rows) if (isAiModelTier(r.tier)) pins[r.tier] = r.model_id;
    const levelPins: AiLevelPinsFacts = levelPinsFromRows(rows);
    const models = this.config.catalogue.map((model) => toModelViewV2(model, modelState(model, ctx)));
    // Phase 1 shape, kept one release.
    const tiers: AiTierSettingView[] = AI_MODEL_TIERS.map((tier) => {
      const row = rows.find((r) => r.tier === tier);
      const pinned = row ? this.config.entry(row.model_id) : null;
      const resolved = resolveModel(tier, pins, ctx);
      return {
        tier,
        pinnedModelId: row?.model_id ?? null,
        pinUnusable: Boolean(row) && !(pinned && pinned.tier === tier && isUsableState(modelState(pinned, ctx))),
        resolved: resolved ? { id: resolved.model.id, label: resolved.model.label, source: resolved.source } : null,
        updatedAt: row ? new Date(row.updated_at).toISOString() : null,
      };
    });
    // The CEO's own organisation; displayed with synthetic=true only for the post-3.7 residency rule (inactive today);
    // every turn re-applies it with the organisation's real marker (AiAccessService).
    const results = new Map<AiModelLevel, AiLevelResult>(AI_MODEL_LEVELS.map((l) => [l.level, this.config.resolveLevel(l.level, policy, levelPins, { synthetic: true })]));
    const chat = results.get(policy.chatLevel)!;
    const blended = (r: AiLevelResult) => (r.ok ? (3 * r.resolution.model.price.inputUsdMicrosPerMTok + r.resolution.model.price.outputUsdMicrosPerMTok) / 4 : null);
    const chatBlended = blended(chat);
    const levels: AiLevelView[] = AI_MODEL_LEVELS.map((l) => {
      const def = AI_LEVEL_DEFINITIONS[l.level];
      const r = results.get(l.level)!;
      const row = rows.find((p) => p.tier === l.level);
      const pinned = row ? this.config.entry(row.model_id) : null;
      const pinUsable =
        pinned !== null && pinned.tier === def.tier && isUsableState(modelState(pinned, ctx)) && verifiedEfforts(pinned).includes(def.effort) && residencyAllows(pinned, policy.dataResidency);
      const model = r.ok ? r.resolution.model : null;
      const mine = blended(r);
      const allowed = policy.allowedLevels.includes(l.level);
      return {
        level: l.level,
        label: l.label,
        bars: l.bars,
        tier: def.tier,
        effort: def.effort,
        maxOutputTokens: def.maxOutputTokens,
        allowed,
        pinnedModelId: row?.model_id ?? null,
        pinUnusable: Boolean(row) && !pinUsable,
        resolved: r.ok ? { id: r.resolution.model.id, label: r.resolution.model.label, source: r.resolution.source } : null,
        unavailableReason: r.ok ? (allowed ? null : 'not_allowed') : r.reason,
        priceUsdPerMTok: model ? toModelView(model, 'available').priceUsdPerMTok : null,
        contextWindowTokens: model ? model.contextWindowTokens : null,
        estimate: model
          ? {
              per100QuestionsUpperBoundMicros: 100 * this.config.maxSteps * worstCaseStepUsdMicros(model, AI_STEP_INPUT_TOKEN_ALLOWANCE, def.maxOutputTokens),
              assumptions: `Up to: 100 questions, each at most ${this.config.maxSteps} model steps of ${AI_STEP_INPUT_TOKEN_ALLOWANCE} input and ${def.maxOutputTokens} output tokens, at list prices. Estimated, not an invoice.`,
            }
          : null,
        priceRatio: mine !== null && chatBlended ? Math.round((mine / chatBlended) * 100) / 100 : null,
      };
    });
    const policyView: AiModelPolicyView = {
      chatLevel: policy.chatLevel,
      agentLevel: policy.agentLevel,
      allowedLevels: [...policy.allowedLevels],
      dataResidency: policy.dataResidency,
      updatedAt: policy.updatedAt,
    };
    const setup = chat.ok ? null : chat.reason === 'residency' ? 'residency' : setupNeeded(ctx);
    return { models, levels, policy: policyView, setup, tiers };
  }
}
