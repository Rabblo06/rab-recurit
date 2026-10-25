import type { EnvironmentVariables } from '../environment/environment-variables';
import { AI_MODEL_CATALOGUE, AiCatalogueModel, AiModelTierName, catalogueEntry, isRealProvider } from './models/catalog';
import { AI_PROVIDER_KEY_ENVS, AI_PROVIDER_REGISTRY, AI_REAL_PROVIDERS, AiRealProvider, ANTHROPIC_API_KEY_ENV, LEGACY_AI_ENV_NAMES } from './models/provider-keys';

/**
 * AI configuration rules (docs/ai/PHASE1_TWENTY_PLAN.md §4–§6, owner requirement 1 / TP-1). Pure: reads only the values
 * it is given. Messages name variables and catalogue ids, never a value.
 *
 *   BOOT problems — the process refuses to start (thrown by env.validation.ts). ONLY deliberate stand-ins and a retired
 *   secret name (§5 table, D2): `AI_PROVIDER=mock` or a mock `AI_MODEL` outside test; `AI_PROVIDER_API_KEY` in development
 *   and test; `AI_DEV_ALLOW_REAL_PROVIDERS=true` outside development. Production refuses the mock as it did before Phase 1;
 *   the retired key alias only WARNS in production (D2: the production environment could not be confirmed free of it).
 *
 *   Everything else fails CLOSED at runtime: a model is AVAILABLE only when it is security-approved in code, its SDK is in
 *   this build, its provider key is set, it is not in AI_MODELS_DEFAULT_DISABLED and the environment class permits real
 *   providers. No available model ⇒ AI "not configured" (503 to eligible users only) while the API and Worker keep running.
 *
 * Three separate states (§4): security approval (code, catalog.ts), platform availability (env, here) and the
 * organisation's choice (a DB pin, Settings → AI), which can only point at a model that is both.
 */
export type AiEnvFacts = Pick<
  EnvironmentVariables,
  | 'NODE_ENV'
  | 'AI_ENABLED'
  | (typeof AI_PROVIDER_KEY_ENVS)[number]
  | 'AI_DEV_ALLOW_REAL_PROVIDERS'
  | 'AI_MODELS_DEFAULT_DISABLED'
  | 'AI_MODELS_DEFAULT_FAST'
  | 'AI_MODELS_DEFAULT_SMART'
>;

/**
 * The retired names as the RAW configuration holds them (they are no longer schema properties). Presence and the
 * "stand-in" verdict only — never a value.
 */
export interface LegacyAiEnvFacts {
  /** `AI_PROVIDER` and/or `AI_MODEL` is set. */
  modelSelectionSet: boolean;
  /** `AI_PROVIDER=mock` or an `AI_MODEL` naming a mock: a deliberate stand-in model. */
  mockStandIn: boolean;
  /** `AI_PROVIDER_API_KEY` is set (any value; renamed ANTHROPIC_API_KEY). */
  legacyKeySet: boolean;
}

export const NO_LEGACY_AI_ENV: LegacyAiEnvFacts = Object.freeze({ modelSelectionSet: false, mockStandIn: false, legacyKeySet: false });

/** Reads the retired names through `read` (raw configuration). Only the verdicts leave this function. */
export function legacyAiEnvFacts(read: (name: (typeof LEGACY_AI_ENV_NAMES)[number]) => unknown): LegacyAiEnvFacts {
  const text = (name: (typeof LEGACY_AI_ENV_NAMES)[number]) => {
    const v = read(name);
    return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v);
  };
  const provider = text('AI_PROVIDER');
  const model = text('AI_MODEL');
  return {
    modelSelectionSet: provider !== '' || model !== '',
    mockStandIn: provider.toLowerCase() === 'mock' || /mock/i.test(model),
    legacyKeySet: text('AI_PROVIDER_API_KEY') !== '',
  };
}

/** What the runtime database guard established at boot (runtime-database-guard.ts), or null when it never ran. */
export interface AiRuntimeDatabaseFacts {
  runtimeEnvironment: string;
  classification: string;
}

/**
 * The retired key alias in PRODUCTION: refuse to boot only once the owner has confirmed the production environment does
 * not carry it (D2). Not confirmed (2026-10-25: the OpenShip/Oracle environment is not readable from here) ⇒ a logged
 * warning, AI unavailable, and a release-checklist item. Flip to true in a reviewed commit after the confirmation.
 */
export const PRODUCTION_LEGACY_AI_ENV_REFUSAL_CONFIRMED = false;

