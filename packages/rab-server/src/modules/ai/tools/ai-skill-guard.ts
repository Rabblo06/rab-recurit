import { AI_SKILL_LIMITS } from '@rab/shared';

import { AI_SKILL_RESULT_NOTICE } from '../contracts/skills';
import { SKILL_HIDDEN_UNICODE_GLOBAL } from '../skills/skill-content-rules';
import { maskSensitiveText } from './ai-output-guard';

/**
 * The dedicated output guard of the `load_skills` meta tool (docs/ai/PHASE4_TWENTY_PLAN.md §2.5 G5, conflict C3). Pure.
 *
 * Skill text is checked when it is WRITTEN (skills/skill-content-rules.ts); this is defence in depth on the way OUT, so a
 * row that predates a rule, or a built-in edited carelessly, still cannot reach the model as structure:
 *   1. CR LF / CR → LF; every other C0/C1 control except TAB and LF is removed;
 *   2. bidi, zero-width, tag and other invisible characters are removed again;
 *   3. the tool-result delimiters `<data`, `</data` and `<skill` are escaped (`&lt;data` …), so skill text can never
 *      open or close a data block;
 *   4. email addresses, NI numbers, sort codes and long digit runs are masked (`maskSensitiveText`, the record guard's
 *      masking — the request-time payload guard stays the second net);
 *   5. capped at AI_SKILL_LIMITS.maxContentChars, last, so the result never exceeds it (never splitting a surrogate pair).
 * The generic `guardToolOutput` is deliberately NOT used: its 160-character cap and `note` denylist are for record data
 * and stay unchanged there.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_TAB_LF = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_ALL = /[\u0000-\u001F\u007F-\u009F]/g;
const DATA_DELIMITER = /<(\s*\/?\s*)(data|skill)/gi;

function capChars(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = value.slice(0, max);
  // Never leave a lone high surrogate at the end.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

/** The full text of one skill on its way to the model. Idempotent for text that already passes the content rules. */
export function guardSkillContent(content: string): string {
  const cleaned = String(content)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_EXCEPT_TAB_LF, '')
    .replace(SKILL_HIDDEN_UNICODE_GLOBAL, '')
    .replace(DATA_DELIMITER, (_m, gap: string, word: string) => `&lt;${gap}${word}`);
  return capChars(maskSensitiveText(cleaned), AI_SKILL_LIMITS.maxContentChars);
}

/** A single-line skill field on its way to the model (the label): no controls, no invisible characters, no `<`/`>`. */
export function guardSkillLine(value: string, max: number = AI_SKILL_LIMITS.maxLabelChars): string {
  const cleaned = String(value).replace(CONTROL_ALL, ' ').replace(SKILL_HIDDEN_UNICODE_GLOBAL, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return capChars(maskSensitiveText(cleaned), max);
}

/** A wrapped `load_skills` result (the same `{notice, tool, data}` shape as every record tool result). */
export interface AiWrappedSkillResult<T> {
  notice: typeof AI_SKILL_RESULT_NOTICE;
  tool: 'load_skills';
  data: T;
}

/** The wrapper of every `load_skills` result: the model receives skill text only inside `data`, under the fixed notice. */
export function wrapSkillContent<T>(data: T): AiWrappedSkillResult<T> {
  return { notice: AI_SKILL_RESULT_NOTICE, tool: 'load_skills', data };
}
