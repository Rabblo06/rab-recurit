/**
 * AI contracts C0 — AGENT EXECUTION, STORAGE ONLY (docs/ai/AI_CONTRACTS.md §2.6). Types and fixed values only.
 *
 * Owner decision 2026-10-25: EX-3 (the delegated run-as principal for triggered agents, against rules 2.1 / 1.5 / 2.3 /
 * 6.3) is DEFERRED. Until the owner approves it: agents and triggers may be stored (Phase 6a), a trigger can never be
 * enabled, nothing is scheduled, no record event is recorded, no agent run is queued and no model is called for an agent
 * (no manual "Run now" either — that is runner agent mode, Phase 6b). `AI_AGENTS_ENABLED=false` by default and pinned
 * `'false'` in production. Execution types below exist so 6a storage compiles against the final shape; nothing may
 * produce them before EX-3.
 *
 * This file replaces the `types/ai-agent.ts` the Phase 6 plan proposed (one contract file, owned by Agent 9).
 */
import type { AiAgentModelSelection } from './ai-models';

/** The permission flag Phase 6 adds (M6.1, CEO only by default — P6-D12). Added to `PermissionFlag` by Agent 9 at the 6a merge, not before (the permission-catalogue spec compares the DB). */
export const AI_AGENTS_MANAGE_FLAG = 'ai.agents.manage' as const;

/** API path prefix (resolution X-6 / XD-3): `/rest/v1/ai/agents`. Settings → AI → Agents (Agent 8) consumes it. */
export const AI_AGENTS_API_PREFIX = '/ai/agents' as const;

/** Record-event catalogue v1 (P6-D3). */
export const AI_AGENT_EVENT_TYPES = ['attendance.under_review', 'shift.cancelled', 'shift.created', 'shift.published', 'shift.staffing_changed'] as const;
export type AiAgentEventType = (typeof AI_AGENT_EVENT_TYPES)[number];

/** Restricted schedule DSL (P6-D5): org timezone, minimum one hour, no raw cron. `dow` 0 = Sunday … 6 = Saturday, only with `every: 'week'`. */
export interface AiAgentSchedule {
  every: 'hour' | 'day' | 'weekday' | 'week';
  /** `HH:MM`, 24 h. For `hour`, only the minutes are used. */
  at: string;
  dow?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export type AiAgentTriggerKind = 'schedule' | 'record_event';
export type AiAgentResponseFormat = 'text';

/** Why a trigger was paused (`ai_agent_trigger.paused_reason`). */
export const AiAgentPauseReason = {
  OWNER_SECURITY_CHANGED: 'owner_security_changed',
  CONFIG_CHANGED: 'config_changed',
  CONSENT_EXPIRED: 'consent_expired',
  OWNER_INELIGIBLE: 'owner_ineligible',
  MEMBERSHIP_REVOKED: 'membership_revoked',
  PERMISSION_REVOKED: 'permission_revoked',
  SIGNED_OUT_EVERYWHERE: 'signed_out_everywhere',
} as const;
export type AiAgentPauseReasonType = (typeof AiAgentPauseReason)[keyof typeof AiAgentPauseReason];

/** P6-D13 / P6-D9 / P6 §4. Server env maximums and the migration CHECKs must equal these. */
export const AI_AGENT_LIMITS = {
  promptMaxChars: 8_000,
  labelMaxChars: 80,
  descriptionMaxChars: 500,
  agentsPerWorkspace: 20,
  triggersPerAgent: 5,
  runsPerAgentPerHour: 100,
  eventsPerRun: 20,
  eventBacklogPerTrigger: 200,
  orgMaxActiveRuns: 1,
  budgetSharePercent: 50,
  consentDays: 90,
  maxLatenessMinutes: 10,
  minScheduleIntervalMinutes: 60,
} as const;

/** Agent HTTP error codes. Folded into `AiErrorCode` by Agent 9 at the 6a merge. */
export const AiAgentErrorCode = {
  AGENTS_DISABLED: 'AI_AGENTS_DISABLED',
  /** EX-3 not approved: enabling a trigger, or any run, is refused. */
  AGENT_EXECUTION_NOT_APPROVED: 'AI_AGENT_EXECUTION_NOT_APPROVED',
} as const;
export type AiAgentErrorCodeType = (typeof AiAgentErrorCode)[keyof typeof AiAgentErrorCode];

/** Marks an approved-and-executed proposal that came from an agent run, so its record events never re-trigger agents (P6-D6). */
export interface AiAgentOrigin {
  agentId: string;
  turnId: string;
}

export interface AiAgentView {
  id: string;
  name: string;
  label: string;
  description: string | null;
  prompt: string;
  model: AiAgentModelSelection;
  responseFormat: AiAgentResponseFormat;
  roleId: string | null;
  isActive: boolean;
  configVersion: number;
  triggers: AiAgentTriggerView[];
  createdAt: string;
  updatedAt: string;
}

export interface AiAgentTriggerView {
  id: string;
  agentId: string;
  kind: AiAgentTriggerKind;
  schedule: AiAgentSchedule | null;
  eventTypes: AiAgentEventType[];
  /** Always false until EX-3 is approved. */
  enabled: boolean;
  /** Who the trigger runs as (the user who last enabled it); null while never enabled. */
  runAsUserId: string | null;
  pausedReason: AiAgentPauseReasonType | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

/** `POST /rest/v1/ai/agents`. Never accepts `runAsUserId`, `enabled`, `status`, `organisationId` or `configVersion` (400). */
export interface AiAgentCreateRequest {
  name: string;
  label: string;
  description?: string;
  prompt: string;
  model: AiAgentModelSelection;
  responseFormat?: AiAgentResponseFormat;
  roleId?: string | null;
}

export type AiAgentUpdateRequest = Partial<Omit<AiAgentCreateRequest, 'name'>>;

/** `POST /rest/v1/ai/agents/:id/triggers` (stored disabled; `enable` is refused until EX-3). */
export interface AiAgentTriggerCreateRequest {
  kind: AiAgentTriggerKind;
  schedule?: AiAgentSchedule;
  eventTypes?: AiAgentEventType[];
}

/** One run as the Runs tab shows it (the caller's own runs only; metadata, no content beyond what the caller owns). Produced only after EX-3 (6b). */
export interface AiAgentRunView {
  turnId: string;
  agentId: string;
  triggerId: string | null;
  origin: 'agent_manual' | 'agent_schedule' | 'agent_event';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  errorCode: string | null;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  proposalsCreated: number;
}