/** Hard boot refusals (thrown). Names only. */
export function aiBootProblems(env: Pick<AiEnvFacts, 'NODE_ENV' | 'AI_DEV_ALLOW_REAL_PROVIDERS'>, legacy: LegacyAiEnvFacts = NO_LEGACY_AI_ENV): string[] {
  const problems: string[] = [];
  if (legacy.mockStandIn && env.NODE_ENV !== 'test') {
    problems.push(
      `AI_PROVIDER / AI_MODEL name the deterministic mock model, which is test-only (NODE_ENV=${env.NODE_ENV}). Delete AI_PROVIDER and AI_MODEL: the model is chosen per organisation in Settings → AI.`,
    );
  }
  if (legacy.legacyKeySet && (env.NODE_ENV !== 'production' || PRODUCTION_LEGACY_AI_ENV_REFUSAL_CONFIRMED)) {
    problems.push(`AI_PROVIDER_API_KEY was renamed: put the Anthropic key in ${ANTHROPIC_API_KEY_ENV} and delete AI_PROVIDER_API_KEY.`);
  }
  if (env.AI_DEV_ALLOW_REAL_PROVIDERS && env.NODE_ENV !== 'development') {
    problems.push(`AI_DEV_ALLOW_REAL_PROVIDERS=true is a development-only switch and must not be set when NODE_ENV=${env.NODE_ENV}.`);
  }
  return problems;
}

export function idList(value: string | undefined | null): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Startup warnings (names and counts only). */
export function aiConfigurationWarnings(env: AiEnvFacts, legacy: LegacyAiEnvFacts = NO_LEGACY_AI_ENV, catalogue: readonly AiCatalogueModel[] = AI_MODEL_CATALOGUE): string[] {
  const warnings: string[] = [];
  if (legacy.modelSelectionSet) {
    warnings.push('AI_PROVIDER / AI_MODEL are no longer read: the model is chosen per organisation in Settings → AI (env defaults: AI_MODELS_DEFAULT_FAST / AI_MODELS_DEFAULT_SMART). Delete them.');
  }
  if (legacy.legacyKeySet && env.NODE_ENV === 'production' && !PRODUCTION_LEGACY_AI_ENV_REFUSAL_CONFIRMED) {
    warnings.push(`AI_PROVIDER_API_KEY is no longer read (renamed ${ANTHROPIC_API_KEY_ENV}). AI stays unavailable until it is removed. Remove it.`);
  }
  for (const name of ['AI_MODELS_DEFAULT_DISABLED', 'AI_MODELS_DEFAULT_FAST', 'AI_MODELS_DEFAULT_SMART'] as const) {
    const unknown = idList(env[name]).filter((id) => !catalogueEntry(id, catalogue));
    if (unknown.length > 0) warnings.push(`${name} lists ${unknown.length} id(s) that are not in the model catalogue (ignored).`);
  }
  return warnings;
}

