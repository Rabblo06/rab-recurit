import { AI_AGENT_LIMITS, AI_AGENT_ROLE_ALLOWLIST, AiAgentPauseReasonType, PermissionFlagType, UserStatus } from '@rab/shared';

import type { AiAgentRunRefusal } from '../contracts/agents';

/**
 * The run-as principal DECISION (docs/ai/PHASE6_TWENTY_PLAN.md §2 items 1–7), as a pure function of facts read in ONE
 * transaction as the run-as user (never a system context — rule 2.1, C1). It is the only place that decides whether an
 * agent may run and with which tool flags. Item 8 (the model and EX-1) is the service's, after this.
 *
 * NOTHING CALLS THIS AT RUN TIME IN 6a: the owner deferred EX-3, so `AiAgentPrincipalService` refuses with
 * `execution_not_approved` before reading a single fact. The policy exists (with unit tests for every abuse case) so the
 * 6b review audits a finished, tested decision instead of writing it under time pressure.
 *
 * Order — the first failing item decides; `pause` marks the items the plan marks **P** (the trigger is switched off
 * and stays off until a re-enable by its owner):
 *   1. AI_ENABLED, AI_AGENTS_ENABLED, the organisation's AI switch and its agents switch        → refused, no pause;
 *   2. the organisation is not suspended and not in maintenance                                 → refused, no pause;
 *      the run-as user is `active` and not must-reset                                           → P owner_ineligible;
 *      an ACTIVE membership of the agent's workspace                                             → P membership_revoked;
 *   3. CEO or CURRENT Initial Manager (`core.ai_actor_eligible()`)                              → P owner_ineligible;
 *      `ai.use` and `ai.agents.manage`                                                           → P permission_revoked;
 *   (trigger runs) the trigger exists, is enabled and runs as THIS user                         → refused (already off);
 *   4. the user's `security_version` equals the snapshot taken at enable                        → P owner_security_changed;
 *   5. the agent is live; its `config_version` and its role's `permission_version` equal the
 *      snapshot (anyone's edit pauses — no confused deputy)                                      → P config_changed;
 *   6. consent younger than AI_AGENT_LIMITS.consentDays                                          → P consent_expired;
 *   7. effective flags = agent role (now) ∩ the user's flags (now) ∩ the consent snapshot, restricted to the C1 agent
 *      allowlist — it can shrink, never grow without a new consent. No role ⇒ no tools (the run itself may proceed).
 * A manual run (`trigger === null`, the signed-in caller, 6b) skips the trigger items and uses the role's flags as consent.
 */
export interface AiAgentRunFacts {
  switches: { aiEnabled: boolean; agentsEnabled: boolean; orgAiEnabled: boolean; orgAgentsEnabled: boolean };
  organisation: { suspended: boolean; maintenance: boolean };
  runAsUserId: string;
  user: { status: string | null; mustResetPassword: boolean; securityVersion: number | null };
  membershipActive: boolean;
  eligible: boolean;
  holdsAiUse: boolean;
  holdsAgentsManage: boolean;
  /** The user's flags NOW, among the agent allowlist only. */
  userFlags: ReadonlySet<PermissionFlagType>;
  agent: { live: boolean; configVersion: number; roleId: string | null; rolePermissionVersion: number | null; roleFlags: readonly PermissionFlagType[] } | null;
  trigger: {
    enabled: boolean;
    runAsUserId: string | null;
    enabledAt: Date | null;
    consentFlags: readonly string[] | null;
    snapUserSecurityVersion: number | null;
    snapAgentConfigVersion: number | null;
    snapRolePermissionVersion: number | null;
  } | null;
}

export type AiAgentRunDecision = { ok: true; effectivePermissions: ReadonlySet<PermissionFlagType> } | { ok: false; refusal: AiAgentRunRefusal; pause: boolean };

const AGENT_ALLOWLIST: ReadonlySet<string> = new Set(AI_AGENT_ROLE_ALLOWLIST);
const DAY_MS = 86_400_000;

const refused = (reason: Exclude<AiAgentRunRefusal, { reason: 'paused' }>['reason']): AiAgentRunDecision => ({ ok: false, refusal: { refused: true, reason }, pause: false });
const paused = (pauseReason: AiAgentPauseReasonType, pause = true): AiAgentRunDecision => ({ ok: false, refusal: { refused: true, reason: 'paused', pauseReason }, pause });

export function decideAgentRun(facts: AiAgentRunFacts, now: Date, consentDays: number = AI_AGENT_LIMITS.consentDays): AiAgentRunDecision {
  // 1. Switches (fail closed: anything but an explicit true is off).
  if (facts.switches.aiEnabled !== true) return refused('ai_disabled');
  if (facts.switches.agentsEnabled !== true) return refused('agents_disabled');
  if (facts.switches.orgAiEnabled !== true || facts.switches.orgAgentsEnabled !== true) return refused('org_disabled');
  // 2. Organisation, account, membership.
  if (facts.organisation.suspended !== false || facts.organisation.maintenance !== false) return refused('org_disabled');
  if (facts.user.status !== UserStatus.ACTIVE || facts.user.mustResetPassword !== false) return paused('owner_ineligible');
  if (facts.membershipActive !== true) return paused('membership_revoked');
  // 3. Eligibility and the two AI flags.
  if (facts.eligible !== true) return paused('owner_ineligible');
  if (facts.holdsAiUse !== true || facts.holdsAgentsManage !== true) return paused('permission_revoked');
  const agent = facts.agent;
  const trigger = facts.trigger;
  if (trigger) {
    if (trigger.enabled !== true || trigger.runAsUserId !== facts.runAsUserId) return paused('owner_ineligible', false);
    // 4. The owner's security version (password change / reset, status change, MFA reset bump it).
    if (trigger.snapUserSecurityVersion === null || facts.user.securityVersion === null || Number(trigger.snapUserSecurityVersion) !== Number(facts.user.securityVersion)) {
      return paused('owner_security_changed');
    }
  }
  // 5. The agent and its role are exactly what was consented to.
  if (!agent || agent.live !== true) return paused('config_changed');
  if (trigger) {
    if (trigger.snapAgentConfigVersion === null || Number(trigger.snapAgentConfigVersion) !== Number(agent.configVersion)) return paused('config_changed');
    const roleVersion = agent.roleId ? agent.rolePermissionVersion : null;
    if ((trigger.snapRolePermissionVersion ?? null) !== (roleVersion === null ? null : Number(roleVersion))) return paused('config_changed');
    // 6. Consent lifetime.
    if (!trigger.enabledAt || !(now.getTime() - trigger.enabledAt.getTime() < consentDays * DAY_MS) || trigger.enabledAt.getTime() > now.getTime()) {
      return paused('consent_expired');
    }
  }
  // 7. Effective flags: role ∩ user ∩ consent, within the agent allowlist. No role ⇒ none.
  const consent = trigger ? new Set(trigger.consentFlags ?? []) : new Set<string>(agent.roleFlags);
  const effective = new Set<PermissionFlagType>();
  if (agent.roleId) {
    for (const flag of agent.roleFlags) {
      if (AGENT_ALLOWLIST.has(flag) && facts.userFlags.has(flag) && consent.has(flag)) effective.add(flag);
    }
  }
  return { ok: true, effectivePermissions: effective };
}
