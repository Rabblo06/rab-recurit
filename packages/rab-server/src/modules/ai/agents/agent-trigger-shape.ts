import { AI_AGENT_EVENT_TYPES, AiAgentEventType, AiAgentSchedule, AiAgentTriggerKind } from '@rab/shared';

/**
 * The trigger shapes a 6a trigger may STORE (docs/ai/PHASE6_TWENTY_PLAN.md §5, P6-D3 / P6-D5). Pure and total: every input
 * either yields a normalised value or `null` (the service answers 400 AI_AGENT_INVALID with a fixed field name). Mirrors
 * the `ai_agent_trigger_shape_check` CHECK (layer 4) so a client gets a clean 400, never a database error.
 *
 *   schedule      {every: 'hour'|'day'|'weekday'|'week', at: 'HH:MM' (24 h), dow: 0..6 — required with 'week', absent
 *                 otherwise}; no other key; no raw cron (minimum interval one hour, org timezone). `hour` uses only the
 *                 minutes of `at`.
 *   record_event  1..4 DISTINCT types of the v1 catalogue (AI_AGENT_EVENT_TYPES), returned sorted.
 *
 * Nothing here computes a fire time: next-run computation (DST-safe, org timezone) is Phase 6b, after EX-3.
 */
const EVERY = new Set(['hour', 'day', 'weekday', 'week']);
const AT = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const EVENT_TYPES: ReadonlySet<string> = new Set(AI_AGENT_EVENT_TYPES);
export const AI_AGENT_MAX_EVENT_TYPES = 4;

export function normaliseSchedule(input: unknown): AiAgentSchedule | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some((k) => k !== 'every' && k !== 'at' && k !== 'dow')) return null;
  const { every, at, dow } = value;
  if (typeof every !== 'string' || !EVERY.has(every)) return null;
  if (typeof at !== 'string' || !AT.test(at)) return null;
  const isWeek = every === 'week';
  if (isWeek !== ('dow' in value)) return null;
  if (isWeek) {
    if (typeof dow !== 'number' || !Number.isInteger(dow) || dow < 0 || dow > 6) return null;
    return { every: 'week', at, dow: dow as AiAgentSchedule['dow'] };
  }
  return { every: every as AiAgentSchedule['every'], at };
}

export function normaliseEventTypes(input: unknown): AiAgentEventType[] | null {
  if (!Array.isArray(input) || input.length < 1 || input.length > AI_AGENT_MAX_EVENT_TYPES) return null;
  if (!input.every((t) => typeof t === 'string' && EVENT_TYPES.has(t))) return null;
  if (new Set(input).size !== input.length) return null;
  return [...(input as AiAgentEventType[])].sort();
}

export type AiAgentTriggerShape = { kind: 'schedule'; schedule: AiAgentSchedule; eventTypes: null } | { kind: 'record_event'; schedule: null; eventTypes: AiAgentEventType[] };

/** A whole trigger body (create): the kind decides which of the two fields is required and which must be absent. */
export function normaliseTrigger(kind: unknown, schedule: unknown, eventTypes: unknown): AiAgentTriggerShape | null {
  if (kind === 'schedule') {
    if (eventTypes !== undefined) return null;
    const s = normaliseSchedule(schedule);
    return s ? { kind, schedule: s, eventTypes: null } : null;
  }
  if (kind === 'record_event') {
    if (schedule !== undefined) return null;
    const e = normaliseEventTypes(eventTypes);
    return e ? { kind, schedule: null, eventTypes: e } : null;
  }
  return null;
}

/** An update keeps the stored kind: a schedule trigger takes only `schedule`, an event trigger only `eventTypes`. */
export function normaliseTriggerUpdate(kind: AiAgentTriggerKind, schedule: unknown, eventTypes: unknown): AiAgentTriggerShape | null {
  if (schedule === undefined && eventTypes === undefined) return null;
  return normaliseTrigger(kind, schedule, eventTypes);
}
