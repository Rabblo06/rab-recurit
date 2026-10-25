import { z } from 'zod';

import RAW_AI_MODELS from './ai-models.json';
import { AI_PROVIDER_REGISTRY, AI_REAL_PROVIDERS, AiProviderKeyEnv, AiRealProvider, ANTHROPIC_FIXED_BASE_URL } from './provider-keys';

/**
 * AI model catalogue (docs/ai/PHASE1_TWENTY_PLAN.md §3/§4, security spec 4.2). Two halves, deliberately separate:
 *
 *   FACTS — `ai-models.json` next to this file: provider, ids, label, tier, prices (input / cached input / cache write /
 *           output per 1M tokens, long-context row), context window, max output, region, `deprecated`, sources. It is
 *           committed CODE, not configuration: emitted into `dist` by tsc, validated here by a strict zod schema at
 *           import (a malformed file throws when the module loads — the process does not start), then frozen. There is
 *           no runtime download, no storage override, no custom endpoint, no free-form id from a user or a request.
 *
 *   APPROVAL — `AI_MODEL_APPROVALS` below, TypeScript only. A JSON edit cannot approve anything: the schema is `.strict()`
 *           and has no approval keys (`ai-catalogue-readiness.spec.ts` asserts that too). Two separate approvals
 *           (owner decision 1, 2026-10-25):
 *             - `approved`           — may be used in DEVELOPMENT, within `approval.scope`;
 *             - `productionApproved` — may be used in PRODUCTION, only after the release-checklist §3.7 items (signed DPA,
 *                                      zero retention, no training, region, sub-processors, DPIA, privacy notice) are
 *                                      RECORDED in docs/ai/CREWFLOW_AI_RELEASE_CHECKLIST.md. Dev approval never implies it.
 *           Exactly ONE model is approved: `anthropic-claude-haiku-5-5`, for development with synthetic data only (EX-1).
 *
 * A database pin (Settings → AI) is only a LOOKUP KEY into this frozen catalogue: the SDK only ever receives
 * `providerModelId` from here. Prices are converted to integer USD micros per 1,000,000 tokens ($0.10/MTok → 100_000)
 * with the regional uplift applied (D14: charge the higher price until the regional price is verified). Estimated cost
 * (`cost.ts`) is integer micro-USD — NOT money in the payroll sense (never `@rab/shared` money.ts or pence).
 */

/** `test` = an in-process model supplied ONLY by test modules (AI_TEST_MODEL_CATALOGUE, honoured only when NODE_ENV=test). */
export type AiCatalogueProvider = AiRealProvider | 'test';
export type AiModelTierName = 'fast' | 'smart';

export interface AiModelApproval {
  /** Who approved. */
  by: string;
  /** YYYY-MM-DD. */
  date: string;
  /** What the approval covers, verbatim from the owner. */
  scope: string;
}

/** Integer USD micros per 1,000,000 tokens, as CHARGED (regional uplift included). `cacheWrite` null = no separate price. */
export interface AiModelPrice {
  inputUsdMicrosPerMTok: number;
  cachedInputUsdMicrosPerMTok: number;
  cacheWriteUsdMicrosPerMTok: number | null;
  outputUsdMicrosPerMTok: number;
}

/** Fixed per-model provider options (code, never from a request). Only the keys the schema allows. */
export interface AiModelProviderOptions {
  anthropic?: { effort?: 'low' | 'medium' | 'high' };
}

export interface AiCatalogueModel {
  /** Crewflow id, `^[a-z0-9][a-z0-9._-]{0,99}$` (matches `ai_message_model_check` / `ai_usage_daily_model_check`). */
  readonly id: string;
  readonly provider: AiCatalogueProvider;
  /** Sent to the provider SDK. Lives only in code; never from a user, the database or a request. */
  readonly providerModelId: string;
  readonly label: string;
  readonly tier: AiModelTierName;
  /** The env variable holding this provider's key (secret). `null` for an in-process test model. */
  readonly apiKeyEnv: AiProviderKeyEnv | null;
  /** Whether this build contains the provider's SDK (AI_PROVIDER_REGISTRY). */
  readonly sdkInstalled: boolean;
  /** Fixed endpoint (never an env fallback). `null` for an in-process test model. */
  readonly baseURL: string | null;
  readonly contextWindowTokens: number;
  /** Provider ceiling per call. The gateway uses the lower of this and AI_MAX_OUTPUT_TOKENS. */
  readonly maxOutputTokens: number;
  readonly price: AiModelPrice;
  /** Higher price per token when one call's prompt (cache tokens included) exceeds the threshold (whole call at the long rate). */
  readonly longContext: (AiModelPrice & { thresholdInputTokens: number }) | null;
  /** Standard published prices before the uplift (USD per 1M), for display. */
  readonly publishedPriceUsdPerMTok: { input: number; cachedInput: number; cacheWrite: number | null; output: number };
  readonly regionalUpliftPercent: number;
  /** `global`, `eu` or `us`. */
  readonly region: 'global' | 'eu' | 'us';
  /** Human text for the settings page and the admin panel. */
  readonly dataRegion: string;
  readonly providerOptions: AiModelProviderOptions | null;
  /** Still usable when available, never offered for a NEW pin. */
  readonly deprecated: boolean;
  readonly approved: boolean;
  readonly approval: AiModelApproval | null;
  readonly productionApproved: boolean;
  readonly sources: readonly string[];
  /** YYYY-MM-DD the facts were checked. */
  readonly verifiedAt: string;
}