/** The provider key for `model`, or null (the in-process test model needs none). Returned to the caller, never copied. */
export function providerApiKey(env: AiEnvFacts, model: Pick<AiCatalogueModel, 'provider' | 'apiKeyEnv'>): string | null {
  if (!isRealProvider(model) || !model.apiKeyEnv) return null;
  const value = env[model.apiKeyEnv];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export const AiPlatformProblemCode = {
  DISABLED: 'disabled',
  REAL_PROVIDER_REFUSED_IN_TEST: 'real_provider_refused_in_test',
  REAL_PROVIDER_PRODUCTION_NOT_ENABLED: 'real_provider_production_not_enabled',
  LEGACY_KEY_PRESENT: 'legacy_key_present',
  DEV_FLAG_MISSING: 'dev_flag_missing',
  NOT_DEVELOPMENT_DATABASE: 'not_development_database',
  NO_PROVIDER_KEY: 'no_provider_key',
  NO_MODEL_AVAILABLE: 'no_model_available',
} as const;
export type AiPlatformProblemCodeType = (typeof AiPlatformProblemCode)[keyof typeof AiPlatformProblemCode];
export interface AiPlatformProblem {
  code: AiPlatformProblemCodeType;
  message: string;
}

/** Whether this environment class lets ANY real provider run, and why not (names only). */
export function realProviderEnvironment(env: AiEnvFacts, runtimeDb: AiRuntimeDatabaseFacts | null, legacy: LegacyAiEnvFacts = NO_LEGACY_AI_ENV): AiPlatformProblem[] {
  const problems: AiPlatformProblem[] = [];
  if (env.NODE_ENV === 'test') {
    problems.push({ code: AiPlatformProblemCode.REAL_PROVIDER_REFUSED_IN_TEST, message: 'NODE_ENV=test never calls a real provider; tests use in-process test models.' });
    return problems;
  }
  if (env.NODE_ENV === 'production') {
    // productionApproved is required per model AND this build enables no real provider in production at all.
    problems.push({ code: AiPlatformProblemCode.REAL_PROVIDER_PRODUCTION_NOT_ENABLED, message: 'This build does not enable real providers in production (release checklist §3.7 not recorded; no model is production-approved).' });
    if (legacy.legacyKeySet) problems.push({ code: AiPlatformProblemCode.LEGACY_KEY_PRESENT, message: `AI_PROVIDER_API_KEY is set: remove it (renamed ${ANTHROPIC_API_KEY_ENV}).` });
    return problems;
  }
  if (!env.AI_DEV_ALLOW_REAL_PROVIDERS) problems.push({ code: AiPlatformProblemCode.DEV_FLAG_MISSING, message: 'Real providers in development need AI_DEV_ALLOW_REAL_PROVIDERS=true.' });
  if (!runtimeDb || runtimeDb.runtimeEnvironment !== 'development' || runtimeDb.classification !== 'LOCAL') {
    problems.push({
      code: AiPlatformProblemCode.NOT_DEVELOPMENT_DATABASE,
      message: 'A real provider runs only on the development database (RAB_RUNTIME_ENV=development on a local database, verified by the runtime database guard at boot).',
    });
  }
  return problems;
}

export type AiModelStateCode = 'disabled' | 'not_approved' | 'not_in_build' | 'key_not_configured' | 'environment_refused' | 'deprecated' | 'available';

/** Everything availability needs about the platform, computed once per evaluation. */
export interface AiAvailabilityContext {
  env: AiEnvFacts;
  runtimeDb: AiRuntimeDatabaseFacts | null;
  legacy: LegacyAiEnvFacts;
  /** The effective catalogue (production, plus validated test models when NODE_ENV=test). */
  catalogue: readonly AiCatalogueModel[];
}

/**
 * A model's platform state: the FIRST failing condition, in the §4 label order. `available` and `deprecated` can run;
 * only `available` may be chosen as a new pin. Production requires `productionApproved` (reported as
 * `environment_refused`: dev approval exists, this environment class does not accept it).
 */
export function modelState(model: AiCatalogueModel, ctx: AiAvailabilityContext): AiModelStateCode {
  if (idList(ctx.env.AI_MODELS_DEFAULT_DISABLED).includes(model.id)) return 'disabled';
  if (!isRealProvider(model)) {
    // In-process test models exist only in the test catalogue and only ever run under NODE_ENV=test.
    return ctx.env.NODE_ENV === 'test' ? 'available' : 'environment_refused';
  }
  if (!model.approved) return 'not_approved';
  if (!model.sdkInstalled) return 'not_in_build';
  if (!providerApiKey(ctx.env, model)) return 'key_not_configured';
  if (realProviderEnvironment(ctx.env, ctx.runtimeDb, ctx.legacy).length > 0) return 'environment_refused';
  if (ctx.env.NODE_ENV === 'production' && !model.productionApproved) return 'environment_refused';
  if (model.deprecated) return 'deprecated';
  return 'available';
}

/** The model may run (available, or deprecated but still available). */
export function isUsableState(state: AiModelStateCode): boolean {
  return state === 'available' || state === 'deprecated';
}

export type AiResolutionSource = 'pin' | 'default' | 'nearest' | 'any';
export interface AiModelResolution {
  model: AiCatalogueModel;
  source: AiResolutionSource;
}
export type AiModelPins = Partial<Record<AiModelTierName, string>>;

const OTHER_TIER: Record<AiModelTierName, AiModelTierName> = { fast: 'smart', smart: 'fast' };
const tierList = (env: AiEnvFacts, tier: AiModelTierName) => idList(tier === 'fast' ? env.AI_MODELS_DEFAULT_FAST : env.AI_MODELS_DEFAULT_SMART);

/**
 * The model a turn on `tier` uses (§7, D11): 1. the organisation's pin for that tier, when usable and of that tier;
 * 2. the first usable id in AI_MODELS_DEFAULT_<TIER>; 3. the nearest tier: the first usable id in AI_MODELS_DEFAULT_<OTHER>;
 * 4. any usable model (requested tier first, non-deprecated first, then ascending input price, then catalogue order);
 * 5. null. Every candidate passes `modelState` — step 4 never escapes approval: it only picks approved, keyed, enabled
 * models. A stale pin (unknown id, key removed, model disabled, approval revoked) is skipped, never called.
 */
export function resolveModel(tier: AiModelTierName, pins: AiModelPins, ctx: AiAvailabilityContext): AiModelResolution | null {
  const usable = (id: string | undefined): AiCatalogueModel | null => {
    const m = catalogueEntry(id, ctx.catalogue);
    return m && isUsableState(modelState(m, ctx)) ? m : null;
  };
  const pinned = usable(pins[tier]);
  if (pinned && pinned.tier === tier) return { model: pinned, source: 'pin' };
  for (const id of tierList(ctx.env, tier)) {
    const m = usable(id);
    if (m) return { model: m, source: 'default' };
  }
  for (const id of tierList(ctx.env, OTHER_TIER[tier])) {
    const m = usable(id);
    if (m) return { model: m, source: 'nearest' };
  }
  const any = ctx.catalogue
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => isUsableState(modelState(m, ctx)))
    .sort((a, b) =>
      Number(a.m.tier !== tier) - Number(b.m.tier !== tier) ||
      Number(a.m.deprecated) - Number(b.m.deprecated) ||
      a.m.price.inputUsdMicrosPerMTok - b.m.price.inputUsdMicrosPerMTok ||
      a.index - b.index,
    );
  return any[0] ? { model: any[0].m, source: 'any' } : null;
}

