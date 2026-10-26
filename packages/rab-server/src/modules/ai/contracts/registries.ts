/**
 * AI contracts C1 — REGISTRIES (TWENTY_UI_CONTRACT_DELTAS CD-13; AI_CONTRACTS.md §2 item 7). Names only.
 *
 * Every audit action, step-up action and env name a phase will add, so branches and reviewers agree on spelling. Adding
 * one to the engine registries (`AuditAction`, `STEP_UP_ACTIONS`, `environment-variables.ts` + launcher) is Agent 9's,
 * at the owning merge (or through an `integration-request(<file>)` commit, re-applied at merge). A name here is NOT yet
 * a valid `AuditActionType` / `StepUpAction`. Metadata of every audit row: ids, enums, counts, lengths, hashes — never
 * content.
 */
export const AI_PLANNED_AUDIT_ACTIONS = {
  // Phase 2
  TITLE_GENERATED: 'ai.title_generated',
  // Phase 4
  SKILL_CREATED: 'ai.skill_created',
  SKILL_UPDATED: 'ai.skill_updated',
  SKILL_DELETED: 'ai.skill_deleted',
  SKILL_ACTIVATED: 'ai.skill_activated',
  SKILL_DEACTIVATED: 'ai.skill_deactivated',
  // Phase 5
  PROPOSAL_CREATED: 'ai.proposal_created',
  PROPOSAL_APPROVED: 'ai.proposal_approved',
  PROPOSAL_REJECTED: 'ai.proposal_rejected',
  PROPOSAL_EXECUTED: 'ai.proposal_executed',
  PROPOSAL_FAILED: 'ai.proposal_failed',
  PROPOSAL_EXPIRED: 'ai.proposal_expired',
  INPUT_REQUESTED: 'ai.input_requested',
  INPUT_ANSWERED: 'ai.input_answered',
  MANAGER_NOTE_ADDED: 'manager.note_added',
  /** p5 merge (Agent 5 Q7): the `updateDraftShift` named action (console or an approved proposal); changed field NAMES only. */
  SHIFT_DRAFT_UPDATED: 'shift.draft_updated',
  // Phase 6 (storage only before EX-3)
  AGENT_CREATED: 'ai.agent_created',
  AGENT_UPDATED: 'ai.agent_updated',
  AGENT_DELETED: 'ai.agent_deleted',
  AGENT_TRIGGER_ENABLED: 'ai.agent_trigger_enabled',
  AGENT_TRIGGER_DISABLED: 'ai.agent_trigger_disabled',
  AGENT_TRIGGER_PAUSED: 'ai.agent_trigger_paused',
  AGENT_RUN_STARTED: 'ai.agent_run_started',
  AGENT_RUN_COMPLETED: 'ai.agent_run_completed',
  AGENT_RUN_FAILED: 'ai.agent_run_failed',
  AGENT_RUN_REFUSED: 'ai.agent_run_refused',
  AGENT_RUN_SKIPPED: 'ai.agent_run_skipped',
  // Phase 7
  BUDGET_THRESHOLD: 'ai.budget_threshold',
  USAGE_VIEWED: 'ai.usage_viewed',
  // Phase 8
  PROMPT_PREVIEWED: 'ai.prompt_previewed',
  // C1 (CD-1 / CD-2 / CD-3 / CD-4)
  MODEL_POLICY_CHANGED: 'ai.model_policy_changed',
  ASSISTANT_PROFILE_CHANGED: 'ai.assistant_profile_changed',
  INSTRUCTIONS_UPDATED: 'ai.instructions_updated',
} as const;
export type AiPlannedAuditAction = (typeof AI_PLANNED_AUDIT_ACTIONS)[keyof typeof AI_PLANNED_AUDIT_ACTIONS];

export const AI_PLANNED_STEP_UP_ACTIONS = {
  SKILL_UPDATE: 'organisation.ai.skill.update',
  PROPOSAL_APPROVE_HIGH_IMPACT: 'ai.proposal.approve_high_impact',
  INSTRUCTIONS_UPDATE: 'organisation.ai.instructions.update',
  /** CD-1 model policy reuses the Phase 1 model-setting step-up (already in STEP_UP_ACTIONS). */
  MODEL_POLICY_UPDATE: 'organisation.ai.model.update',
} as const;

export const AI_PLANNED_ENV_NAMES = {
  phase2: ['AI_TITLE_GENERATION'],
  phase6: ['AI_AGENTS_ENABLED', 'AI_AGENT_RUNS_PER_HOUR', 'AI_AGENT_EVENTS_PER_RUN', 'AI_AGENT_ORG_MAX_ACTIVE_RUNS', 'AI_AGENT_BUDGET_SHARE_PERCENT', 'AI_AGENT_CONSENT_DAYS', 'AI_AGENT_MAX_LATENESS_MINUTES'],
  phase7: ['AI_USER_DAILY_BUDGET_USD', 'AI_ORG_RATE_PER_MIN', 'AI_USER_TURNS_PER_DAY'],
} as const;
