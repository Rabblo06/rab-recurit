/**
 * AI contracts C0 — USAGE ACCOUNTING, BUDGETS AND RATES (docs/ai/AI_CONTRACTS.md §2.7). Types and fixed values only.
 *
 * Money rule for AI: estimated provider cost is INTEGER MICRO-USD (`number`, far below 2^53; `bigint` in SQL). It is never
 * pence, never uses `money.ts`, and is labelled "estimated", not an invoice. Format with integer division only.
 * Every meter failure refuses (fail closed): 503 at submit, AI_SERVICE_UNAVAILABLE at a step.
 */

/** `core.ai_usage.kind` (Phase 7 M7-2). `agent` rows are never written before EX-3. */
export type AiUsageKind = 'chat' | 'title' | 'agent';

/**
 * Rate limits — OWNER DECISION 2026-10-25 (resolves B2 / C7-1): 10 turns per user per minute, 60 per organisation per
 * minute, 100 per user per day. One atomic three-bucket Redis call; all are checked before any is consumed; 429
 * AI_RATE_LIMITED with Retry-After; Redis down = 503. Titles and approval/answer requests are rate-exempt but metered
 * (P7-D7-9). Server env defaults (`AI_USER_RATE_PER_MIN`, `AI_ORG_RATE_PER_MIN`, `AI_USER_TURNS_PER_DAY`) must equal these.
 */
export const AI_RATE_LIMIT_DEFAULTS = {
  userPerMinute: 10,
  orgPerMinute: 60,
  userPerDay: 100,
} as const;

/** P7-D7-2: the per-user daily cost ceiling default is 1 USD; the effective user ceiling is min(user, org). */
export const AI_USER_DAILY_BUDGET_USD_DEFAULT = 1;
/** P7-D7-6: one audit row + admin flag when a day first crosses this share of a budget. No email. */
export const AI_BUDGET_ALERT_PERCENT = 80;
/** P7-D7-10. */
export const AI_USAGE_RETENTION_DAYS = 400;

/** Usage-specific turn/HTTP codes. Both are TURN codes: Phase 7 M7-1 extends `ai_message_error_code_check` with them. */
export const AiUsageErrorCode = {
  USER_BUDGET_EXHAUSTED: 'AI_USER_BUDGET_EXHAUSTED',
  /** The conversation no longer fits the per-step context budget after trimming old tool results. Start a new conversation. */
  CONTEXT_FULL: 'AI_CONTEXT_FULL',
} as const;
export type AiUsageErrorCodeType = (typeof AiUsageErrorCode)[keyof typeof AiUsageErrorCode];

/** The `usage` block of `GET /rest/v1/ai/availability`, target shape (Phase 1 fields kept; Phase 7 adds the cost meters). */
export interface AiAvailabilityUsageV2 {
  day: string;
  tokensUsedOrReserved: number;
  orgCostMicros: number;
  orgCostCeilingMicros: number;
  /** The caller's own allowance today. */
  userCostMicros: number;
  userCostCeilingMicros: number;
  /** C1 (CD-6): when the daily keys reset (next 00:00 UTC, ISO). */
  resetsAt?: string;
  /** C1 (CD-6): which ceiling is tighter right now; the allowance ring shows the % of that one. */
  limitingBudget?: 'user' | 'org';
}

/**
 * C1 (CD-6): per assistant turn, the caller's OWN turns only (owner RLS). From the Phase 7 per-turn `core.ai_usage`
 * ledger (no second store): `contextUsedTokens` = the last step's input tokens, `contextLimitTokens` = the Phase 7
 * `context-budget.ts` limit (never the provider's 1M window). Cost is estimated integer micro-USD. No content fields.
 */
export interface AiTurnUsageView {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  contextUsedTokens: number;
  contextLimitTokens: number;
}

/** The `limits` block of `GET /rest/v1/ai/availability`, target shape. */
export interface AiAvailabilityLimitsV2 {
  maxInputChars: number;
  userRatePerMinute: number;
  orgRatePerMinute: number;
  userTurnsPerDay: number;
  orgDailyTokenBudget: number;
}

export interface AiUsageTotals {
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsdMicros: number;
}

/**
 * `GET /rest/v1/ai/settings/usage?period=today|month` (Phase 7; CEO + `ai.settings`; audited `ai.usage_viewed`).
 * Metadata only, never content. Per-user rows are monitoring data about other people (THREAT-MODEL entry required).
 */
export interface AiUsageView {
  period: 'today' | 'month';
  from: string;
  to: string;
  totals: AiUsageTotals;
  byUser: (AiUsageTotals & { userId: string; displayName: string; userCostTodayMicros: number })[];
  byModel: (AiUsageTotals & { modelId: string; label: string })[];
  budgets: {
    orgDailyCostCeilingMicros: number;
    userDailyCostCeilingMicros: number;
    orgDailyTokenBudget: number;
  };
  /** Today's live meters (Redis), so the counter and the tab agree. */
  today: { orgCostMicros: number; orgTokensUsedOrReserved: number; alerts: ('cost' | 'tokens')[] };
}