/**
 * What is missing when nothing resolves (§6 rows 7–9): `provider` when no provider whose SDK is in this build has a key,
 * or when this environment refuses real providers; otherwise `model` (keys exist, but no approved + enabled model).
 */
export function setupNeeded(ctx: AiAvailabilityContext): 'provider' | 'model' {
  const keyed = AI_REAL_PROVIDERS.some((p) => AI_PROVIDER_REGISTRY[p].sdkInstalled && Boolean(ctx.env[AI_PROVIDER_REGISTRY[p].keyEnv]));
  if (!keyed) return 'provider';
  if (realProviderEnvironment(ctx.env, ctx.runtimeDb, ctx.legacy).length > 0) return 'provider';
  return 'model';
}

/** Admin-facing platform readiness (names only): the kill switch, the environment class and whether anything resolves. */
export function aiPlatformReadiness(ctx: AiAvailabilityContext): { ready: boolean; enabled: boolean; realProvidersPermitted: boolean; problems: AiPlatformProblem[] } {
  const problems: AiPlatformProblem[] = [];
  const enabled = ctx.env.AI_ENABLED === true;
  if (!enabled) problems.push({ code: AiPlatformProblemCode.DISABLED, message: 'AI_ENABLED=false (the platform AI switch is off).' });
  const environment = realProviderEnvironment(ctx.env, ctx.runtimeDb, ctx.legacy);
  problems.push(...environment);
  const keyed = AI_REAL_PROVIDERS.filter((p) => AI_PROVIDER_REGISTRY[p].sdkInstalled && Boolean(ctx.env[AI_PROVIDER_REGISTRY[p].keyEnv]));
  if (keyed.length === 0 && ctx.env.NODE_ENV !== 'test') {
    problems.push({ code: AiPlatformProblemCode.NO_PROVIDER_KEY, message: `No provider key is configured for a provider in this build (${AI_REAL_PROVIDERS.filter((p) => AI_PROVIDER_REGISTRY[p].sdkInstalled).map((p) => AI_PROVIDER_REGISTRY[p].keyEnv).join(', ')}).` });
  }
  const anyUsable = ctx.catalogue.some((m) => isUsableState(modelState(m, ctx)));
  if (!anyUsable) problems.push({ code: AiPlatformProblemCode.NO_MODEL_AVAILABLE, message: 'No catalogue model is available (approved, in this build, keyed, not disabled, permitted in this environment).' });
  return { ready: enabled && anyUsable, enabled, realProvidersPermitted: environment.length === 0, problems };
}

/** For tests and the admin view: every catalogue id that is approved for development. */
export function approvedModelIds(catalogue: readonly AiCatalogueModel[] = AI_MODEL_CATALOGUE): string[] {
  return catalogue.filter((m) => m.approved).map((m) => m.id);
}

export type { AiRealProvider };