export const AI_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

const usd = z.number().finite().nonnegative().max(1000);
const priceRow = z.object({ input: usd, cachedInput: usd, cacheWrite: usd.nullable(), output: usd }).strict();
const modelFacts = z
  .object({
    id: z.string().regex(AI_MODEL_ID_PATTERN),
    provider: z.enum(AI_REAL_PROVIDERS),
    providerModelId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
    label: z.string().min(1).max(80),
    tier: z.enum(['fast', 'smart']),
    contextWindowTokens: z.number().int().positive().max(10_000_000),
    maxOutputTokens: z.number().int().positive().max(1_000_000),
    priceUsdPerMTok: priceRow,
    longContext: priceRow.extend({ thresholdInputTokens: z.number().int().positive() }).strict().nullable(),
    regionalUpliftPercent: z.number().int().min(0).max(100),
    region: z.enum(['global', 'eu', 'us']),
    dataRegion: z.string().min(1).max(300),
    baseURL: z.string().regex(/^https:\/\/[a-z0-9.-]+(?::\d+)?\/v1$/),
    providerOptions: z
      .object({ anthropic: z.object({ effort: z.enum(['low', 'medium', 'high']).optional() }).strict().optional() })
      .strict()
      .nullable(),
    deprecated: z.boolean(),
    sources: z.array(z.string().regex(/^https:\/\//)).min(1),
    verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
/** The schema of `ai-models.json`. Exported for its unit test. */
export const AI_MODELS_FILE_SCHEMA = z
  .object({ $comment: z.string().optional(), version: z.literal(1), models: z.array(modelFacts).min(1) })
  .strict()
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    for (const m of file.models) {
      if (ids.has(m.id)) ctx.addIssue({ code: 'custom', message: `duplicate model id ${m.id}` });
      ids.add(m.id);
      if (m.provider === 'anthropic' && m.baseURL !== ANTHROPIC_FIXED_BASE_URL) ctx.addIssue({ code: 'custom', message: `${m.id}: Anthropic models use the fixed endpoint` });
      if (m.providerOptions?.anthropic && m.provider !== 'anthropic') ctx.addIssue({ code: 'custom', message: `${m.id}: anthropic options on a non-Anthropic model` });
    }
  });
type AiModelFacts = z.infer<typeof modelFacts>;

export const AI_HAIKU_MODEL_ID = 'anthropic-claude-haiku-5-5';

/**
 * SECURITY APPROVALS — code only (PHASE1_TWENTY_PLAN §4 state 1). A model missing here is `approved: false`,
 * `productionApproved: false`. Changing this object is a security decision: a reviewed commit, recorded in
 * THREAT-MODEL.md and the security spec (EX-1 controls table, control 1).
 */
export const AI_MODEL_APPROVALS: Readonly<Record<string, { approved: boolean; approval: AiModelApproval | null; productionApproved: boolean }>> = Object.freeze({
  [AI_HAIKU_MODEL_ID]: Object.freeze({
    approved: true,
    approval: Object.freeze({ by: 'owner', date: '2026-10-25', scope: 'development, synthetic data only, pending provider checklist 3.7' }),
    productionApproved: false,
  }),
});

/** USD/MTok → integer micros/MTok with the regional uplift, rounded UP (the meter may only over-estimate). */
export function chargedMicros(usdPerMTok: number, upliftPercent: number): number {
  const micros = Math.round(usdPerMTok * 1_000_000);
  return Math.ceil((micros * (100 + upliftPercent)) / 100);
}

function chargedPrice(row: { input: number; cachedInput: number; cacheWrite: number | null; output: number }, uplift: number): AiModelPrice {
  return Object.freeze({
    inputUsdMicrosPerMTok: chargedMicros(row.input, uplift),
    cachedInputUsdMicrosPerMTok: chargedMicros(row.cachedInput, uplift),
    cacheWriteUsdMicrosPerMTok: row.cacheWrite === null ? null : chargedMicros(row.cacheWrite, uplift),
    outputUsdMicrosPerMTok: chargedMicros(row.output, uplift),
  });
}

function toModel(f: AiModelFacts): AiCatalogueModel {
  const provider = AI_PROVIDER_REGISTRY[f.provider];
  const approval = AI_MODEL_APPROVALS[f.id];
  return Object.freeze({
    id: f.id,
    provider: f.provider,
    providerModelId: f.providerModelId,
    label: f.label,
    tier: f.tier,
    apiKeyEnv: provider.keyEnv,
    sdkInstalled: provider.sdkInstalled,
    baseURL: f.baseURL,
    contextWindowTokens: f.contextWindowTokens,
    maxOutputTokens: f.maxOutputTokens,
    price: chargedPrice(f.priceUsdPerMTok, f.regionalUpliftPercent),
    longContext: f.longContext
      ? Object.freeze({ ...chargedPrice(f.longContext, f.regionalUpliftPercent), thresholdInputTokens: f.longContext.thresholdInputTokens })
      : null,
    publishedPriceUsdPerMTok: Object.freeze({ ...f.priceUsdPerMTok }),
    regionalUpliftPercent: f.regionalUpliftPercent,
    region: f.region,
    dataRegion: f.dataRegion,
    providerOptions: f.providerOptions ? (JSON.parse(JSON.stringify(f.providerOptions)) as AiModelProviderOptions) : null,
    deprecated: f.deprecated,
    approved: approval?.approved === true,
    approval: approval?.approval ?? null,
    productionApproved: approval?.productionApproved === true,
    sources: Object.freeze([...f.sources]),
    verifiedAt: f.verifiedAt,
  });
}

/** Parses and freezes a catalogue file. Throws on any schema violation (the module, and so the process, refuses to load). */
export function loadAiModelCatalogue(raw: unknown): readonly AiCatalogueModel[] {
  const parsed = AI_MODELS_FILE_SCHEMA.safeParse(raw);
  if (!parsed.success) throw new Error(`ai-models.json is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const models = parsed.data.models.map(toModel);
  for (const id of Object.keys(AI_MODEL_APPROVALS)) {
    if (!models.some((m) => m.id === id)) throw new Error(`AI_MODEL_APPROVALS names ${id}, which is not in ai-models.json`);
  }
  return Object.freeze(models);
}

/** The production catalogue (facts + approvals), frozen at import. */
export const AI_MODEL_CATALOGUE: readonly AiCatalogueModel[] = loadAiModelCatalogue(RAW_AI_MODELS);

export const AI_CATALOGUE_IDS: readonly string[] = Object.freeze(AI_MODEL_CATALOGUE.map((m) => m.id));

export function catalogueEntry(id: string | null | undefined, catalogue: readonly AiCatalogueModel[] = AI_MODEL_CATALOGUE): AiCatalogueModel | null {
  if (!id) return null;
  return catalogue.find((m) => m.id === id) ?? null;
}

/** A model that leaves the process (anything but an in-process test model). */
export function isRealProvider(model: Pick<AiCatalogueModel, 'provider'>): boolean {
  return model.provider !== 'test';
}

/**
 * Validates entries a TEST module supplies through AI_TEST_MODEL_CATALOGUE (never production: the token is honoured only
 * when NODE_ENV=test). Each must be an in-process `test` model with no key, no endpoint and an id that does not shadow a
 * production entry. Returns frozen copies; throws on anything else.
 */
export function validateTestModels(entries: readonly AiCatalogueModel[]): readonly AiCatalogueModel[] {
  return Object.freeze(
    entries.map((e) => {
      if (e.provider !== 'test' || e.apiKeyEnv !== null || e.baseURL !== null || !AI_MODEL_ID_PATTERN.test(e.id) || AI_CATALOGUE_IDS.includes(e.id)) {
        throw new Error(`AI_TEST_MODEL_CATALOGUE: ${e.id} is not a valid in-process test model`);
      }
      return Object.freeze({ ...e, price: Object.freeze({ ...e.price }), longContext: e.longContext ? Object.freeze({ ...e.longContext }) : null });
    }),
  );
}
