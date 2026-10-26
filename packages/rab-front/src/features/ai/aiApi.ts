import { AI_TOOL_STEP_LABELS, type AiAssistantProfileView, type AiAvailabilityLevelsView, type AiCapabilitiesView, type AiSkillSummaryView, type AiErrorCodeType, type AiModelLevel, type AiModelSource, type AiModelTier, type AiSetupNeeded, type AiToolCallSummaryV2, type AiTurnUsageView, type AiUnavailableReasonType, type AiUsageTotals } from '@rab/shared';

import { api } from '../../shared/api';

/**
 * AI Phase 1 web client — the ONE place this feature talks to `/rest/v1/ai/*` over plain HTTP (the stream has its own
 * fetch-based reader in `aiStream.ts`). Every shape below mirrors docs/ai/API_CONTRACT.md exactly; nothing is computed
 * or invented here. Organisation, workspace and user are never sent: the server reads them from the session.
 */

export interface AiLimits {
  maxInputChars: number;
  userRatePerMinute: number;
  orgDailyTokenBudget: number;
}

/** The model a turn on the chat (`fast`) tier would use right now, and how it was chosen. */
export interface AiResolvedModel {
  id: string;
  label: string;
  tier: AiModelTier;
  source: AiModelSource;
}

/**
 * `not_configured` and `demo_data_only` are answered ONLY to a caller who passed every earlier gate (eligible, platform
 * and organisation switches on), with the fixed server text in `message`. The chat opens for them with its input disabled.
 */
/**
 * C1 additions (all optional until their server merges): the assistant's name and avatar (CD-3), the composer's level
 * options (CD-1) and the usage block's Phase 7 cost meters and reset time (CD-6). Absent = the feature is not served yet.
 */
export interface AiAvailabilityExtras {
  assistant?: AiAssistantProfileView | null;
  levels?: AiAvailabilityLevelsView | null;
}

export interface AiAvailabilityUsage {
  day: string;
  tokensUsedOrReserved: number;
  orgCostMicros?: number;
  orgCostCeilingMicros?: number;
  userCostMicros?: number;
  userCostCeilingMicros?: number;
  resetsAt?: string;
  limitingBudget?: 'user' | 'org';
}

export type AiAvailability = AiAvailabilityExtras & (
  | { available: true; reason: null; limits: AiLimits; usage: AiAvailabilityUsage; model?: AiResolvedModel }
  | { available: false; reason: 'not_configured'; setup: AiSetupNeeded; message: string; limits: AiLimits; usage: null }
  | { available: false; reason: 'demo_data_only'; message: string; limits: AiLimits; usage: null }
  | { available: false; reason: Exclude<AiUnavailableReasonType, 'not_configured' | 'demo_data_only'>; limits: AiLimits; usage: null }
);

/** The two states in which the AI chrome is shown but nothing can be sent. */
export type AiBlockedAvailability = Extract<AiAvailability, { reason: 'not_configured' | 'demo_data_only' }>;

/** True when the server says the caller is eligible but AI is not set up / limited to demo data (C14). */
export function isAiBlocked(a: AiAvailability | undefined): a is AiBlockedAvailability {
  return !!a && a.available === false && (a.reason === 'not_configured' || a.reason === 'demo_data_only');
}

export interface AiConversation {
  id: string;
  title: string | null;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

export type AiMessageStatus = 'sent' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  status: AiMessageStatus;
  content: string;
  errorCode: AiErrorCodeType | string | null;
  toolCalls: AiToolCallSummaryV2[];
  createdAt: string;
  completedAt: string | null;
  /** C1 (CD-1): the level the turn ran at (assistant turns; optional until the CD-1 merge). */
  level?: AiModelLevel | null;
  /** C1 (CD-7): measured reasoning DURATION (server clock). There is no reasoning text anywhere. */
  reasoningMs?: number | null;
  /**
   * C1 (CD-6) / S1: the caller's OWN assistant turns that have a ledger row only. Absent = not recorded ("—"), never a
   * guess.
   */
  usage?: AiTurnUsageView;
  /** S1: the catalogue id of the model that answered. Its label comes from a models list, never from free text. */
  modelId?: string | null;
}

export interface AiConversationDetail {
  conversation: AiConversation;
  messages: AiMessage[];
  /** C1 (CD-6): the caller's own totals for this conversation (Phase 7). */
  usageTotals?: AiUsageTotals;
}

export interface AiSubmitResult {
  conversationId: string;
  userMessageId: string;
  turnId: string;
  status: AiMessageStatus;
  replayed: boolean;
}

/** Title the server stores for a new conversation: the first question, trimmed to a readable length (≤ 120). */
export function conversationTitleFrom(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
}

