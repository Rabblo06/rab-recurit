import { AI_SKILL_LIMITS, AI_SKILL_NAME_PATTERN } from '@rab/shared';

import { AI_SKILL_CATALOGUE_HEADER, AiSkillCatalogueLine } from '../contracts/skills';
import { SKILL_HIDDEN_UNICODE_GLOBAL } from './skill-content-rules';

/**
 * The skill catalogue block appended AFTER the fixed system prompt (docs/ai/PHASE4_TWENTY_PLAN.md §2.3 (1), P4-D10,
 * conflict C2). Pure and byte-stable — the same lines always give the same bytes (Phase 7 prompt caching):
 *   - the fixed header AI_SKILL_CATALOGUE_HEADER, then one `- name: description` line per skill;
 *   - sorted by name with a plain code-unit comparison (never `localeCompare`, which depends on the runtime's ICU);
 *   - a name that does not match AI_SKILL_NAME_PATTERN is dropped; a duplicate name keeps its first line;
 *   - descriptions are escaped AGAIN (they were checked at write time): controls and newlines become a space (a skill can
 *     never forge a second catalogue line or a new prompt paragraph), invisible/bidi characters and `<`/`>` are removed,
 *     whitespace is collapsed and the text is capped at AI_SKILL_LIMITS.maxDescriptionChars;
 *   - no line → '' (the prompt is then exactly the fixed text).
 * Only names and descriptions are listed: the full text reaches the model only as a wrapped `load_skills` result.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_ALL = /[\u0000-\u001F\u007F-\u009F]/g;

export function escapeCatalogueText(value: string): string {
  const cleaned = String(value).replace(CONTROL_ALL, ' ').replace(SKILL_HIDDEN_UNICODE_GLOBAL, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= AI_SKILL_LIMITS.maxDescriptionChars) return cleaned;
  const cut = cleaned.slice(0, AI_SKILL_LIMITS.maxDescriptionChars);
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd();
}

/**
 * S9 (Batch 3): the catalogue's skill LINES exactly as the prompt carries them (`- name: description`: sorted, escaped,
 * deduplicated), without the header. `buildSkillCatalogue` is the header plus these lines joined by '\n', so the Settings
 * prompt preview's `skillCatalogue` (these lines) is byte-equal to what the turn sends.
 */
export function skillCatalogueLines(lines: readonly AiSkillCatalogueLine[]): string[] {
  const byName = new Map<string, string>();
  for (const line of lines) {
    if (typeof line?.name !== 'string' || !AI_SKILL_NAME_PATTERN.test(line.name) || byName.has(line.name)) continue;
    const description = escapeCatalogueText(typeof line.description === 'string' ? line.description : '');
    if (description) byName.set(line.name, description);
  }
  const names = [...byName.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.map((name) => `- ${name}: ${byName.get(name)}`);
}

export function buildSkillCatalogue(lines: readonly AiSkillCatalogueLine[]): string {
  const entries = skillCatalogueLines(lines);
  if (entries.length === 0) return '';
  return [AI_SKILL_CATALOGUE_HEADER, ...entries].join('\n');
}
