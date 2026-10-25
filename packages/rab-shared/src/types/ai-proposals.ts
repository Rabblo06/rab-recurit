/**
 * AI contracts C0 — PROPOSAL APPROVALS AND INPUT REQUESTS (docs/ai/AI_CONTRACTS.md §2.5). Types and fixed values only.
 *
 * Every AI write is a proposal (rule 6.1/6.2): the model can only call `propose_action`; the server builds the summary;
 * only the user the proposal is for can approve it, in their own HTTP request (step-up for high impact); the executor
 * runs the STORED arguments once, through the domain service, as the approver. The transition TABLE
 * (`state/ai-proposal-transitions.ts`, mirrored by the DB trigger) is written by Phase 5 against the status type below.
 * Server-side contracts (`AiWriteToolDefinition`, `Prepared`, the executor) are in
 * `packages/rab-server/src/modules/ai/contracts/actions.ts`.
 */

/** `core.ai_action_proposal.status` (1786720220000 CHECK). Allowed edges (Phase 5): PENDING → APPROVED | REJECTED | EXPIRED | FAILED; APPROVED → EXECUTED | FAILED. */
export const AiProposalStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXECUTED: 'EXECUTED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
} as const;
export type AiProposalStatusType = (typeof AiProposalStatus)[keyof typeof AiProposalStatus];

/** The first write tools (P5 §2.2; mirrored by the DB CHECK on `tool` — a new one is a reviewed migration). "Send rota for review" does not exist (P5-D1). */
export const AI_WRITE_TOOL_NAMES = ['add_staff_note', 'create_draft_shift', 'update_draft_shift'] as const;
export type AiWriteToolName = (typeof AI_WRITE_TOOL_NAMES)[number];

export type AiProposalImpact = 'normal' | 'high';
/** `chat` = an interactive turn. `agent` = a Phase 6 run (storage only until EX-3 is decided; never written before then). */
export type AiProposalOrigin = 'chat' | 'agent';
export type AiProposalTargetType = 'shift' | 'staff_profile' | 'venue';
/** `ai_action_proposal.error_code` of a FAILED proposal (fixed codes, mapped from the domain exception class). */
export type AiProposalFailureCode = 'stale' | 'not_permitted' | 'not_found' | 'conflict' | 'invalid' | 'internal';

/** `propose_action` mode (Phase 6 contract): `interactive` pauses the turn; `agent` inserts PENDING and continues. */
export type AiProposeActionMode = 'interactive' | 'agent';

/** P5-D3, P5-D6, P5-D12, P5-D8, P6-D8. Server constants and the migration CHECKs must equal these. */
export const AI_PROPOSAL_LIMITS = {
  expiryMinutes: 15,
  /** Agent-origin proposals (P6-D8). Part of EX-3, which is NOT decided: unused until the owner approves EX-3. */
  agentExpiryHours: 24,
  perTurn: 5,
  alternativesPerGroup: 3,
  openInputRequestsPerTurn: 1,
  /** More than this many people affected = high impact (step-up + reason). */
  highImpactAboveAffected: 10,
  maxRequiredCount: 25,
  maxEditableFields: 10,
  maxArgumentsBytes: 8_192,
  reasonMinChars: 3,
  reasonMaxChars: 500,
  staffNoteMaxChars: 2_000,
  questionMaxChars: 300,
  questionOptionsMax: 5,
  questionOptionMaxChars: 80,
  formTitleMaxChars: 120,
  formFieldsMax: 8,
  formLabelMaxChars: 80,
} as const;

/** The step-up action a high-impact approval needs (a new `STEP_UP_ACTIONS` entry, added by Agent 9 at the 5a merge). */
export const AI_PROPOSAL_STEP_UP_ACTION = 'ai.proposal.approve_high_impact' as const;

/** Proposal / input HTTP error codes (409/400). Folded into `AiErrorCode` by Agent 9 at the Phase 5 merge. */
export const AiProposalHttpErrorCode = {
  PROPOSAL_EXPIRED: 'AI_PROPOSAL_EXPIRED',
  PROPOSAL_STALE: 'AI_PROPOSAL_STALE',
  PROPOSAL_NOT_PENDING: 'AI_PROPOSAL_NOT_PENDING',
  INPUT_INVALID: 'AI_INPUT_INVALID',
} as const;
export type AiProposalHttpErrorCodeType = (typeof AiProposalHttpErrorCode)[keyof typeof AiProposalHttpErrorCode];

/** How a card renders one argument. The server decides every field and whether it is editable. */
export type AiProposalFieldType = 'text' | 'multiline' | 'integer' | 'datetime';

export interface AiProposalFieldView {
  key: string;
  /** Fixed server label, rendered as plain text. */
  label: string;
  type: AiProposalFieldType;
  value: string | number | null;
  editable: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
}

/** One proposal card (`GET /rest/v1/ai/conversations/:id/proposals`, approve/reject answers). Owner only (RLS). */
export interface AiProposalView {
  id: string;
  conversationId: string;
  turnId: string;
  groupId: string | null;
  origin: AiProposalOrigin;
  tool: AiWriteToolName;
  /** Server-written, plain text. A note body appears only as a quoted field value, never in the summary. */
  summary: string;
  status: AiProposalStatusType;
  impact: AiProposalImpact;
  affectedCount: number;
  target: { type: AiProposalTargetType; id: string; label: string | null } | null;
  fields: AiProposalFieldView[];
  /** Approving needs a recent step-up (`AI_PROPOSAL_STEP_UP_ACTION`) and a reason. */
  requiresStepUp: boolean;
  requiresReason: boolean;
  expiresAt: string;
  /** The server's clock when this view was built: card countdowns use `expiresAt − serverNow`, never the client clock alone. */
  serverNow: string;
  createdAt: string;
  decidedAt: string | null;
  failureCode: AiProposalFailureCode | null;
  result: { entityType: string; entityId: string } | null;
}

/**
 * `POST /rest/v1/ai/proposals/:id/approve`. `edits` keys must be fields the server marked editable (else 400); the merged
 * arguments are re-parsed strictly and re-prepared (impact may rise and then need step-up). `organisationId`, `status`
 * or any other key is a 400 (forbidNonWhitelisted).
 */
export interface AiProposalApproveRequest {
  edits?: Record<string, string | number | null>;
  reason?: string;
}

/** `POST /rest/v1/ai/proposals/:id/reject`. A reason is required. Nothing changes. */
export interface AiProposalRejectRequest {
  reason: string;
}

export interface AiProposalDecisionResult {
  proposal: AiProposalView;
  /** The continuation turn queued after the decision (Phase 5b), or null (AI unavailable: the card shows the result). */
  continuationTurnId: string | null;
}

export type AiInputFieldType = 'text' | 'number' | 'date' | 'select';

/** One question or form card. Field keys/labels matching the output denylist (email, phone, address, …) are refused at creation. */
export interface AiInputRequestView {
  requestId: string;
  turnId: string;
  inputKind: 'question' | 'form';
  state: 'awaiting_input' | 'answered' | 'superseded' | 'expired';
  question: { text: string; options: string[]; allowFreeText: boolean } | null;
  form: { title: string; fields: { key: string; label: string; type: AiInputFieldType; options: string[] | null; required: boolean }[] } | null;
  expiresAt: string;
  serverNow: string;
}

/** `POST /rest/v1/ai/conversations/:id/inputs/:requestId/answer`. Treated as user input (input cap, masking, EX-1 scan). */
export interface AiInputAnswerRequest {
  /** A question: the chosen option or free text. A form: field key → value. */
  answer: string | Record<string, string | number | null>;
}
