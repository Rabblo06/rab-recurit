import { AI_AGENT_LIMITS, AI_AGENT_NAME_PATTERN, AiSkillContentRefusalCode } from '@rab/shared';

import { detectSensitiveContent, SensitiveCategory, SensitiveCategoryType } from '../gateway/outgoing-payload-guard';
import { AI_SKILL_CONTENT_REFUSAL_CODES, SKILL_CONTROL_MULTILINE, SKILL_CONTROL_SINGLELINE, SKILL_DATA_DELIMITER, SKILL_HIDDEN_UNICODE } from '../skills/skill-content-rules';

/**
 * Write-time content rules for an agent's text (docs/ai/PHASE6_TWENTY_PLAN.md C10): the instructions (`prompt`) will reach
 * a model in 6b after Crewflow's fixed preamble, so they are held to the SAME categories as organisation skills and
 * workspace instructions (P4 §2.4 / CD-4) — length, control characters, hidden Unicode, markup, data delimiters,
 * personal data (the EX-1 detector) and secret-like strings. Pure: no I/O, no logging; a refusal reports fixed CATEGORY
 * codes only (never the matched text).
 *
 *   name         AI_AGENT_NAME_PATTERN (fixes its character set)
 *   label        single line, 1..80 (trimmed non-empty)
 *   description  single line, 0..500 ('' is stored as NULL by the service)
 *   prompt       multi-line (\n and \t), 1..8,000 (trimmed non-empty) — AI_AGENT_LIMITS.promptMaxChars
 */
const DATA_DELIMITER_GLOBAL = new RegExp(SKILL_DATA_DELIMITER.source, 'gi');
const HTML_TAG_START = /<[a-z!/?]/i;
const MARKDOWN_IMAGE = /!\[/;
const PERSONAL: ReadonlySet<SensitiveCategoryType> = new Set([
  SensitiveCategory.EMAIL,
  SensitiveCategory.PHONE,
  SensitiveCategory.NI_NUMBER,
  SensitiveCategory.BANK_DETAILS,
  SensitiveCategory.POSTCODE,
  SensitiveCategory.CARD_NUMBER,
]);

export interface AiAgentTextFields {
  name?: unknown;
  label?: unknown;
  description?: unknown;
  prompt?: unknown;
}

type Kind = keyof AiAgentTextFields;

function withinBounds(kind: Kind, value: string): boolean {
  switch (kind) {
    case 'name':
      return AI_AGENT_NAME_PATTERN.test(value);
    case 'label':
      return value.trim().length >= 1 && value.length <= AI_AGENT_LIMITS.labelMaxChars;
    case 'description':
      return value.length <= AI_AGENT_LIMITS.descriptionMaxChars;
    case 'prompt':
      return value.trim().length >= 1 && value.length <= AI_AGENT_LIMITS.promptMaxChars;
  }
}

function check(kind: Kind, value: unknown, found: Set<AiSkillContentRefusalCode>): void {
  if (typeof value !== 'string') {
    found.add('length');
    return;
  }
  if (!withinBounds(kind, value)) found.add('length');
  if ((kind === 'prompt' ? SKILL_CONTROL_MULTILINE : SKILL_CONTROL_SINGLELINE).test(value)) found.add('control_characters');
  if (SKILL_HIDDEN_UNICODE.test(value)) found.add('hidden_unicode');
  if (SKILL_DATA_DELIMITER.test(value)) found.add('data_delimiter');
  const rest = value.replace(DATA_DELIMITER_GLOBAL, ' ');
  if (HTML_TAG_START.test(rest) || MARKDOWN_IMAGE.test(rest)) found.add('markup');
  if (kind === 'name') return;
  for (const category of detectSensitiveContent(value)) found.add(PERSONAL.has(category) ? 'personal_data' : 'secret_like');
}

/** The refusal categories of an agent write in AI_SKILL_CONTENT_REFUSAL_CODES order; `[]` = allowed. Only present fields are checked. */
export function agentTextRefusals(fields: AiAgentTextFields): AiSkillContentRefusalCode[] {
  const found = new Set<AiSkillContentRefusalCode>();
  for (const kind of ['name', 'label', 'description', 'prompt'] as const) {
    if (fields[kind] !== undefined) check(kind, fields[kind], found);
  }
  return AI_SKILL_CONTENT_REFUSAL_CODES.filter((code) => found.has(code));
}
