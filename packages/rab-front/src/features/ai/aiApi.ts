import type { AiErrorCodeType, AiToolCallSummary, AiUnavailableReasonType } from '@rab/shared';

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

export type AiAvailability =
  | { available: true; reason: null; limits: AiLimits; usage: { day: string; tokensUsedOrReserved: number } }
  | { available: false; reason: AiUnavailableReasonType; limits: AiLimits; usage: null };

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
  toolCalls: AiToolCallSummary[];
  createdAt: string;
  completedAt: string | null;
}

export interface AiConversationDetail {
  conversation: AiConversation;
  messages: AiMessage[];
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
  submit: async (conversationId: string, content: string, clientRequestId: string) =>
    (await api.post<AiSubmitResult>(`/ai/conversations/${encodeURIComponent(conversationId)}/messages`, { content, clientRequestId })).data,
  cancel: async (conversationId: string, turnId: string) =>
    (await api.post<{ turnId: string; status: string }>(`/ai/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/cancel`, {})).data,
  remove: async (id: string) => {
    await api.delete(`/ai/conversations/${encodeURIComponent(id)}`);
  },
};

/** React Query keys, always scoped by the provider's identity key so one account's AI data never shows for another. */
export const aiKeys = {
  all: (scope: string) => ['ai', scope] as const,
  availability: (scope: string) => ['ai', scope, 'availability'] as const,
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
  AI_INTERNAL_ERROR: 'Something went wrong while preparing this answer. Please ask again.',
};

/** Friendly names for the five Phase 1 read tools (shown while a tool runs; the name only, never data). */
export const AI_TOOL_LABEL: Record<string, string> = {
  list_unfilled_shifts: 'Checking unfilled shifts',
  get_fill_rate: 'Calculating the fill rate',
  get_attendance_summary: 'Counting attendance records',
  get_offer_status: 'Counting offers by status',
  compare_payroll_runs: 'Comparing payroll run totals',
};
