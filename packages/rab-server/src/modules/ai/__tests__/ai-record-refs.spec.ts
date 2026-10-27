import { AI_RECORD_REF_PATTERN } from '@rab/shared';

import { AiRecordRefAllowlist, filterRecordRefs } from '../prompt/record-refs';
import { buildSystemPrompt } from '../prompt/system-prompt';
import { storedTurnContent } from '../services/ai-turn-runner.service';

/**
 * Batch 3 S2 — the record-reference filter (pure). Only a strict `[[record:<type>:<uuid>]]` whose (type, uuid) a tool
 * result of the same turn named survives; everything else `[[record:…]]`-shaped is removed, and offsets move with it.
 */
const SHIFT = 'abcdef11-1111-4111-8111-11111111aaaa';
const VENUE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

describe('S2 AI_RECORD_REF_PATTERN (contract)', () => {
  it('matches only the three types and a lower-case uuid; it is not global', () => {
    expect(AI_RECORD_REF_PATTERN.global).toBe(false);
    expect(AI_RECORD_REF_PATTERN.exec(`[[record:shift:${SHIFT}]]`)?.slice(1)).toEqual(['shift', SHIFT]);
    expect(AI_RECORD_REF_PATTERN.test(`[[record:staff_profile:${SHIFT}]]`)).toBe(true);
    expect(AI_RECORD_REF_PATTERN.test(`[[record:payroll:${SHIFT}]]`)).toBe(false);
    expect(AI_RECORD_REF_PATTERN.test(`[[record:shift:${SHIFT.toUpperCase()}]]`)).toBe(false);
    expect(AI_RECORD_REF_PATTERN.test('[[record:shift:not-a-uuid]]')).toBe(false);
  });
});

describe('S2 AiRecordRefAllowlist.collect', () => {
  it('records ids only under the typed keys, at any depth; other keys, bad uuids and non-strings add nothing', () => {
    const allow = new AiRecordRefAllowlist();
    allow.collect({
      notice: 'Untrusted record data.',
      data: { shifts: [{ shiftId: SHIFT, venue: 'Pier Hall', note: `[[record:venue:${OTHER}]]` }], venues: [{ venueId: VENUE }], id: OTHER, other: { shiftId: 'NOT-A-UUID' } },
    });
    expect(allow.has('shift', SHIFT)).toBe(true);
    expect(allow.has('venue', VENUE)).toBe(true);
    expect(allow.has('venue', SHIFT)).toBe(false); // the type matters
    expect(allow.has('shift', OTHER)).toBe(false); // `id` is not a typed key
    expect(allow.has('venue', OTHER)).toBe(false); // text inside a value is never an id source
    expect(allow.size).toBe(2);
  });

  it('never throws on odd input (cycles are bounded by depth, primitives ignored)', () => {
    const allow = new AiRecordRefAllowlist();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => allow.collect(loop)).not.toThrow();
    expect(() => allow.collect('text')).not.toThrow();
    expect(() => allow.collect(null)).not.toThrow();
    expect(allow.size).toBe(0);
  });
});

describe('S2 filterRecordRefs', () => {
  const allow = new AiRecordRefAllowlist();
  allow.add('shift', SHIFT);
  allow.add('venue', VENUE);

  it('keeps an allow-listed reference verbatim', () => {
    const text = `Open: [[record:shift:${SHIFT}]] at [[record:venue:${VENUE}]].`;
    expect(filterRecordRefs(text, allow).text).toBe(text);
  });

  it('removes invented, foreign, mistyped, malformed and upper-case references (no trace, no existence leak)', () => {
    const text = [
      `a[[record:shift:${OTHER}]]`,
      `b[[record:venue:${SHIFT}]]`,
      'c[[record:shift:not-a-uuid]]',
      `d[[record:payroll:${SHIFT}]]`,
      `e[[record:shift:${SHIFT.toUpperCase()}]]`,
      'f[[record:shift:Pier Hall label]]',
      `g[[record:shift:${SHIFT}]]`,
    ].join(' ');
    expect(filterRecordRefs(text, allow).text).toBe(`a b c d e f g[[record:shift:${SHIFT}]]`);
  });

  it('an empty allow-list removes every reference; text without references is unchanged', () => {
    expect(filterRecordRefs(`x [[record:shift:${SHIFT}]] y`, new AiRecordRefAllowlist()).text).toBe('x  y');
    expect(filterRecordRefs('plain [[not a record]] text', allow).text).toBe('plain [[not a record]] text');
  });

  it('offsets move with the removed text (before, inside and after a removed token)', () => {
    const bad = `[[record:shift:${OTHER}]]`;
    const content = `ab${bad}cd`;
    const f = filterRecordRefs(content, allow);
    expect(f.text).toBe('abcd');
    expect(f.offsetOf(1)).toBe(1);
    expect(f.offsetOf(2)).toBe(2);
    expect(f.offsetOf(2 + 5)).toBe(2); // inside the removed token: its start
    expect(f.offsetOf(2 + bad.length)).toBe(2);
    expect(f.offsetOf(content.length)).toBe(4);
  });
});

describe('S2 storedTurnContent (what checkpoint and finalise write)', () => {
  it('filters the content and moves tool offsets; an offset that lands on 0 is omitted', () => {
    const bad = `[[record:shift:${OTHER}]]`;
    const allow = new AiRecordRefAllowlist();
    const out = storedTurnContent(`${bad}Hi. [[record:shift:${OTHER}]]Done.`, [{ name: 'find_shifts', outcome: 'ok', rows: 1, offset: bad.length }, { name: 'count_shifts', outcome: 'ok', rows: 1, offset: bad.length + 4 + bad.length }, { name: 'x', outcome: 'ok', rows: null }], allow);
    expect(out.content).toBe('Hi. Done.');
    expect(out.toolCalls).toEqual([
      { name: 'find_shifts', outcome: 'ok', rows: 1 },
      { name: 'count_shifts', outcome: 'ok', rows: 1, offset: 4 },
      { name: 'x', outcome: 'ok', rows: null },
    ]);
  });
});

describe('S2 the prompt rule', () => {
  it('the format section tells the model the reference format and that ids must come from this answer’s tools', () => {
    const prompt = buildSystemPrompt('2026-10-26');
    expect(prompt).toContain('[[record:shift:<shiftId>]]');
    expect(prompt).toContain('[[record:venue:<venueId>]]');
    expect(prompt).toContain('[[record:staff_profile:<staffProfileId>]]');
    expect(prompt).toContain('Never write an id you did not get from a tool in this answer');
  });
});
