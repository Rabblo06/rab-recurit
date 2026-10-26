/**
 * AI contracts C0 — USAGE ACCOUNTING, server side (docs/ai/AI_CONTRACTS.md §2.7). Types and fixed values only.
 *
 * Implemented by Agent 7: 7a = meter v2 (org + user keys in ONE Lua call), the insert-only `core.ai_usage` ledger,
 * `context-budget.ts` (pure), the `promptCache` fact and `turnCostBreakdown`; 7b (Batch 2, under the runner/gateway lock)
 * = rates, budget checks in submit/runner, clean stop, gateway caching and compaction, the usage endpoint. Cost is
 * integer micro-USD. Every meter failure refuses (fail closed); a settlement failure keeps the larger reserved charge.
 */
import type { AiUsageKind } from '@rab/shared';
import type { ModelMessage } from 'ai';

/** The runner's per-turn ledger, target shape (Phase 1 cost ledger + cache split + steps). */
export interface AiCostLedgerV2 {
  noCacheInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Settled actual cost so far. */
  costUsdMicros: number;
  /** Reserved but not yet settled. */
  reservedUsdMicros: number;
  steps: number;
}

/** Seeds for missing Redis keys: org from `ai_usage_daily.cost_usd_micros`, user from `ai_usage` (survives conversation deletion). */
export interface AiMeterSeeds {
  orgMicros?: number;
  userMicros?: number;
}

export type AiCostReserveResult =
  | { admitted: true }
  /** All-or-nothing: neither key was charged. */
  | { admitted: false; kind: 'org' | 'user' }
  /** A key is missing and no seed was passed: load that seed and retry. */
  | { seedNeeded: 'org' | 'user' };

/** Meter v2. Phase 7a keeps the Phase 1 one-key call signature as an adapter until 7b removes it. */
export interface AiCostMeterV2Contract {
  reserve(organisationId: string, userId: string, day: string, amountMicros: number, seeds?: AiMeterSeeds): Promise<AiCostReserveResult>;
  /** Charges `deltaMicros` (actual − reserved, may be negative) to BOTH keys. */
  settle(organisationId: string, userId: string, day: string, deltaMicros: number): Promise<void>;
  current(organisationId: string, userId: string, day: string): Promise<{ orgMicros: number; userMicros: number }>;
}

export type AiRateBucket = 'user_minute' | 'user_day' | 'org_minute';
export type AiRateDecision = { allowed: true } | { allowed: false; bucket: AiRateBucket; retryAfterSeconds: number };

/** One atomic TOKEN_BUCKET_SCRIPT call over the three buckets (AI_RATE_LIMIT_DEFAULTS). Redis failure throws (→ 503). */
export interface AiRateLimiterContract {
  consumeRate(organisationId: string, userId: string): Promise<AiRateDecision>;
}

/** One `core.ai_usage` row (insert-only, one per terminal turn, `UNIQUE (turn_id)`, no FK to the turn). Metadata only. */
export interface AiUsageLedgerRow {
  organisationId: string;
  userId: string;
  turnId: string;
  usageDate: string;
  kind: AiUsageKind;
  model: string;
  steps: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  outcome: 'completed' | 'failed' | 'cancelled';
  /** C1 (CD-6, columns in M7-2): the last step's input tokens and the context-budget limit for the turn. */
  contextUsedTokens?: number;
  contextLimitTokens?: number;
}

/** `limit = floor(AI_CONTEXT_BUDGET_RATIO × min(contextWindowTokens, turnCeilingTokens − maxOutputTokens))` (P7 §2.5). */
export const AI_CONTEXT_BUDGET_RATIO = 0.8;

/** Input of the pure `context-budget.ts` step that runs FIRST in `prepareStep` (then EX-1 checks and the payload scan on its output). */
export interface AiContextBudgetInput {
  messages: readonly ModelMessage[];
  /** The previous step's reported input tokens; null for step 0 (the byte bound is used). */
  previousStepInputTokens: number | null;
  appendedBytesSincePrevious: number;
  contextWindowTokens: number;
  turnCeilingTokens: number;
  maxOutputTokens: number;
  /** Agent 7 Q2 (accepted at the p7 merge): UTF-8 bytes of the fixed prefix (system prompt + SDK tool definitions) for the step-0 byte bound. */
  prefixBytes?: number;
}

/**
 * Oldest tool results are replaced by `wrapToolData(name, { omitted: 'older_result_removed' })` first (call/result pairs
 * kept; `load_skills` trimmed last). Still over → `context_full` → AiStepRefusedError('context_full') → AI_CONTEXT_FULL.
 * Never summarises, never adds text.
 */
export type AiContextBudgetResult =
  | { action: 'unchanged'; messages: readonly ModelMessage[] }
  | { action: 'trimmed'; messages: readonly ModelMessage[]; removedResults: number }
  | { action: 'context_full' };
