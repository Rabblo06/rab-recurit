import type { EnvironmentVariables } from '../environment/environment-variables';
import { AI_DEFAULT_MODEL_ID, AI_MODEL_CATALOGUE, AiCatalogueModel, catalogueEntry, isRealProvider } from './models/catalog';
import { ANTHROPIC_API_KEY_ENV, DEPRECATED_AI_PROVIDER_API_KEY_ENV } from './models/provider-keys';

/**
 * AI configuration rules, split in two (owner requirement 1 / decision 4, REAL_PROVIDER_PLAN conflict a):
 *
 *   BOOT problems — the process refuses to start (thrown by env.validation.ts). ONLY: malformed values (class-validator,
 *   before this runs), the in-process `mock` in production, and `AI_DEV_ALLOW_REAL_PROVIDERS=true` in production or test.
 *
 *   READINESS — everything else that is wrong with the AI configuration (unknown, disabled, unapproved or keyless model,
 *   a real provider on a database that is not the development database, the dev flag missing, ...). The AI subsystem is
 *   UNAVAILABLE (every AI route 404, the Worker refuses turns, the gateway refuses to build a model), the reason is logged
 *   (names only) and shown to platform administrators — and the API and Worker keep running for everything else.
 *
 * Pure: reads only the values it is given. Messages name variables and catalogue ids, never a value.
 */
export type AiEnvFacts = Pick<
  EnvironmentVariables,
  'NODE_ENV' | 'AI_ENABLED' | 'AI_PROVIDER' | 'AI_MODEL' | 'AI_PROVIDER_API_KEY' | typeof ANTHROPIC_API_KEY_ENV | 'AI_DEV_ALLOW_REAL_PROVIDERS' | 'AI_MODELS_DEFAULT_DISABLED'
>;

/** What the runtime database guard established at boot (runtime-database-guard.ts), or null when it never ran. */
export interface AiRuntimeDatabaseFacts {
  runtimeEnvironment: string;
  classification: string;
}

export const AiReadinessCode = {
  DISABLED: 'disabled',
  MODEL_UNKNOWN: 'model_unknown',
  MODEL_DISABLED: 'model_disabled',
  PROVIDER_MISMATCH: 'provider_mismatch',
  MODEL_NOT_APPROVED: 'model_not_approved',
  SDK_MISSING: 'sdk_missing',
  KEY_MISSING: 'key_missing',
  KEY_CONFLICT: 'key_conflict',
  MOCK_WITH_KEY: 'mock_with_key',
  REAL_PROVIDER_REFUSED_IN_TEST: 'real_provider_refused_in_test',
  MODEL_NOT_PRODUCTION_APPROVED: 'model_not_production_approved',
  REAL_PROVIDER_PRODUCTION_NOT_ENABLED: 'real_provider_production_not_enabled',
  DEV_FLAG_MISSING: 'dev_flag_missing',
  NOT_DEVELOPMENT_DATABASE: 'not_development_database',
} as const;
export type AiReadinessCodeType = (typeof AiReadinessCode)[keyof typeof AiReadinessCode];

export interface AiReadinessProblem {
  code: AiReadinessCodeType;
  message: string;
}

export interface AiReadiness {
  /** AI may run (AI_ENABLED and no problem). Per-turn checks (organisation `synthetic_data`, test marker) come on top. */
  ready: boolean;
  enabled: boolean;
  modelId: string | null;
  model: AiCatalogueModel | null;
  /** The resolved model leaves the process. */
  realProvider: boolean;
  /** Empty when ready. `disabled` alone means "switched off", not misconfigured. */
  problems: AiReadinessProblem[];
}

