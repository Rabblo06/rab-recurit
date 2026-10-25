import { ANTHROPIC_API_KEY_ENV, ANTHROPIC_FIXED_BASE_URL, AiProviderKeyEnv } from './provider-keys';

/**
 * AI model catalogue (docs/ai/REAL_PROVIDER_PLAN.md §4, security spec 4.2). Frozen code, never configuration: there is
 * no runtime download, no storage override, no custom endpoint and no free-form model id from a user, a request or the
 * database. A model becomes usable ONLY through a reviewed commit that records an approval here.
 *
 * Two separate approvals (owner decision 1, 2026-10-25):
 *   - `approved`            — may be used in DEVELOPMENT, within `approval.scope`.
 *   - `productionApproved`  — may be used in PRODUCTION. Requires the release-checklist §3.7 items (signed DPA, zero
 *                             retention, no training, region, sub-processors, DPIA, privacy notice) to be RECORDED in
 *                             docs/ai/CREWFLOW_AI_RELEASE_CHECKLIST.md first. Dev approval never implies it.
 *
 * Exactly ONE entry is approved: `anthropic-claude-haiku-5-5`, for development with synthetic data only. Every other
 * entry is `approved: false`. The in-process mock is not a provider and needs no provider approval (see its entry).
 *
 * Prices are integer USD micros per 1,000,000 tokens ($0.10/MTok → 100_000). Estimated cost is integer micro-USD
 * (`cost.ts`). This is NOT money in the payroll sense: it never touches `@rab/shared` money.ts or pence.
 */
export type AiCatalogueProvider = 'mock' | 'anthropic' | 'openai';

export interface AiModelApproval {
  /** Who approved. */
  by: string;
  /** YYYY-MM-DD. */
  date: string;
  /** What the approval covers, verbatim from the owner. */
  scope: string;
}

export interface AiModelPrice {
  inputUsdMicrosPerMTok: number;
  outputUsdMicrosPerMTok: number;
}

export interface AiCatalogueModel {
  /** Crewflow id, `^[a-z0-9][a-z0-9._-]{0,99}$` (matches `ai_message_model_check` / `ai_usage_daily_model_check`). */
  readonly id: string;
  readonly provider: AiCatalogueProvider;
  /** Sent to the provider SDK. Lives only in code; never from a user, the database or a request. */
  readonly providerModelId: string;
  readonly label: string;
  /** The env variable holding this model's key (secret). `null`: no key needed (mock) or no SDK in this build. */
  readonly apiKeyEnv: AiProviderKeyEnv | null;
  /** Whether this build contains the provider's SDK (only `@ai-sdk/anthropic` is installed in Part A). */
  readonly sdkInstalled: boolean;
  /** Fixed endpoint (never an env fallback). `null` for the in-process mock. */
  readonly baseURL: string | null;
  readonly contextWindowTokens: number | null;
  /** Provider ceiling per call. `null` = AI_MAX_OUTPUT_TOKENS alone (mock). The gateway uses the lower of the two. */
  readonly maxOutputTokens: number | null;
  readonly price: AiModelPrice;
  /** Higher price per token when one call's prompt exceeds the threshold (whole call priced at the long rate). */
  readonly longContext: (AiModelPrice & { thresholdInputTokens: number }) | null;
  /** Human text for the admin panel. */
  readonly dataRegion: string;
  readonly approved: boolean;
  readonly approval: AiModelApproval | null;
  readonly productionApproved: boolean;
  /** In-process test model: refused in production at boot. */
  readonly devOnly: boolean;
  readonly sources: readonly string[];
  /** YYYY-MM-DD the facts were checked. */
  readonly verifiedAt: string;
}

const ANTHROPIC_SOURCES = Object.freeze([
  'https://platform.claude.com/docs/en/models/overview',
  'https://platform.claude.com/docs/en/about-claude/pricing',
]);
const OPENAI_SOURCES = Object.freeze(['https://developers.openai.com/api/docs/models', 'https://developers.openai.com/api/docs/guides/your-data']);
const ANTHROPIC_REGION = 'Global routing on the Claude API (inference_geo "us" or "global" only; no UK/EU option).';

export const AI_MOCK_MODEL_ID = 'crewflow-mock-1';
export const AI_HAIKU_MODEL_ID = 'anthropic-claude-haiku-5-5';

/** The default model when AI_MODEL is unset (owner decision 1). Production still refuses it (`productionApproved`). */
export const AI_DEFAULT_MODEL_ID = AI_HAIKU_MODEL_ID;

const entry = (e: AiCatalogueModel): AiCatalogueModel => Object.freeze({ ...e, price: Object.freeze({ ...e.price }), longContext: e.longContext ? Object.freeze({ ...e.longContext }) : null });

