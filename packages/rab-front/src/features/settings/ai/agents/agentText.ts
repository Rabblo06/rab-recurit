import type { AiAgentEventType, AiAgentSchedule, AiAgentTriggerView, AiModelTier } from '@rab/shared';

/**
 * EX-3 is not approved (owner decision 2026-10-25; still deferred 2026-10-26): agents are STORED only. Nothing can run,
 * be tested or be switched on. Shown next to every control that would start, test or enable something.
 */
export const AGENT_EXECUTION_REASON = 'Agents can’t run until the owner approves agent execution (EX-3). You can set them up now; nothing will run.';
/** The short form for tooltips and table cells. */
export const AGENT_EXECUTION_SHORT = 'Not running: agent execution is waiting for the owner’s approval (EX-3).';

/** The server's two agent model tiers (contract `AiAgentModelSelection.tier`) with the level glyph's bar count. */
export const AGENT_TIER: Record<AiModelTier, { label: string; bars: number }> = {
  fast: { label: 'Fast', bars: 2 },
  smart: { label: 'Smart', bars: 4 },
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Fixed wording for the P6-D3 record events (a closed list from the contract). */
export const AGENT_EVENT_TEXT: Record<AiAgentEventType, string> = {
  'attendance.under_review': 'an attendance record goes under review',
  'shift.cancelled': 'a shift is cancelled',
  'shift.created': 'a shift is created',
  'shift.published': 'a shift is published',
  'shift.staffing_changed': 'a shift’s staffing changes',
};

/** "Every Thursday at 09:00" — from the restricted schedule DSL (organisation time zone; never a raw cron). */
export function scheduleText(s: AiAgentSchedule): string {
  if (s.every === 'hour') return `Every hour at :${s.at.slice(3, 5)}`;
  if (s.every === 'day') return `Every day at ${s.at}`;
  if (s.every === 'weekday') return `Every weekday at ${s.at}`;
  return `Every ${DAYS[s.dow ?? 1]} at ${s.at}`;
}

export function triggerText(t: Pick<AiAgentTriggerView, 'kind' | 'schedule' | 'eventTypes'>): string {
  if (t.kind === 'schedule' && t.schedule) return scheduleText(t.schedule);
  if (!t.eventTypes.length) return 'When a record changes';
  return `When ${t.eventTypes.map((e) => AGENT_EVENT_TEXT[e] ?? e).join(' or ')}`;
}

/** The list's "Runs" cell: the first trigger, and how many more. No trigger = it would never start on its own. */
export function runsSummary(triggers: AiAgentTriggerView[]): string {
  if (!triggers.length) return 'No trigger';
  const first = triggerText(triggers[0]!);
  return triggers.length > 1 ? `${first} +${triggers.length - 1} more` : first;
}

export { DAYS };