export const aiApi = {
  availability: async () => (await api.get<AiAvailability>('/ai/availability')).data,
  list: async (cursor?: string | null) =>
    (await api.get<{ data: AiConversation[]; nextCursor: string | null }>('/ai/conversations', { params: { limit: 20, ...(cursor ? { cursor } : {}) } })).data,
  get: async (id: string) => (await api.get<AiConversationDetail>(`/ai/conversations/${encodeURIComponent(id)}`)).data,
  create: async (title?: string) => (await api.post<AiConversation>('/ai/conversations', title ? { title } : {})).data,
  /** `clientRequestId` makes a retried submit return the SAME turn (`replayed: true`), never a second question. */
  /** `level` (CD-1) is an enum value only and is sent ONLY when the server offered levels; omitted = the chat level. */
  submit: async (conversationId: string, content: string, clientRequestId: string, level?: AiModelLevel) =>
    (await api.post<AiSubmitResult>(`/ai/conversations/${encodeURIComponent(conversationId)}/messages`, level ? { content, clientRequestId, level } : { content, clientRequestId })).data,
  cancel: async (conversationId: string, turnId: string) =>
    (await api.post<{ turnId: string; status: string }>(`/ai/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/cancel`, {})).data,
  remove: async (id: string) => {
    await api.delete(`/ai/conversations/${encodeURIComponent(id)}`);
  },
  /** CD-8 "See what I can do": the caller's permitted tools + active skills (404 until the route exists). */
  capabilities: async () => (await api.get<AiCapabilitiesView>('/ai/capabilities')).data,
  /** Phase 4: the active skills' name, label and description (never content) — the step lines show the label. */
  skills: async () => (await api.get<AiSkillSummaryView[]>('/ai/skills')).data,
};

/** React Query keys, always scoped by the provider's identity key so one account's AI data never shows for another. */
export const aiKeys = {
  all: (scope: string) => ['ai', scope] as const,
  availability: (scope: string) => ['ai', scope, 'availability'] as const,
  settings: (scope: string) => ['ai', scope, 'settings', 'models'] as const,
  settingsArea: (scope: string, area: string) => ['ai', scope, 'settings', area] as const,
  capabilities: (scope: string) => ['ai', scope, 'capabilities'] as const,
  skills: (scope: string) => ['ai', scope, 'skills'] as const,
  list: (scope: string) => ['ai', scope, 'conversations'] as const,
  detail: (scope: string, id: string) => ['ai', scope, 'conversation', id] as const,
};

/** User-facing text for the AI error codes (contract §Asking a question and the turn `errorCode` list). */
export const AI_ERROR_TEXT: Record<string, string> = {
  AI_INPUT_TOO_LONG: 'Your question is too long. Shorten it and try again.',
  AI_TURN_IN_PROGRESS: 'An answer is still being prepared in this conversation. Wait for it or stop it first.',
  AI_CONVERSATION_FULL: 'This conversation is full. Start a new conversation to keep asking.',
  AI_RATE_LIMITED: 'You are asking questions too quickly.',
  AI_ORG_BUSY: 'Your organisation already has the maximum number of AI questions in progress.',
  AI_BUDGET_EXHAUSTED: 'Your organisation has used today’s AI allowance.',
  AI_SERVICE_UNAVAILABLE: 'The AI assistant is temporarily unavailable. Please try again in a moment.',
  AI_NOT_AVAILABLE: 'The AI assistant is not available to you right now.',
  // Fallbacks only: the server's fixed `message` (AI_STATE_MESSAGE) is shown when present.
  AI_NOT_CONFIGURED: "AI isn't set up yet. A platform admin needs to add a provider key",
  AI_DEMO_DATA_ONLY: 'AI is available for demo data only until the provider checklist is complete.',
  AI_MODEL_NOT_AVAILABLE: 'That model is not available. Choose one of the available models.',
  AI_LEVEL_UNAVAILABLE: 'That level can’t be used right now. Choose another level.',
  AI_USER_BUDGET_EXHAUSTED: 'You’ve used your AI allowance for today.',
  AI_CONTEXT_FULL: 'This conversation is too long to continue. Start a new conversation.',
};

/** What a finished turn's `errorCode` means for the person who asked (never a provider message or a stack). */
export const AI_TURN_ERROR_TEXT: Record<string, string> = {
  AI_ACCESS_REVOKED: 'This answer was stopped because your access to the AI assistant changed.',
  AI_MODEL_TIMEOUT: 'The assistant took too long to answer. Ask again, perhaps with a narrower question.',
  AI_MODEL_ERROR: 'The assistant could not answer this time. Please ask again.',
  AI_TURN_TOKEN_LIMIT: 'This answer reached its size limit and was stopped. Try a narrower question.',
  AI_WORKER_INTERRUPTED: 'This answer was interrupted by a service restart. Please ask again.',
  AI_SERVICE_UNAVAILABLE: 'The AI assistant was temporarily unavailable. Please ask again.',
  AI_BUDGET_EXHAUSTED: 'Your organisation has used today’s AI allowance.',
  // 7b: a turn stopped cleanly between steps (per-person ceiling) or before a step that could not fit the context budget.
  AI_USER_BUDGET_EXHAUSTED: 'You’ve used your AI allowance for today. It resets at 00:00 UTC.',
  AI_CONTEXT_FULL: 'This conversation is too long to continue. Start a new conversation to keep asking.',
  AI_INTERNAL_ERROR: 'Something went wrong while preparing this answer. Please ask again.',
};

/**
 * The chat's step line for one tool (C1 `AI_TOOL_STEP_LABELS`, fixed server wording owned by Agent 3). Never the tool's
 * arguments or data; `{rows}` only from the persisted call summary. An unknown name gets a neutral line.
 */
export function toolStepLabel(name: string, phase: 'started' | 'finished', rows: number | null = null, skillLabel?: string): string {
  const entry = (AI_TOOL_STEP_LABELS as Record<string, { running: string; done: string; doneWithRows: string }>)[name];
  if (!entry) return phase === 'started' ? 'Reading workspace data…' : 'Read workspace data';
  if (phase === 'started') return entry.running;
  const template = rows !== null && rows >= 0 ? entry.doneWithRows : entry.done;
  return template.replace('{rows}', String(rows ?? '')).replace('{label}', skillLabel ?? 'a skill');
}
