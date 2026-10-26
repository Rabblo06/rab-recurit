import type { AiCapabilitiesView, AiInputAnswerRequest, AiInputRequestView, AiProposalDecisionResult, AiProposalFieldView, AiProposalView } from '@rab/shared';

import { api } from '../../shared/api';

/**
 * U5 (owner-approved 2026-10-26): approval, question and form cards. Every shape is a Phase 5 contract from
 * `@rab/shared` (types/ai-proposals.ts); the server decides every field, re-checks everything on approve / reject /
 * answer and runs the STORED arguments as the approver. The client never sends a status, an organisation or a field the
 * server did not mark editable.
 *
 * PENDING CONTRACT (Batch 3, Agent 9 confirmed the names): `AiProposalFieldView.previousValue` (S6) and
 * `AiCapabilitiesView.writeTools` (S4). Until they are in `@rab/shared` on this branch they are optional local fields;
 * absent = no diff / no write tools.
 */
export type AiProposalField = AiProposalFieldView & { previousValue?: string | number | null };
export type AiProposal = Omit<AiProposalView, 'fields'> & { fields: AiProposalField[] };
export type AiCapabilities = AiCapabilitiesView & { writeTools?: { name: string; label: string; summary: string }[] };
export type AiDecisionResult = Omit<AiProposalDecisionResult, 'proposal'> & { proposal: AiProposal };

export const aiCardsApi = {
  proposals: async (conversationId: string) => (await api.get<AiProposal[]>(`/ai/conversations/${encodeURIComponent(conversationId)}/proposals`)).data,
  /** Only the CHANGED editable fields travel in `edits`; `reason` only when the server asks for one (high impact). */
  approve: async (proposalId: string, edits: Record<string, string | number | null>, reason?: string) =>
    (await api.post<AiDecisionResult>(`/ai/proposals/${encodeURIComponent(proposalId)}/approve`, {
      ...(Object.keys(edits).length ? { edits } : {}),
      ...(reason ? { reason } : {}),
    })).data,
  reject: async (proposalId: string, reason: string) => (await api.post<AiDecisionResult>(`/ai/proposals/${encodeURIComponent(proposalId)}/reject`, { reason })).data,
  /** Every state, oldest first (each with `turnId` and `serverNow`). 404 = the route is not served here: no cards. */
  inputs: async (conversationId: string) => (await api.get<AiInputRequestView[]>(`/ai/conversations/${encodeURIComponent(conversationId)}/inputs`)).data,
  /** S7: answers `{ request, continuationTurnId }`; the continuation turn is followed from the transcript. */
  answer: async (conversationId: string, requestId: string, answer: AiInputAnswerRequest['answer']) =>
    (await api.post<{ request: AiInputRequestView; continuationTurnId: string | null }>(`/ai/conversations/${encodeURIComponent(conversationId)}/inputs/${encodeURIComponent(requestId)}/answer`, { answer } satisfies AiInputAnswerRequest)).data,
};

export const aiCardKeys = {
  proposals: (scope: string, conversationId: string) => ['ai', scope, 'conversation', conversationId, 'proposals'] as const,
  inputs: (scope: string, conversationId: string) => ['ai', scope, 'conversation', conversationId, 'inputs'] as const,
};

/** Fixed wording per write tool (the card title). An unknown tool shows a neutral title. */
export const AI_WRITE_TOOL_TITLE: Record<string, string> = {
  create_draft_shift: 'Create a draft shift',
  update_draft_shift: 'Update a draft shift',
  add_staff_note: 'Add a staff note',
};

/** The server's fixed texts for proposal / input refusals (the same words as the server exceptions). Never other text. */
export const AI_CARD_ERROR_TEXT: Record<string, string> = {
  AI_PROPOSAL_STALE: 'The record changed after this suggestion was made, so it was not applied.',
  AI_PROPOSAL_EXPIRED: 'This suggestion has expired. Ask the assistant again if you still want it.',
  AI_PROPOSAL_NOT_PENDING: 'This suggestion has already been decided.',
  AI_PROPOSAL_EDIT_INVALID: 'These changes cannot be applied to this suggestion. Check the highlighted fields.',
  AI_INPUT_INVALID: 'That answer does not fit what was asked. Check it and send again.',
  AI_INPUT_NOT_PENDING: 'This question has already been answered.',
  AI_INPUT_EXPIRED: 'This question has expired. Ask again if you still need it.',
  AI_NOT_AVAILABLE: 'The AI assistant is not available to you right now.',
};

/** A FAILED proposal's fixed failure code, in plain words. */
export const AI_PROPOSAL_FAILURE_TEXT: Record<string, string> = {
  stale: 'The record changed after this suggestion was made, so it was not applied.',
  not_permitted: 'You no longer have permission for this change, so it was not applied.',
  not_found: 'The record no longer exists, so nothing was changed.',
  conflict: 'This change conflicts with the record as it is now, so it was not applied.',
  invalid: 'This change was not valid, so it was not applied.',
  internal: 'Something went wrong. Nothing was changed.',
};
