/**
 * AI contracts C0 — SKILL LOADING (docs/ai/AI_CONTRACTS.md §2.4). Types, names and limits only: no behaviour.
 *
 * Skills are instructions only; they grant no permission and no tool (Phase 4 G1–G5). Built-in text lives in code;
 * `core.ai_skill` holds custom skills plus an on/off row per switched built-in (no NULL-organisation rows, FORCE RLS).
 * Only `name: description` lines enter the system prompt (after the fixed text); full text reaches the model only as a
 * wrapped `load_skills` result.
 */

/**
 * The built-in skills (resolution XD-4 / X-8). `holiday-planning` is DROPPED until a leave feature exists (no tool can
 * back it). `rota-building` and `timesheet-review` keep their names but their text is written against the real Phase 3
 * tools only (coverage gaps / unfilled shifts / counts; no "anomalies" the tools do not report). The Phase 4 migration's
 * CHECK on `ai_skill.name` for `is_system` rows must list exactly these names.
 */
export const AI_BUILTIN_SKILL_NAMES = ['coverage-report', 'crewflow-help', 'rota-building', 'shift-filling', 'timesheet-review', 'venue-onboarding'] as const;
export type AiBuiltinSkillName = (typeof AI_BUILTIN_SKILL_NAMES)[number];

/** Custom and built-in skill names. */
export const AI_SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{1,47}$/;

/** P4-D6 / P4 §2.1 / P4-D9. Server constants and the migration CHECKs must equal these. */
export const AI_SKILL_LIMITS = {
  maxContentChars: 20_000,
  maxLabelChars: 80,
  maxDescriptionChars: 300,
  maxCustomPerOrganisation: 50,
  maxPerLoad: 3,
  maxTaggedPerMessage: 2,
  turnCharBudget: 24_000,
  /** Extra tokens per step added to the turn reservation while the organisation has active skills (P4-D9). */
  tokenAllowancePerStep: 8_000,
  reasonMinChars: 3,
  reasonMaxChars: 500,
} as const;

/** Skill-specific HTTP error codes (`code` on 400/409). Folded into `AiErrorCode` by Agent 9 at the Phase 4 merge. */
export const AiSkillErrorCode = {
  SKILL_NOT_AVAILABLE: 'AI_SKILL_NOT_AVAILABLE',
  SKILL_CONTENT_REFUSED: 'AI_SKILL_CONTENT_REFUSED',
  SKILL_LIMIT_REACHED: 'AI_SKILL_LIMIT_REACHED',
  /** p4 merge (Agent 4 REQUEST Q1, provisional): a custom skill name already used in the organisation or a built-in's. */
  SKILL_NAME_TAKEN: 'AI_SKILL_NAME_TAKEN',
} as const;
export type AiSkillErrorCodeType = (typeof AiSkillErrorCode)[keyof typeof AiSkillErrorCode];

/** Fixed category codes of a refused skill write (never the matched text). */
export type AiSkillContentRefusalCode =
  | 'length'
  | 'control_characters'
  | 'hidden_unicode'
  | 'markup'
  | 'data_delimiter'
  | 'personal_data'
  | 'secret_like';

/** One row of Settings → AI → Skills (`GET /rest/v1/ai/settings/skills`; CEO + `ai.settings`). */
export interface AiSkillView {
  /** null for a built-in that has never been switched (no row yet). */
  id: string | null;
  name: string;
  label: string;
  description: string;
  isSystem: boolean;
  isActive: boolean;
  /** Custom skills only (the editor); null for built-ins, whose text is code and shown read-only elsewhere. */
  content: string | null;
  contentLength: number;
  updatedAt: string | null;
}

export interface AiSkillSettingsView {
  skills: AiSkillView[];
  customCount: number;
  limits: typeof AI_SKILL_LIMITS;
}

/** The composer's tag menu (`GET /rest/v1/ai/skills`, behind AiAvailableGuard): active skills, no content. */
export interface AiSkillSummaryView {
  name: string;
  label: string;
  description: string;
}

/** `POST /rest/v1/ai/settings/skills`. A body with `organisationId`, `isSystem` or `isActive` is a 400. */
export interface AiSkillCreateRequest {
  name: string;
  label: string;
  description: string;
  content: string;
  reason: string;
}

/** `PATCH /rest/v1/ai/settings/skills/:id`. `name` cannot change (400). */
export interface AiSkillUpdateRequest {
  label?: string;
  description?: string;
  content?: string;
  reason: string;
}

/** Body of every named skill action (activate / deactivate / delete / built-in toggles). */
export interface AiSkillActionRequest {
  reason: string;
}
