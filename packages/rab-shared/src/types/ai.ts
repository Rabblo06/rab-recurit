/**
 * AI Phase 1 — the wire contract shared by the API (`modules/ai`), the rab-ai Worker and the later web client. Full
 * contract: docs/ai/API_CONTRACT.md. Only identifiers, bounded text the user is entitled to and metadata travel here —
 * never a raw tool output, a prompt, a provider key or another user's data.
 */

/**
 * Why `GET /rest/v1/ai/availability` says AI is not available to the caller. The first four answer a uniform 404 on every
 * AI route. `not_configured` (503 AI_NOT_CONFIGURED) and `demo_data_only` (403 AI_DEMO_DATA_ONLY) are disclosed ONLY to a
 * caller who passed every earlier gate (eligible, platform switch on, organisation switch on) — docs/ai/PHASE1_TWENTY_PLAN.md §6.
 */
export const AiUnavailableReason = {
  PLATFORM_DISABLED: 'platform_disabled',
  ORGANISATION_DISABLED: 'organisation_disabled',
  NOT_PERMITTED: 'not_permitted',
  NO_WORKSPACE: 'no_workspace',
  NOT_CONFIGURED: 'not_configured',
  DEMO_DATA_ONLY: 'demo_data_only',
} as const;
export type AiUnavailableReasonType = (typeof AiUnavailableReason)[keyof typeof AiUnavailableReason];

/** What is missing when AI is `not_configured`: no usable provider at all, or providers but no model resolves. */
export type AiSetupNeeded = 'provider' | 'model';

/** The fixed texts of the two "not set up" states and the synthetic-data rule (crewflow-ai-work-like-twenty.md §1.4/§1.5). */
export const AI_STATE_MESSAGE = {
  NOT_CONFIGURED_PROVIDER: "AI isn't set up yet. A platform admin needs to add a provider key",
  NOT_CONFIGURED_MODEL: 'Choose a model in Settings → AI',
  DEMO_DATA_ONLY: 'AI is available for demo data only until the provider checklist is complete.',
} as const;

/** A model tier (Twenty's `fast` / `smart`). Chat uses `fast`. */
export type AiModelTier = 'fast' | 'smart';
export const AI_MODEL_TIERS: readonly AiModelTier[] = ['fast', 'smart'];

/**
 * A catalogue model's platform state, first failing condition first (PHASE1_TWENTY_PLAN §4). Only `available` (and an
 * already-pinned `deprecated`) can run; only `available` can be chosen as a new pin.
 */
export const AiModelState = {
  DISABLED: 'disabled',
  NOT_APPROVED: 'not_approved',
  NOT_IN_BUILD: 'not_in_build',
  KEY_NOT_CONFIGURED: 'key_not_configured',
  ENVIRONMENT_REFUSED: 'environment_refused',
  DEPRECATED: 'deprecated',
  AVAILABLE: 'available',
} as const;
export type AiModelStateType = (typeof AiModelState)[keyof typeof AiModelState];

export const AI_MODEL_STATE_LABEL: Record<AiModelStateType, string> = {
  disabled: 'Disabled by platform',
  not_approved: 'Not approved',
  not_in_build: 'Not in this build',
  key_not_configured: 'Key not configured',
  environment_refused: 'Not allowed in this environment',
  deprecated: 'Deprecated',
  available: 'Available',
};

/** One catalogue model as Settings → AI and the Admin Panel show it (facts + state; never a key). */
export interface AiModelView {
  id: string;
  label: string;
  provider: string;
  tier: AiModelTier;
  /** `global`, `eu` or `us`. */
  region: string;
  dataRegion: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** USD per 1M tokens as charged by the budget meter (regional uplift included). `cacheWrite` null = no separate price. */
  priceUsdPerMTok: { input: number; cachedInput: number; cacheWrite: number | null; output: number };
  deprecated: boolean;
  state: AiModelStateType;
  stateLabel: string;
  /** Can be picked as a new pin (state `available`). */
  selectable: boolean;
}

/** How the model for a tier was resolved: the organisation's pin, the env default list, the other tier's list, or any. */
export type AiModelSource = 'pin' | 'default' | 'nearest' | 'any';

