/**
 * AI contracts C0 — AGENT EXECUTION, server side (docs/ai/AI_CONTRACTS.md §2.6). Types and one fixed flag only.
 *
 * OWNER DECISION 2026-10-25: EX-3 is deferred, so agents are STORAGE ONLY with execution OFF. Phase 6a (Batch 2) may
 * build definitions, triggers (stored disabled), roles and the principal service WITH UNIT TESTS ONLY; nothing may
 * enable a trigger, schedule a fire, record an event, enqueue `ai-agent-run`, or call a model for an agent until the
 * owner approves EX-3 and Agent 9 flips `AI_AGENT_EXECUTION_APPROVED` in a reviewed commit. The principal NEVER uses
 * `actorType: 'worker'`, `runScopedForOrg`, `directDataSource` or an owner connection (rule 2.1; static test T6-P3).
 */
import type { AiAgentOrigin, AiAgentPauseReasonType, PermissionFlagType } from '@rab/shared';

import type { AiCatalogueModel } from '../../../engine/core-modules/ai/models/catalog';
import type { AiAgentRunJobData } from '../../../engine/worker-shared/ai-jobs.contract';

/** EX-3 gate. `false` until the owner approves EX-3; every agent execution path must check it first and refuse. */
export const AI_AGENT_EXECUTION_APPROVED = false as const;

/** The delegated run-as principal (P6 §2). Built ONLY by `AiAgentPrincipalService.rebuildForAgentRun`. */
export interface AiAgentPrincipal {
  kind: 'agent';
  organisationId: string;
  workspaceId: string;
  /** The user who last enabled the trigger (server-written from ctx.userId), or the caller of a manual run. */
  runAsUserId: string;
  agentId: string;
  triggerId: string | null;
  turnId: string;
  timezone: string;
  /** agent-role flags (now) ∩ the user's flags (now) ∩ the consent snapshot. Can shrink, never grow without new consent. */
  effectivePermissions: ReadonlySet<PermissionFlagType>;
  /** Snapshot taken at enable; any difference pauses the trigger. */
  snapshot: { userSecurityVersion: number; agentConfigVersion: number; rolePermissionVersion: number | null; consentFlags: readonly PermissionFlagType[]; consentAt: string };
  model: AiCatalogueModel;
  realProviderPermitted: boolean;
}

export type AiAgentRunRefusal =
  | { refused: true; reason: 'execution_not_approved' | 'agents_disabled' | 'ai_disabled' | 'org_disabled' | 'no_model' | 'real_provider_not_permitted' | 'run_cap' | 'no_slot' | 'budget' }
  | { refused: true; reason: 'paused'; pauseReason: AiAgentPauseReasonType };

/** The session-less twin of AiAccessService (P6 §2). Both methods run fresh short transactions as the run-as user. */
export interface AiAgentPrincipalServiceContract {
  rebuildForAgentRun(job: AiAgentRunJobData): Promise<AiAgentPrincipal | AiAgentRunRefusal>;
  /** Before every model step and every tool call: items 1–5 and 7 of P6 §2 again. Throws AiAccessRevokedError. */
  assertAgentStillAllowed(principal: AiAgentPrincipal, flag?: PermissionFlagType): Promise<void>;
}

/**
 * `AuthContext.aiOrigin` (P6 §4) — set ONLY by the Phase 5 executor for a proposal whose origin is an agent, never from a
 * JWT, body or job. The field is added to engine/core-modules/tenant/auth-context.interface.ts by Agent 9 at the 6a merge.
 */
export type AiAuthContextOrigin = AiAgentOrigin;
