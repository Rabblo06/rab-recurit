import { AI_SKILL_LIMITS, AI_SKILL_NAME_PATTERN, AiSkillContentRefusalCode } from '@rab/shared';

import { detectSensitiveContent, SensitiveCategory, SensitiveCategoryType } from '../gateway/outgoing-payload-guard';

/**
 * Write-time content rules for organisation-authored skills (docs/ai/PHASE4_TWENTY_PLAN.md §2.4, P4-D7). Pure: no I/O,
 * no logging. A refused write answers 400 `AI_SKILL_CONTENT_REFUSED` with the fixed CATEGORY codes below — never the
 * matched text, so neither the response nor a log can quote what was refused.
 *
 * Skill text is treated like rule 5.3 "custom instructions": it reaches the model (the description through the prompt
 * catalogue, the full text as a wrapped `load_skills` result), so it is checked here, before it is stored:
 *   - length      every field inside its bounds (name = AI_SKILL_NAME_PATTERN, which also fixes its character set —
 *                 the contract has no separate "format" code; see REQUEST.md);
 *   - control_characters  C0/C1 controls (content keeps `\n` and `\t`; name/label/description are single-line);
 *   - hidden_unicode      bidi overrides/isolates, zero-width and joiner characters, tag characters, soft hyphen, BOM,
 *                 line/paragraph separators, variation-selector supplement (the "ASCII smuggling" ranges);
 *   - data_delimiter      `<data`, `</data` or `<skill` (the tool-result wrappers);
 *   - markup      a raw HTML tag start (`<a`, `</`, `<!`, `<?`) or a Markdown image `![` (rule 8.2: never an image);
 *   - personal_data       what the EX-1 payload guard flags: email outside example.test, phone, NI number, bank details,
 *                 postcode, card number — so a skill can neither carry personal data (rule 3.2) nor make every real-provider
 *                 request of its organisation refuse (conflict C4);
 *   - secret_like JWTs, prefixed keys, bearer strings and long opaque tokens (the same detector).
 * Links are allowed as plain text (the chat renders Markdown without raw HTML or images).
 */

/** The fixed order codes are reported in (stable for clients and tests). */
export const AI_SKILL_CONTENT_REFUSAL_CODES: readonly AiSkillContentRefusalCode[] = [
  'length',
  'control_characters',
  'hidden_unicode',
  'markup',
  'data_delimiter',
  'personal_data',
  'secret_like',
];

/** C0 and C1 controls except TAB and LF (multi-line content). CR is refused: content is stored with `\n` line ends. */
// eslint-disable-next-line no-control-regex
export const SKILL_CONTROL_MULTILINE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
/** Every C0 and C1 control (single-line fields: name, label, description — a newline there could forge a catalogue line). */
// eslint-disable-next-line no-control-regex
export const SKILL_CONTROL_SINGLELINE = /[\u0000-\u001F\u007F-\u009F]/;
/**
 * Invisible / direction-changing characters (P4 §2.4: U+202A–202E, U+2066–2069, U+200B–200F, U+E0000–E007F; plus the
 * soft hyphen, Arabic letter mark, Mongolian vowel separator, word joiner and invisible operators, line/paragraph
 * separators, BOM and the variation-selector supplement). The `u` flag is required for the astral ranges.
 */
export const SKILL_HIDDEN_UNICODE = /[\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
export const SKILL_HIDDEN_UNICODE_GLOBAL = new RegExp(SKILL_HIDDEN_UNICODE.source, 'gu');
/** The tool-result delimiters: `<data`, `</data`, `<skill` (whitespace and case tolerant). */
export const SKILL_DATA_DELIMITER = /<\s*\/?\s*(?:data|skill)/i;
const SKILL_DATA_DELIMITER_GLOBAL = new RegExp(SKILL_DATA_DELIMITER.source, 'gi');
/** The start of a raw HTML tag, comment, doctype or processing instruction (`a < b` stays allowed text). */
const HTML_TAG_START = /<[a-z!/?]/i;
/** A Markdown image (inline or reference style). */
const MARKDOWN_IMAGE = /!\[/;

const PERSONAL: ReadonlySet<SensitiveCategoryType> = new Set([
  SensitiveCategory.EMAIL,
  SensitiveCategory.PHONE,
  SensitiveCategory.NI_NUMBER,
  SensitiveCategory.BANK_DETAILS,
  SensitiveCategory.POSTCODE,
  SensitiveCategory.CARD_NUMBER,
]);

/** The fields a skill write may carry (a field left `undefined` is not being written and is not checked). */
export interface AiSkillFieldsInput {
  name?: unknown;
  label?: unknown;
  description?: unknown;
  content?: unknown;
}

type FieldKind = 'name' | 'label' | 'description' | 'content';

function withinBounds(kind: FieldKind, value: string): boolean {
  if (kind === 'name') return AI_SKILL_NAME_PATTERN.test(value);
  const max = kind === 'label' ? AI_SKILL_LIMITS.maxLabelChars : kind === 'description' ? AI_SKILL_LIMITS.maxDescriptionChars : AI_SKILL_LIMITS.maxContentChars;
  return value.trim().length >= 1 && value.length <= max;
}

function checkField(kind: FieldKind, value: unknown, found: Set<AiSkillContentRefusalCode>): void {
  if (typeof value !== 'string') {
    found.add('length');
    return;
  }
  if (!withinBounds(kind, value)) found.add('length');
  if ((kind === 'content' ? SKILL_CONTROL_MULTILINE : SKILL_CONTROL_SINGLELINE).test(value)) found.add('control_characters');
  if (SKILL_HIDDEN_UNICODE.test(value)) found.add('hidden_unicode');
  if (SKILL_DATA_DELIMITER.test(value)) found.add('data_delimiter');
  // A data delimiter is reported as such, not ALSO as markup; any other tag start is markup.
  const rest = value.replace(SKILL_DATA_DELIMITER_GLOBAL, ' ');
  if (HTML_TAG_START.test(rest) || MARKDOWN_IMAGE.test(rest)) found.add('markup');
  if (kind === 'name') return;
  for (const category of detectSensitiveContent(value)) found.add(PERSONAL.has(category) ? 'personal_data' : 'secret_like');
}

/**
 * The refusal categories of a skill write, in AI_SKILL_CONTENT_REFUSAL_CODES order; `[]` = allowed. Only the fields
 * present (not `undefined`) are checked: a PATCH checks what it changes.
 */
export function skillContentRefusals(fields: AiSkillFieldsInput): AiSkillContentRefusalCode[] {
  const found = new Set<AiSkillContentRefusalCode>();
  for (const kind of ['name', 'label', 'description', 'content'] as const) {
    if (fields[kind] !== undefined) checkField(kind, fields[kind], found);
  }
  return AI_SKILL_CONTENT_REFUSAL_CODES.filter((code) => found.has(code));
}