export interface AiTierSettingView {
  tier: AiModelTier;
  /** The organisation's stored pin, or null ("Choose automatically"). */
  pinnedModelId: string | null;
  /** The pin is stored but cannot be used right now (unknown, unavailable or wrong tier) — it is skipped, never called. */
  pinUnusable: boolean;
  /** What a turn on this tier would use now, or null when nothing resolves. */
  resolved: { id: string; label: string; source: AiModelSource } | null;
  updatedAt: string | null;
}

/** `GET /rest/v1/ai/settings/models` (and the PUT/DELETE answers). */
export interface AiModelSettingsView {
  models: AiModelView[];
  tiers: AiTierSettingView[];
  /** null when the fast tier resolves; otherwise what is missing. */
  setup: AiSetupNeeded | null;
}

/** Provider key status for the Admin Panel: configured or not, never a value, a prefix or a length. */
export interface AiProviderKeyStatus {
  provider: string;
  envName: string;
  configured: boolean;
  sdkInstalled: boolean;
}

/**
 * Error codes a turn can end with (`ai_message.error_code`, the SSE `error` event, 4xx/5xx `code`). The database CHECK on
 * `error_code` holds the TURN codes (AiPhase1Schema1786720220000); NOT_AVAILABLE, NOT_CONFIGURED, DEMO_DATA_ONLY,
 * MODEL_NOT_AVAILABLE and the 4xx codes are HTTP-only and never stored on a turn.
 */
export const AiErrorCode = {
  NOT_AVAILABLE: 'AI_NOT_AVAILABLE',
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  DEMO_DATA_ONLY: 'AI_DEMO_DATA_ONLY',
  MODEL_NOT_AVAILABLE: 'AI_MODEL_NOT_AVAILABLE',
  INPUT_TOO_LONG: 'AI_INPUT_TOO_LONG',
  RATE_LIMITED: 'AI_RATE_LIMITED',
  ORG_BUSY: 'AI_ORG_BUSY',
  BUDGET_EXHAUSTED: 'AI_BUDGET_EXHAUSTED',
  TURN_IN_PROGRESS: 'AI_TURN_IN_PROGRESS',
  CONVERSATION_FULL: 'AI_CONVERSATION_FULL',
  SERVICE_UNAVAILABLE: 'AI_SERVICE_UNAVAILABLE',
  ACCESS_REVOKED: 'AI_ACCESS_REVOKED',
  MODEL_TIMEOUT: 'AI_MODEL_TIMEOUT',
  MODEL_ERROR: 'AI_MODEL_ERROR',
  TURN_TOKEN_LIMIT: 'AI_TURN_TOKEN_LIMIT',
  WORKER_INTERRUPTED: 'AI_WORKER_INTERRUPTED',
  INTERNAL: 'AI_INTERNAL_ERROR',
} as const;
export type AiErrorCodeType = (typeof AiErrorCode)[keyof typeof AiErrorCode];

/** Persisted per tool call on the assistant turn (`ai_message.tool_calls`). Metadata only — never arguments or results. */
export interface AiToolCallSummary {
  name: string;
  outcome: 'ok' | 'denied' | 'invalid_input' | 'error';
  rows: number | null;
}

/** One Server-Sent Event on `GET /rest/v1/ai/conversations/:id/stream`. `id` (SSE) is the resumable cursor. */
export type AiStreamEvent =
  | { type: 'status'; turnId: string; status: 'queued' | 'running' }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'tool'; turnId: string; name: string; phase: 'started' | 'finished'; outcome?: AiToolCallSummary['outcome'] }
  | { type: 'done'; turnId: string; status: 'completed' | 'failed' | 'cancelled'; errorCode: AiErrorCodeType | null; content: string }
  | { type: 'error'; turnId: string; errorCode: AiErrorCodeType };

// AI contracts C0 (docs/ai/AI_CONTRACTS.md): the typed contracts every later phase implements or consumes. Types and fixed
// values only. `…V2` names are the target shapes of the Phase 1 types above; they replace them at the owning phase's merge.
export * from './ai-models';
export * from './ai-turns';
export * from './ai-tools';
export * from './ai-skills';
export * from './ai-proposals';
export * from './ai-agents';
export * from './ai-usage';
export * from './ai-settings';