function disabledIds(env: Pick<AiEnvFacts, 'AI_MODELS_DEFAULT_DISABLED'>): string[] {
  return (env.AI_MODELS_DEFAULT_DISABLED ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The model AI_MODEL names, or the catalogue default when it is unset. */
export function resolvedModelId(env: Pick<AiEnvFacts, 'AI_MODEL'>): string {
  return env.AI_MODEL || AI_DEFAULT_MODEL_ID;
}

/**
 * The provider key for `model`, honouring the deprecated alias (REAL_PROVIDER_PLAN conflict j): `AI_PROVIDER_API_KEY`
 * counts only when `AI_PROVIDER` names this model's real provider AND the provider's own key is unset. Both set and
 * different ⇒ conflict (no key, AI unavailable). The value is returned to the caller, never copied anywhere.
 */
export function resolveProviderApiKey(env: AiEnvFacts, model: Pick<AiCatalogueModel, 'provider' | 'apiKeyEnv'>): { key: string | null; conflict: boolean } {
  if (!model.apiKeyEnv || model.provider === 'mock') return { key: null, conflict: false };
  const own = model.apiKeyEnv === ANTHROPIC_API_KEY_ENV ? env[ANTHROPIC_API_KEY_ENV] : undefined;
  const alias = env.AI_PROVIDER === model.provider ? env.AI_PROVIDER_API_KEY : undefined;
  if (own && alias && own !== alias) return { key: null, conflict: true };
  return { key: own || alias || null, conflict: false };
}

/** Hard boot refusals (thrown). Names only. */
export function aiBootProblems(env: AiEnvFacts): string[] {
  const problems: string[] = [];
  const model = catalogueEntry(resolvedModelId(env));
  if (env.NODE_ENV === 'production' && (env.AI_PROVIDER === 'mock' || model?.devOnly)) {
    problems.push(`AI_PROVIDER=mock / AI_MODEL=${resolvedModelId(env)} is a deterministic test model and must not be configured in production.`);
  }
  if (env.AI_DEV_ALLOW_REAL_PROVIDERS && env.NODE_ENV !== 'development') {
    problems.push(`AI_DEV_ALLOW_REAL_PROVIDERS=true is a development-only switch and must not be set when NODE_ENV=${env.NODE_ENV}.`);
  }
  return problems;
}

/** Startup warnings (names only): the deprecated key alias and unknown ids in the disabled list. */
export function aiConfigurationWarnings(env: AiEnvFacts): string[] {
  const warnings: string[] = [];
  if (env.AI_PROVIDER_API_KEY) {
    const provider = env.AI_PROVIDER;
    if (provider === 'anthropic' && !env[ANTHROPIC_API_KEY_ENV]) {
      warnings.push(`${DEPRECATED_AI_PROVIDER_API_KEY_ENV} is deprecated: it is being used as ${ANTHROPIC_API_KEY_ENV} because AI_PROVIDER=anthropic. Rename it to ${ANTHROPIC_API_KEY_ENV}; the alias is removed after one release.`);
    } else if (provider === 'anthropic') {
      warnings.push(`${DEPRECATED_AI_PROVIDER_API_KEY_ENV} is deprecated and ${ANTHROPIC_API_KEY_ENV} is also set; only ${ANTHROPIC_API_KEY_ENV} counts (AI is unavailable if they differ). Remove ${DEPRECATED_AI_PROVIDER_API_KEY_ENV}.`);
    } else {
      warnings.push(`${DEPRECATED_AI_PROVIDER_API_KEY_ENV} is deprecated and ignored (AI_PROVIDER does not name a real provider). Remove it.`);
    }
  }
  const unknown = disabledIds(env).filter((id) => !catalogueEntry(id));
  if (unknown.length > 0) warnings.push(`AI_MODELS_DEFAULT_DISABLED lists ${unknown.length} id(s) that are not in the model catalogue (ignored).`);
  return warnings;
}

export function aiReadiness(env: AiEnvFacts, runtimeDb: AiRuntimeDatabaseFacts | null): AiReadiness {
  const problems: AiReadinessProblem[] = [];
  const add = (code: AiReadinessCodeType, message: string) => problems.push({ code, message });
  const modelId = resolvedModelId(env);
  const model = catalogueEntry(modelId);
  const realProvider = model ? isRealProvider(model) : false;

  if (!env.AI_ENABLED) add(AiReadinessCode.DISABLED, 'AI_ENABLED=false (the platform AI switch is off).');
  if (!model) {
    add(AiReadinessCode.MODEL_UNKNOWN, `AI_MODEL=${modelId} is not in the model catalogue.`);
    return { ready: false, enabled: env.AI_ENABLED === true, modelId, model: null, realProvider: false, problems };
  }
  if (disabledIds(env).includes(model.id)) add(AiReadinessCode.MODEL_DISABLED, `${model.id} is listed in AI_MODELS_DEFAULT_DISABLED.`);
  if (env.AI_PROVIDER && env.AI_PROVIDER !== model.provider) {
    add(AiReadinessCode.PROVIDER_MISMATCH, `AI_PROVIDER=${env.AI_PROVIDER} does not match the provider of ${model.id} (${model.provider}).`);
  }
  if (!realProvider) {
    if (env.AI_PROVIDER === 'mock' && env.AI_PROVIDER_API_KEY) {
      add(AiReadinessCode.MOCK_WITH_KEY, `AI_PROVIDER=mock must not be given ${DEPRECATED_AI_PROVIDER_API_KEY_ENV} (a real key belongs only to an approved real provider).`);
    }
  } else {
    if (!model.approved) add(AiReadinessCode.MODEL_NOT_APPROVED, `${model.id} is not approved in the model catalogue.`);
    if (!model.sdkInstalled) add(AiReadinessCode.SDK_MISSING, `${model.id}: the ${model.provider} provider SDK is not part of this build.`);
    const key = resolveProviderApiKey(env, model);
    if (key.conflict) add(AiReadinessCode.KEY_CONFLICT, `${ANTHROPIC_API_KEY_ENV} and the deprecated ${DEPRECATED_AI_PROVIDER_API_KEY_ENV} are both set and differ.`);
    else if (!key.key) add(AiReadinessCode.KEY_MISSING, `${model.id} needs ${model.apiKeyEnv ?? 'a provider key'}, which is not configured.`);
    if (env.NODE_ENV === 'test') {
      add(AiReadinessCode.REAL_PROVIDER_REFUSED_IN_TEST, `NODE_ENV=test never calls a real provider (${model.id}); tests use the mock.`);
    } else if (env.NODE_ENV === 'production') {
      if (!model.productionApproved) add(AiReadinessCode.MODEL_NOT_PRODUCTION_APPROVED, `${model.id} is not approved for production (release checklist §3.7 not recorded).`);
      else add(AiReadinessCode.REAL_PROVIDER_PRODUCTION_NOT_ENABLED, 'This build does not enable real providers in production.');
    } else {
      if (!env.AI_DEV_ALLOW_REAL_PROVIDERS) add(AiReadinessCode.DEV_FLAG_MISSING, `${model.id} is a real provider: development needs AI_DEV_ALLOW_REAL_PROVIDERS=true.`);
      if (!runtimeDb || runtimeDb.runtimeEnvironment !== 'development' || runtimeDb.classification !== 'LOCAL') {
        add(AiReadinessCode.NOT_DEVELOPMENT_DATABASE, 'A real provider runs only on the development database (RAB_RUNTIME_ENV=development on a local database, verified by the runtime database guard at boot).');
      }
    }
  }
  return { ready: problems.length === 0, enabled: env.AI_ENABLED === true, modelId: model.id, model, realProvider, problems };
}

/** For tests and the admin view: every catalogue id that is approved for development. */
export function approvedModelIds(): string[] {
  return AI_MODEL_CATALOGUE.filter((m) => m.approved).map((m) => m.id);
}
