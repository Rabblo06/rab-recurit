import { AI_MODEL_STATE_LABEL, AI_MODEL_TIERS, AiModelSettingsView, AiModelTier, AiModelView, AiTierSettingView, PermissionFlag } from '@rab/shared';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AiAvailabilityContext, AiModelPins, AiModelStateCode, isUsableState, modelState, resolveModel, setupNeeded } from '../../../engine/core-modules/ai/ai-readiness';
import { AiCatalogueModel } from '../../../engine/core-modules/ai/models/catalog';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { StepUpReauthService } from '../../../engine/core-modules/auth/services/step-up-reauth.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiModelNotAvailableException, AiNotAvailableException } from '../exceptions/ai.exceptions';
import { AiConfigService } from './ai-config.service';

const micros = (n: number) => n / 1_000_000;

/** One catalogue model as Settings → AI and the Admin Panel show it: facts + platform state. Never a key. */
export function toModelView(model: AiCatalogueModel, state: AiModelStateCode): AiModelView {
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
    state,
    stateLabel: AI_MODEL_STATE_LABEL[state],
    selectable: state === 'available',
  };
}

export function isAiModelTier(value: string): value is AiModelTier {
  return (AI_MODEL_TIERS as readonly string[]).includes(value);
}

interface PinRow {
  tier: string;
  model_id: string;
  updated_at: Date;
}

/**
 * Settings → AI "AI models" (docs/ai/PHASE1_TWENTY_PLAN.md §7, D6/D7): the organisation's CEO chooses the model of each
 * tier among the models that are BOTH security-approved in code AND available on the platform, or "Choose
 * automatically" (no pin). The pin is a LOOKUP KEY into the frozen catalogue — re-validated on write (here) and on every
 * use (the resolver skips a stale pin); the SDK only ever receives `providerModelId` from code.
 *
 * Five layers:
 *   1. controller: JwtAuthGuard + @ManagerApplication + PermissionGuard(ai.settings);
 *   2. this service: refuses Admin Inspect, re-checks `ai.settings` from the database, requires the bound user to be the
 *      organisation's CEO (`core.ai_settings_writer()`), the platform kill switch and the organisation's AI switch
 *      (anything else is the uniform 404), and for a write a recent STEP-UP (`organisation.ai.model.update`) and a reason;
 *   3. every query is scoped to the caller's organisation;
 *   4. RLS (FORCE) on `core.organisation_ai_model_preference`: rows of the bound organisation only;
 *   5. INSERT/UPDATE/DELETE additionally require `core.ai_settings_writer()` — a custom role carrying the flag grants
 *      nothing to a non-CEO (AiModelPreference1786720250000).
 * Every write is audited `ai.default_changed {tier, from, to, reason}` in the same transaction.
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

  async view(ctx: AuthContext): Promise<AiModelSettingsView> {
    return this.tenantContext.runInTenantContext(this.bound(ctx), async (m) => {
      await this.authorizeTx(m, ctx);
      return this.buildView(await this.readPins(m, ctx.organisationId!));
    });
  }

  /** Pins `modelId` as the organisation's model for `tier` (a named action, never a raw state). */
  async pin(ctx: AuthContext, tier: string, modelId: string, reason: string): Promise<AiModelSettingsView> {
    return this.write(ctx, tier, reason, modelId);
  }

  /** "Choose automatically": removes the tier's pin. */
  async unpin(ctx: AuthContext, tier: string, reason: string): Promise<AiModelSettingsView> {
    return this.write(ctx, tier, reason, null);
  }

  private async write(ctx: AuthContext, tier: string, reason: string, modelId: string | null): Promise<AiModelSettingsView> {
    if (!isAiModelTier(tier)) throw new AiNotAvailableException();
    // Authorisation first (a stranger learns nothing and is not asked to step up), then the step-up, then the input.
    await this.tenantContext.runInTenantContext(this.bound(ctx), (m) => this.authorizeTx(m, ctx));
    await this.stepUp.assertRecentStepUp(ctx, 'organisation.ai.model.update');
    if (modelId !== null) {
      const entry = this.config.entry(modelId);
      // Only a model that is AVAILABLE right now (approved, in the build, keyed, not disabled, environment permits — and
      // not deprecated) of THIS tier may become a new pin. Unknown / unavailable / wrong tier: one fixed 400.
      if (!entry || entry.tier !== tier || this.config.modelState(entry) !== 'available') throw new AiModelNotAvailableException();
    }
    return this.tenantContext.runInTenantContext(this.bound(ctx), async (m) => {
      await this.authorizeTx(m, ctx);
      const [before] = await m.query<Array<{ model_id: string }>>(
        `SELECT model_id FROM core.organisation_ai_model_preference WHERE organisation_id = $1 AND tier = $2 FOR UPDATE`,
        [ctx.organisationId, tier],
      );
      if (modelId === null) {
        await m.query(`DELETE FROM core.organisation_ai_model_preference WHERE organisation_id = $1 AND tier = $2`, [ctx.organisationId, tier]);
      } else {
        await m.query(
          `INSERT INTO core.organisation_ai_model_preference (organisation_id, tier, model_id, updated_by, reason) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (organisation_id, tier) DO UPDATE SET model_id = EXCLUDED.model_id, updated_by = EXCLUDED.updated_by, reason = EXCLUDED.reason, updated_at = now()`,
          [ctx.organisationId, tier, modelId, ctx.userId, reason],
        );
      }
      await this.audit.record(m, ctx, AuditAction.AI_DEFAULT_CHANGED, {
        entityType: 'organisation',
        entityId: ctx.organisationId!,
        metadata: { tier, from: before?.model_id ?? null, to: modelId, reason },
      });
      return this.buildView(await this.readPins(m, ctx.organisationId!));
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

  private buildView(rows: PinRow[]): AiModelSettingsView {
    const ctx: AiAvailabilityContext = this.config.availabilityContext();
    const pins: AiModelPins = {};
    for (const r of rows) if (isAiModelTier(r.tier)) pins[r.tier] = r.model_id;
    const models = this.config.catalogue.map((model) => toModelView(model, modelState(model, ctx)));
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
    return { models, tiers, setup: resolveModel('fast', pins, ctx) ? null : setupNeeded(ctx) };
  }
}
