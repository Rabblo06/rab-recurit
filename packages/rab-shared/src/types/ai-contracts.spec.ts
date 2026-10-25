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
});
