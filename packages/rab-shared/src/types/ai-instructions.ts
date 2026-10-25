/**
 * AI contracts C1 — WORKSPACE INSTRUCTIONS (TWENTY_UI_CONTRACT_DELTAS CD-4 / TW-D5; security rule 5.3).
 *
 * Organisation-authored text (CEO only), ≤ 2,000 characters, checked at write time by the Phase 4 content rules
 * (`skills/skill-content-rules.ts`: length, control characters, hidden Unicode, markup, `<data` delimiter, personal data,
 * secret-like, the EX-1 detector — refusal codes only, never the matched text). Placed AFTER the fixed system prompt
 * under a fixed header, never interpolated anywhere else, included in the EX-1 outgoing scan and the prompt preview, and
 * it can never change the tool set. Stored in `core.organisation_ai_instruction`.
 */
import type { AiSkillContentRefusalCode } from './ai-skills';

export const AI_INSTRUCTIONS_LIMITS = { maxChars: 2_000, reasonMinChars: 3, reasonMaxChars: 500 } as const;

/** The step-up action every instructions write needs (added to `STEP_UP_ACTIONS` by Agent 9 with its adoption test). */
export const AI_INSTRUCTIONS_STEP_UP_ACTION = 'organisation.ai.instructions.update' as const;

/** Refusal codes are the Phase 4 skill content codes (one rule set for both). */
export type AiInstructionsRefusalCode = AiSkillContentRefusalCode;

/** `GET /rest/v1/ai/settings/instructions` (CEO + `ai.settings`). */
export interface AiWorkspaceInstructionsView {
  /** null = none set. */
  content: string | null;
  contentLength: number;
  contentSha256: string | null;
  updatedAt: string | null;
  limits: typeof AI_INSTRUCTIONS_LIMITS;
}

/** `PUT /rest/v1/ai/settings/instructions` (step-up `AI_INSTRUCTIONS_STEP_UP_ACTION` + reason; audited `ai.instructions_updated`, length + hash only). */
export interface AiWorkspaceInstructionsUpdateRequest {
  content: string;
  reason: string;
}

/** `DELETE /rest/v1/ai/settings/instructions` (same step-up + reason). */
export interface AiWorkspaceInstructionsDeleteRequest {
  reason: string;
}
