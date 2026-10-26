/**
 * AI contracts C0 (docs/ai/AI_CONTRACTS.md): pins the owner decisions and cross-plan resolutions the contract files encode,
 * so a feature branch cannot change them silently. A change here is an owner decision plus an integration request.
 */
import {
  AI_API_ROUTES,
  AI_BUILTIN_SKILL_NAMES,
  AI_MAX_SDK_TOOLS,
  AI_META_TOOL_NAMES,
  AI_PAUSE_TOOL_NAMES,
  AI_READ_TOOL_NAMES,
  AI_RATE_LIMIT_DEFAULTS,
  AI_WRITE_TOOL_NAMES,
  AiTurnStatusV2,
  AI_ASSISTANT_COLOURS,
  AI_ASSISTANT_FACES,
  AI_ASSISTANT_PRESETS,
  AI_ASSISTANT_SHAPES,
  AI_DATA_RESIDENCIES,
  AI_DEFAULT_ALLOWED_LEVELS,
  AI_DEFAULT_CHAT_LEVEL,
  AI_INSTRUCTIONS_LIMITS,
  AI_MODEL_LEVEL_KEYS,
  AI_PROMPT_SECTION_KEYS,
  AI_PROMPT_SECTION_SEPARATOR,
  AI_TOOL_STEP_LABELS,
  type AiStreamEventV2,
} from './ai';
import { AI_TURN_TRANSITIONS } from '../state/ai-turn-transitions';

describe('AI contracts C0', () => {
  it('rate limits are the owner decision of 2026-10-25 (10/user/min, 60/org/min, 100/user/day)', () => {
    expect(AI_RATE_LIMIT_DEFAULTS).toEqual({ userPerMinute: 10, orgPerMinute: 60, userPerDay: 100 });
  });

  it('built-in skills drop holiday-planning (XD-4) and are sorted', () => {
    expect(AI_BUILTIN_SKILL_NAMES).not.toContain('holiday-planning');
    expect([...AI_BUILTIN_SKILL_NAMES]).toEqual([...AI_BUILTIN_SKILL_NAMES].sort());
  });

  it('the SDK tool set (meta + pause) fits the X-4 cap and never contains a read or write tool name', () => {
    const sdk = [...AI_META_TOOL_NAMES, ...AI_PAUSE_TOOL_NAMES];
    expect(sdk.length).toBeLessThanOrEqual(AI_MAX_SDK_TOOLS);
    for (const name of [...AI_READ_TOOL_NAMES, ...AI_WRITE_TOOL_NAMES]) expect(sdk).not.toContain(name);
    expect(AI_READ_TOOL_NAMES).not.toContain('get_holiday_overlap');
  });

  it('every route is unique and agents live under /ai/agents (XD-3)', () => {
    const keys = AI_API_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of AI_API_ROUTES.filter((x) => x.permission === 'ai.agents.manage')) expect(r.path.startsWith('/ai/agents')).toBe(true);
    expect(AI_API_ROUTES.some((r) => r.path.startsWith('/ai/settings/agents'))).toBe(false);
    expect(AI_API_ROUTES.some((r) => /\/run(s)?$/.test(r.path))).toBe(false);
  });

  it('waiting_for_input is a target status only: the Phase 1 turn table is unchanged until 5b', () => {
    expect(AiTurnStatusV2.WAITING_FOR_INPUT).toBe('waiting_for_input');
    expect(Object.keys(AI_TURN_TRANSITIONS)).not.toContain('waiting_for_input');
    expect(Object.values(AI_TURN_TRANSITIONS).flat()).not.toContain('waiting_for_input');
  });

  // C1 (TWENTY_UI_CONTRACT_DELTAS CD-1 … CD-13)
  it('five levels in order; the default is extra_fast (= Phase 1); per-message choice defaults to extra_fast + fast', () => {
    expect(AI_MODEL_LEVEL_KEYS).toEqual(['extra_fast', 'fast', 'balanced', 'smart', 'extra_smart']);
    expect(AI_DEFAULT_CHAT_LEVEL).toBe('extra_fast');
    expect(AI_DEFAULT_ALLOWED_LEVELS).toEqual(['extra_fast', 'fast']);
  });

  it('residency is global or eu only (no us, rule 3.7)', () => {
    expect(AI_DATA_RESIDENCIES).toEqual(['global', 'eu']);
  });

  it('update_plan is the 7th SDK tool at most; the plan tool has a step label', () => {
    expect(AI_META_TOOL_NAMES).toContain('update_plan');
    expect(AI_MAX_SDK_TOOLS).toBe(7);
    expect(AI_META_TOOL_NAMES.length + AI_PAUSE_TOOL_NAMES.length).toBe(7);
    for (const name of AI_READ_TOOL_NAMES) expect(AI_TOOL_STEP_LABELS[name]).toBeDefined();
  });

  it('the reasoning event carries a duration only — never text', () => {
    const ok: AiStreamEventV2 = { type: 'reasoning', turnId: 't', phase: 'finished', durationMs: 2000 };
    expect(Object.keys(ok)).not.toContain('text');
    // @ts-expect-error a reasoning event has no text field
    const bad: AiStreamEventV2 = { type: 'reasoning', turnId: 't', phase: 'started', text: 'x' };
    expect(bad).toBeDefined();
  });

  it('C1 routes exist; the models path takes a level', () => {
    const keys = AI_API_ROUTES.map((r) => `${r.method} ${r.path}`);
    for (const k of [
      'PUT /ai/settings/models/:level',
      'DELETE /ai/settings/models/:level',
      'PUT /ai/settings/model-policy',
      'GET /ai/settings/assistant',
      'PUT /ai/settings/assistant',
      'DELETE /ai/settings/assistant',
      'GET /ai/settings/instructions',
      'PUT /ai/settings/instructions',
      'DELETE /ai/settings/instructions',
      'GET /ai/capabilities',
    ])
      expect(keys).toContain(k);
    expect(keys.some((k) => k.includes(':tier'))).toBe(false);
  });

  it('avatar enums are 10 shapes, 10 colours, 6 faces; every preset uses them; instructions cap 2,000', () => {
    expect(AI_ASSISTANT_SHAPES).toEqual(['circle']); // owner decision 2026-10-26: round only
    expect(AI_ASSISTANT_COLOURS).toHaveLength(10);
    expect(AI_ASSISTANT_FACES).toHaveLength(6);
    for (const p of Object.values(AI_ASSISTANT_PRESETS)) {
      expect(AI_ASSISTANT_SHAPES).toContain(p.shape);
      expect(AI_ASSISTANT_COLOURS).toContain(p.colour);
      expect(AI_ASSISTANT_FACES).toContain(p.face);
      expect(p.name.length).toBeLessThanOrEqual(24);
    }
    expect(AI_INSTRUCTIONS_LIMITS.maxChars).toBe(2000);
  });

  it('prompt sections are fixed and joined by a blank line', () => {
    expect(AI_PROMPT_SECTION_KEYS).toEqual(['rules', 'format', 'instructions', 'skills', 'tools', 'context']);
    expect(AI_PROMPT_SECTION_SEPARATOR).toBe('\n\n');
  });
});