export const AI_MODEL_CATALOGUE: readonly AiCatalogueModel[] = Object.freeze([
  entry({
    id: AI_MOCK_MODEL_ID,
    provider: 'mock',
    providerModelId: AI_MOCK_MODEL_ID,
    label: 'Crewflow deterministic mock',
    apiKeyEnv: null,
    sdkInstalled: true,
    baseURL: null,
    contextWindowTokens: null,
    maxOutputTokens: null,
    price: { inputUsdMicrosPerMTok: 0, outputUsdMicrosPerMTok: 0 },
    longContext: null,
    dataRegion: 'In-process, no network.',
    // Not a provider: nothing leaves the process, so there is no provider approval to record. It runs in development and
    // test without one (readiness: `devOnly` in-process models are exempt from the approval gate) and production refuses
    // it at boot.
    approved: false,
    approval: null,
    productionApproved: false,
    devOnly: true,
    sources: Object.freeze(['packages/rab-server/src/modules/ai/gateway/deterministic-mock-model.ts']),
    verifiedAt: '2026-10-25',
  }),
  entry({
    id: AI_HAIKU_MODEL_ID,
    provider: 'anthropic',
    providerModelId: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    apiKeyEnv: ANTHROPIC_API_KEY_ENV,
    sdkInstalled: true,
    baseURL: ANTHROPIC_FIXED_BASE_URL,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    price: { inputUsdMicrosPerMTok: 100_000, outputUsdMicrosPerMTok: 500_000 },
    longContext: { thresholdInputTokens: 100_000, inputUsdMicrosPerMTok: 500_000, outputUsdMicrosPerMTok: 2_500_000 },
    dataRegion: ANTHROPIC_REGION,
    approved: true,
    approval: { by: 'owner', date: '2026-10-25', scope: 'development, synthetic data only, pending provider checklist 3.7' },
    productionApproved: false,
    devOnly: false,
    sources: ANTHROPIC_SOURCES,
    verifiedAt: '2026-10-25',
  }),
  entry({
    id: 'anthropic-claude-sonnet-5-5',
    provider: 'anthropic',
    providerModelId: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    apiKeyEnv: ANTHROPIC_API_KEY_ENV,
    sdkInstalled: true,
    baseURL: ANTHROPIC_FIXED_BASE_URL,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    price: { inputUsdMicrosPerMTok: 2_000_000, outputUsdMicrosPerMTok: 10_000_000 },
    longContext: null,
    dataRegion: ANTHROPIC_REGION,
    approved: false,
    approval: null,
    productionApproved: false,
    devOnly: false,
    sources: ANTHROPIC_SOURCES,
    verifiedAt: '2026-10-25',
  }),
  entry({
    id: 'anthropic-claude-opus-5-5',
    provider: 'anthropic',
    providerModelId: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    apiKeyEnv: ANTHROPIC_API_KEY_ENV,
    sdkInstalled: true,
    baseURL: ANTHROPIC_FIXED_BASE_URL,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    price: { inputUsdMicrosPerMTok: 4_000_000, outputUsdMicrosPerMTok: 20_000_000 },
    longContext: null,
    dataRegion: ANTHROPIC_REGION,
    approved: false,
    approval: null,
    productionApproved: false,
    devOnly: false,
    sources: ANTHROPIC_SOURCES,
    verifiedAt: '2026-10-25',
  }),
  entry({
    id: 'openai-gpt-6-luna-eu',
    provider: 'openai',
    providerModelId: 'gpt-6-luna',
    label: 'OpenAI GPT-6 Luna (EU endpoint)',
    apiKeyEnv: null,
    sdkInstalled: false,
    baseURL: 'https://eu.api.openai.com/v1',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    // Standard price; the EU-residency price is UNVERIFIED.
    price: { inputUsdMicrosPerMTok: 100_000, outputUsdMicrosPerMTok: 500_000 },
    longContext: null,
    dataRegion: 'EU (EEA + CH) processing and storage via the EU endpoint; needs OpenAI abuse-monitoring approval.',
    approved: false,
    approval: null,
    productionApproved: false,
    devOnly: false,
    sources: OPENAI_SOURCES,
    verifiedAt: '2026-10-25',
  }),
  entry({
    id: 'openai-gpt-6.1-sol-eu',
    provider: 'openai',
    providerModelId: 'gpt-6.1-sol',
    label: 'OpenAI GPT-6.1 Sol (EU endpoint)',
    apiKeyEnv: null,
    sdkInstalled: false,
    baseURL: 'https://eu.api.openai.com/v1',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    price: { inputUsdMicrosPerMTok: 2_000_000, outputUsdMicrosPerMTok: 10_000_000 },
    longContext: null,
    dataRegion: 'EU (EEA + CH) processing and storage via the EU endpoint; needs OpenAI abuse-monitoring approval.',
    approved: false,
    approval: null,
    productionApproved: false,
    devOnly: false,
    sources: OPENAI_SOURCES,
    verifiedAt: '2026-10-25',
  }),
]);

export const AI_CATALOGUE_IDS: readonly string[] = Object.freeze(AI_MODEL_CATALOGUE.map((m) => m.id));
export const AI_CATALOGUE_PROVIDERS: readonly AiCatalogueProvider[] = Object.freeze(['mock', 'anthropic', 'openai']);

export function catalogueEntry(id: string | null | undefined): AiCatalogueModel | null {
  if (!id) return null;
  return AI_MODEL_CATALOGUE.find((m) => m.id === id) ?? null;
}

/** A model that leaves the process (anything but the in-process mock). */
export function isRealProvider(model: Pick<AiCatalogueModel, 'provider'>): boolean {
  return model.provider !== 'mock';
}
