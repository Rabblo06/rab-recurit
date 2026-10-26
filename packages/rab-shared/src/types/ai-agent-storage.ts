/**
 * AI Phase 6a — agent STORAGE request/response extras (Agent 6; docs/ai/PHASE6_TWENTY_PLAN.md §4). Complements the C0
 * contract `ai-agents.ts` (owned by Agent 9) WITHOUT forking it: the contract's request types carry no `reason`, and it
 * has no trigger-update or role-update body yet. Everything here is a REQUEST.md item for Agent 9 to fold into
 * `ai-agents.ts` at the 6a merge (then this file re-exports or disappears).
 *
 * Execution stays OFF (owner decision 2026-10-25, EX-3 deferred): nothing here enables, schedules or runs anything.
 */
import { MEMBER_ROLE_ALLOWED_PERMISSIONS } from './member-invitation';
import { AI_AGENT_ROLE_ALLOWLIST, type AiAgentEventType, type AiAgentRoleFlag, type AiAgentSchedule, type AiAgentView } from './ai-agents';

/** The one step-up action of every agent write (agent, trigger, role flags), like `organisation.ai.skill.update`. */
export const AI_AGENT_STEP_UP_ACTION = 'organisation.ai.agent.update' as const;

/** `ai_agent.name`: a stable slug, unique per workspace among live agents (never changed after create). */
export const AI_AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,49}$/;

/** Every agent write carries a reason (audited; never the instruction text). */
export const AI_AGENT_REASON_LIMITS = { minChars: 3, maxChars: 500 } as const;

/**
 * Blocker B10 (narrowest version): the flags an agent role may carry IN PHASE 6a = the C1 agent allowlist ∩ the
 * UNCHANGED database backstop `core.enforce_member_role_permission_allowlist()` (the three member view flags). The rest
 * of `AI_AGENT_ROLE_ALLOWLIST` (`attendance.view`, `payroll.view`, `schedule.create`, `staff.edit`) needs Agent 9's
 * dedicated security review of a backstop change before any agent role can hold it.
 */
export const AI_AGENT_ROLE_FLAGS_6A: readonly AiAgentRoleFlag[] = AI_AGENT_ROLE_ALLOWLIST.filter((flag) => (MEMBER_ROLE_ALLOWED_PERMISSIONS as readonly string[]).includes(flag));

/** Batch 3 (R-U4): `kind` and `readOnly` are folded into `AiAgentView` (ai-agents.ts, with `AiAgentKind`); alias for 6a callers. */
export type AiAgentStorageView = AiAgentView;

/** Every write body carries this (400 without it). */
export interface AiAgentWriteReason {
  reason: string;
}

/** `PATCH /rest/v1/ai/agents/:id/triggers/:triggerId` — the kind never changes; enabling is a named route (refused before EX-3). */
export interface AiAgentTriggerUpdateRequest {
  schedule?: AiAgentSchedule;
  eventTypes?: AiAgentEventType[];
}

/** `PUT /rest/v1/ai/agents/:id/role` — the agent role's flags (a dedicated agent role is created on first use). */
export interface AiAgentRoleUpdateRequest {
  flags: AiAgentRoleFlag[];
}

/** 6a error codes beyond `AiAgentErrorCode` (folded into `AiErrorCode` by Agent 9 at merge). */
export const AiAgentStorageErrorCode = {
  NAME_TAKEN: 'AI_AGENT_NAME_TAKEN',
  LIMIT_REACHED: 'AI_AGENT_LIMIT_REACHED',
  TRIGGER_LIMIT_REACHED: 'AI_AGENT_TRIGGER_LIMIT_REACHED',
  READ_ONLY: 'AI_AGENT_READ_ONLY',
  CONTENT_REFUSED: 'AI_AGENT_CONTENT_REFUSED',
  INVALID: 'AI_AGENT_INVALID',
  ROLE_FLAG_NOT_ALLOWED: 'AI_AGENT_ROLE_FLAG_NOT_ALLOWED',
} as const;
export type AiAgentStorageErrorCodeType = (typeof AiAgentStorageErrorCode)[keyof typeof AiAgentStorageErrorCode];
