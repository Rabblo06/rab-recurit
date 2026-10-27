/**
 * AI contracts C1 — ASSISTANT NAME AND AVATAR per organisation (TWENTY_UI_CONTRACT_DELTAS CD-3 / TW-D4 / TW-D15).
 *
 * Presentation only: the name is NEVER sent to the model, never placed in any prompt, always shown with an "AI" badge
 * and rendered as plain text. Stored in `core.organisation_ai_assistant` (not `organisation_ai_setting`, which only
 * platform admins write). No row = the default preset. Original Crewflow artwork only (no Twenty names, shapes or files).
 */

/**
 * Owner decision 2026-10-26: ROUND ONLY. The `shape` field stays so a future shape is a contract + CHECK change, never a
 * schema change; the reusable avatar component should render by `shape` with a round fallback, so it stays compatible
 * with future shapes. Any other value is a 400 (DTO) and a 23514 (DB CHECK, AiAssistantRoundOnly1786720990000).
 * The C1 list of 10 silhouettes is frozen in AiAssistantProfile1786720900000 for its down() only.
 */
export const AI_ASSISTANT_SHAPES = ['circle'] as const;
export type AiAssistantShape = (typeof AI_ASSISTANT_SHAPES)[number];

/** 10 colour tokens (`--ai-avatar-{colour}-body` / `-face`), brand orange first. Mirrored by the DB CHECK. */
export const AI_ASSISTANT_COLOURS = ['orange', 'amber', 'green', 'teal', 'sky', 'blue', 'violet', 'rose', 'red', 'grey'] as const;
export type AiAssistantColour = (typeof AI_ASSISTANT_COLOURS)[number];

/** 6 face glyph sets (K7). Mirrored by the DB CHECK. */
export const AI_ASSISTANT_FACES = ['classic', 'smile', 'tall', 'round', 'calm', 'warm'] as const;
export type AiAssistantFace = (typeof AI_ASSISTANT_FACES)[number];

/** Crewflow's own presets (B3–B9). Names are placeholders for the owner's review (TW-D4); keys are the contract. */
export const AI_ASSISTANT_PRESETS = {
  crewflow: { name: 'Crewflow', shape: 'circle', colour: 'orange', face: 'classic' },
  amber: { name: 'Amber', shape: 'circle', colour: 'amber', face: 'smile' },
  sky: { name: 'Sky', shape: 'circle', colour: 'sky', face: 'round' },
  clover: { name: 'Clover', shape: 'circle', colour: 'green', face: 'calm' },
  violet: { name: 'Violet', shape: 'circle', colour: 'violet', face: 'tall' },
  rosa: { name: 'Rosa', shape: 'circle', colour: 'rose', face: 'warm' },
  teal: { name: 'Teal', shape: 'circle', colour: 'teal', face: 'classic' },
} as const satisfies Record<string, { name: string; shape: AiAssistantShape; colour: AiAssistantColour; face: AiAssistantFace }>;
export type AiAssistantPreset = keyof typeof AI_ASSISTANT_PRESETS;
export const AI_ASSISTANT_PRESET_KEYS = Object.keys(AI_ASSISTANT_PRESETS) as AiAssistantPreset[];
export const AI_DEFAULT_ASSISTANT_PRESET: AiAssistantPreset = 'crewflow';

export const AI_ASSISTANT_LIMITS = { nameMinChars: 1, nameMaxChars: 24 } as const;

/** `GET /rest/v1/ai/settings/assistant`, and `assistant` in `GET /rest/v1/ai/availability`. */
export interface AiAssistantProfileView {
  /** null = a customised profile (no preset). */
  preset: AiAssistantPreset | null;
  /** Plain text, ≤ 24 characters, no control / bidi / zero-width characters. Never sent to the model. */
  name: string;
  shape: AiAssistantShape;
  colour: AiAssistantColour;
  face: AiAssistantFace;
  /** Avatar animation (off anyway under prefers-reduced-motion). */
  animate: boolean;
  /** No row stored: the default preset. */
  isDefault: boolean;
  updatedAt: string | null;
}

/**
 * `PUT /rest/v1/ai/settings/assistant` (CEO + `ai.settings`; cosmetic: no step-up, no reason; audited
 * `ai.assistant_profile_changed` with the changed field names and enum values only). Either a `preset` alone, or a
 * custom profile (all of name/shape/colour/face). `organisationId` or any unknown key → 400.
 * `DELETE /rest/v1/ai/settings/assistant` = "Reset to default".
 */
export interface AiAssistantProfileUpdateRequest {
  preset?: AiAssistantPreset;
  name?: string;
  shape?: AiAssistantShape;
  colour?: AiAssistantColour;
  face?: AiAssistantFace;
  animate?: boolean;
}
