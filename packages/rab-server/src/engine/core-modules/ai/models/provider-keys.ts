import type { EnvironmentVariables } from '../../environment/environment-variables';

/**
 * AI provider key NAMES (docs/ai/PHASE1_TWENTY_PLAN.md §2.2, D4 / TP-2 / TP-8): the ONE place server code writes the
 * provider key variable names. `EnvironmentVariables` declares each property (it is the validation schema, and the worker
 * launcher's reconciliation test reads that declaration); everything else — the gateway, readiness, the admin
 * environment viewer — refers to these constants. `ai-provider-boundary.spec.ts` fails if a literal appears anywhere else.
 *
 * Twenty-style names (deviation from security spec 4.3 `AI_<PROVIDER>_API_KEY`, owner-approved: TP-2 for Anthropic,
 * TP-8 for the other four). These are also the names the provider SDKs read from `process.env` by themselves when no
 * `apiKey` is passed, so every one is: read only through EnvironmentService; passed EXPLICITLY to the provider factory
 * with a fixed endpoint; `secret`-classed in the admin environment viewer ("configured" only); and covered by the static
 * scan that refuses any provider default instance and any `@ai-sdk/<provider>` import outside the gateway.
 *
 * In Phase 1 only `@ai-sdk/anthropic` is in the build (D5). The other four names are INERT: no SDK reads them (none is
 * installed), no catalogue model of theirs is approved, and readiness reports their models "Not in this build".
 */
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY' as const satisfies keyof EnvironmentVariables;
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY' as const satisfies keyof EnvironmentVariables;
export const GOOGLE_API_KEY_ENV = 'GOOGLE_API_KEY' as const satisfies keyof EnvironmentVariables;
export const MISTRAL_API_KEY_ENV = 'MISTRAL_API_KEY' as const satisfies keyof EnvironmentVariables;
export const XAI_API_KEY_ENV = 'XAI_API_KEY' as const satisfies keyof EnvironmentVariables;

/** Every provider key variable (all secret-classed in the admin environment viewer). */
export const AI_PROVIDER_KEY_ENVS = [ANTHROPIC_API_KEY_ENV, OPENAI_API_KEY_ENV, GOOGLE_API_KEY_ENV, MISTRAL_API_KEY_ENV, XAI_API_KEY_ENV] as const;
export type AiProviderKeyEnv = (typeof AI_PROVIDER_KEY_ENVS)[number];

/** The real providers a catalogue entry may name. */
export const AI_REAL_PROVIDERS = ['anthropic', 'openai', 'google', 'mistral', 'xai'] as const;
export type AiRealProvider = (typeof AI_REAL_PROVIDERS)[number];

/**
 * Per provider: its key variable and whether this BUILD contains its SDK. Code, not configuration: installing an SDK is
 * a reviewed dependency change (pinned exactly, security 13.1) together with this flag and a provider-factory branch.
 */
export const AI_PROVIDER_REGISTRY: Readonly<Record<AiRealProvider, { keyEnv: AiProviderKeyEnv; sdkInstalled: boolean }>> = Object.freeze({
  anthropic: Object.freeze({ keyEnv: ANTHROPIC_API_KEY_ENV, sdkInstalled: true }),
  openai: Object.freeze({ keyEnv: OPENAI_API_KEY_ENV, sdkInstalled: false }),
  google: Object.freeze({ keyEnv: GOOGLE_API_KEY_ENV, sdkInstalled: false }),
  mistral: Object.freeze({ keyEnv: MISTRAL_API_KEY_ENV, sdkInstalled: false }),
  xai: Object.freeze({ keyEnv: XAI_API_KEY_ENV, sdkInstalled: false }),
});

/**
 * The fixed Anthropic endpoint. Always passed explicitly, so `ANTHROPIC_BASE_URL` (the SDK's environment fallback) is
 * never read. There is no `*_BASE_URL` configuration anywhere: changing the endpoint is a reviewed code change.
 */
export const ANTHROPIC_FIXED_BASE_URL = 'https://api.anthropic.com/v1';

/**
 * Variable names RETIRED by Phase 1 "real models only" (§5, C2/C7/D2). They are no longer schema properties: the model is
 * chosen per organisation (Settings → AI) and the key alias is gone. env.validation.ts reads them from the RAW
 * configuration only to refuse or warn — never to use them. Their values are never logged or returned.
 */
export const LEGACY_AI_ENV_NAMES = ['AI_PROVIDER', 'AI_MODEL', 'AI_PROVIDER_API_KEY'] as const;
export type LegacyAiEnvName = (typeof LEGACY_AI_ENV_NAMES)[number];
