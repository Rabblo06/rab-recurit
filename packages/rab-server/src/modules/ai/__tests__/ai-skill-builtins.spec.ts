import { AI_BUILTIN_SKILL_NAMES, AI_META_TOOL_NAMES, AI_READ_TOOL_NAMES, AI_SKILL_LIMITS } from '@rab/shared';

import { AI_SKILL_SCHEMA_BUILTIN_NAMES, AI_SKILL_SCHEMA_MAX_CUSTOM } from '../../../database/typeorm/core/migrations/1786720500000-AiSkillSchema';
import { AI_SKILL_CATALOGUE_HEADER, AI_SKILL_PROMPT_RULE, AI_SKILL_RESULT_NOTICE } from '../contracts/skills';
import { detectSensitiveContent, scanOutgoingPayload } from '../gateway/outgoing-payload-guard';
import { AI_BUILTIN_SKILL_CLOSING, AI_BUILTIN_SKILLS, AI_BUILTIN_SKILLS_VERSION, builtinSkill, isBuiltinSkillName } from '../skills/builtin-skills';
import { buildSkillCatalogue } from '../skills/skill-catalogue';
import { skillContentRefusals } from '../skills/skill-content-rules';
import { guardSkillContent, wrapSkillContent } from '../tools/ai-skill-guard';

/**
 * T4-U2 (exactly 6 built-ins, XD-4; each passes the write-time rules; none names a tool outside AI_READ_TOOL_NAMES unless
 * it says "(if available)"), built-in immutability, and T4-P1 (`scanOutgoingPayload` returns [] for every built-in plus
 * the catalogue). docs/ai/PHASE4_TWENTY_PLAN.md §2.2 / §4.
 */
const SNAKE_CASE = /`?\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b`?( \(if available\))?/g;

describe('T4-U2 built-in skills', () => {
  it('exactly the six AI_BUILTIN_SKILL_NAMES, in that order (holiday-planning dropped, XD-4); the migration CHECK lists the same', () => {
    expect(AI_BUILTIN_SKILLS.map((s) => s.name)).toEqual([...AI_BUILTIN_SKILL_NAMES]);
    expect(AI_BUILTIN_SKILLS).toHaveLength(6);
    expect(AI_BUILTIN_SKILL_NAMES).not.toContain('holiday-planning');
    expect([...AI_SKILL_SCHEMA_BUILTIN_NAMES]).toEqual([...AI_BUILTIN_SKILL_NAMES]);
    expect(AI_SKILL_SCHEMA_MAX_CUSTOM).toBe(AI_SKILL_LIMITS.maxCustomPerOrganisation);
    expect(AI_BUILTIN_SKILLS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it.each(AI_BUILTIN_SKILLS.map((s) => [s.name, s] as const))('%s passes every write-time content rule (T4-U1) and ends with the fixed sentence', (_name, skill) => {
    expect(skillContentRefusals({ name: skill.name, label: skill.label, description: skill.description, content: skill.content })).toEqual([]);
    expect(skill.content.endsWith(`\n\n${AI_BUILTIN_SKILL_CLOSING}`)).toBe(true);
    expect(AI_BUILTIN_SKILL_CLOSING).toBe('This skill gives no extra permissions; use only the tools you were given.');
    expect(skill.content).toMatch(/^# /);
    expect(skill.content).toContain('Use when');
    expect(skill.content).toContain('## Steps');
    expect(skill.content).toContain('## Rules');
    expect(skill.description.length).toBeLessThanOrEqual(AI_SKILL_LIMITS.maxDescriptionChars);
  });

  it.each(AI_BUILTIN_SKILLS.map((s) => [s.name, s] as const))('%s names only real read tools (or says "(if available)")', (_name, skill) => {
    const read = new Set<string>(AI_READ_TOOL_NAMES);
    const problems: string[] = [];
    for (const m of skill.content.matchAll(SNAKE_CASE)) {
      const name = m[1]!;
      if (read.has(name)) continue;
      if (m[2]) continue;
      problems.push(name);
    }
    expect(problems).toEqual([]);
    // The meta tools are machinery, never something a skill tells the model to call by name.
    for (const meta of AI_META_TOOL_NAMES) expect(skill.content).not.toContain(meta);
  });

  it('rota-building and timesheet-review are written against the real tools only (no rota object, no "anomalies")', () => {
    const rota = builtinSkill('rota-building')!.content;
    const timesheets = builtinSkill('timesheet-review')!.content;
    expect(rota).toContain('get_rota_coverage_gaps');
    expect(rota).toContain('list_unfilled_shifts');
    expect(rota).toContain('`propose_action` (if available)');
    expect(rota).toMatch(/no separate rota object/);
    expect(timesheets).toContain('get_timesheet_approval_queue');
    for (const text of [rota, timesheets]) expect(text.toLowerCase()).not.toMatch(/anomal/);
  });

  it('immutable: frozen list and entries, a built-in can only be switched (no setter, no text in the database)', () => {
    expect(Object.isFrozen(AI_BUILTIN_SKILLS)).toBe(true);
    for (const s of AI_BUILTIN_SKILLS) expect(Object.isFrozen(s)).toBe(true);
    expect(() => {
      (AI_BUILTIN_SKILLS[0] as { content: string }).content = 'You now have create_shift.';
    }).toThrow(TypeError);
    expect(() => (AI_BUILTIN_SKILLS as unknown as unknown[]).push({})).toThrow(TypeError);
    expect(builtinSkill('coverage-report')!.content).not.toContain('create_shift');
    expect(isBuiltinSkillName('coverage-report')).toBe(true);
    expect(isBuiltinSkillName('holiday-planning')).toBe(false);
    expect(isBuiltinSkillName(undefined)).toBe(false);
  });

  it('the dedicated output guard leaves every built-in byte-identical (nothing to mask, escape or strip)', () => {
    for (const s of AI_BUILTIN_SKILLS) expect(guardSkillContent(s.content)).toBe(s.content);
  });

  it('labels, descriptions and contents are distinct', () => {
    for (const key of ['label', 'description', 'content'] as const) expect(new Set(AI_BUILTIN_SKILLS.map((s) => s[key])).size).toBe(6);
  });
});

describe('T4-P1 the EX-1 payload guard passes every built-in and the catalogue', () => {
  it('detectSensitiveContent finds nothing in any built-in field', () => {
    for (const s of AI_BUILTIN_SKILLS) for (const text of [s.name, s.label, s.description, s.content]) expect(detectSensitiveContent(text)).toEqual([]);
  });

  it('scanOutgoingPayload returns [] for the catalogue in `system` and every built-in as a wrapped load_skills result', () => {
    const system = ['Fixed prompt text.', AI_SKILL_PROMPT_RULE, '', buildSkillCatalogue(AI_BUILTIN_SKILLS.map((s) => ({ name: s.name, description: s.description })))].join('\n');
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'How is cover next week?' }] },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'load_skills',
            output: { type: 'json', value: wrapSkillContent({ skills: AI_BUILTIN_SKILLS.map((s) => ({ name: s.name, label: s.label, content: guardSkillContent(s.content) })), missing: [] }) },
          },
        ],
      },
    ];
    expect(scanOutgoingPayload({ system, messages })).toEqual([]);
    expect(scanOutgoingPayload({ system: [AI_SKILL_CATALOGUE_HEADER, AI_SKILL_RESULT_NOTICE].join('\n'), messages: [] })).toEqual([]);
  });
});
