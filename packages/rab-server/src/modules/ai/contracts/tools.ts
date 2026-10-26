/**
 * AI contracts C0 — TOOL DISCOVERY, server side (docs/ai/AI_CONTRACTS.md §2.3). Types only: no behaviour.
 *
 * Implemented by Agent 3 (Phase 3: `@DefineTool`, the registry's `forTurn` / `learn` / `executeByName`); wired into the
 * runner at 3w. Agent 4 adds `load_skills` as a `meta` tool and Agent 5 the `pause` / `write` kinds through the same
 * contract. Security invariants (unchanged from Phase 1, rules 2.4 / 7.1 / 3.1): ONE permission flag per domain tool,
 * filtered before the model sees anything and re-checked fresh before every run; the strict zod input is re-parsed on the
 * server (the ONLY inner check once tools load lazily); output allowlist + denylist + byte cap; own tenant transaction.
 */
import type { AiPlanStep, AiToolCallOutcome, AiToolCallSummaryV2, AiToolKind, AiToolParameterView, PermissionFlagType } from '@rab/shared';
import type { ToolSet } from 'ai';
import type { z } from 'zod';

import type { AiActor } from '../services/ai-access.service';

/** Phase 5: a write tool's approval template (refused on read tools at boot). */
export interface AiApprovalTemplate {
  summaryTemplate: string;
  /** The only argument keys an approver may edit. */
  fields: readonly string[];
  stepUp: 'never' | 'high_impact';
  maxTargets: number;
}

export interface AiToolOutputPolicy {
  /** Explicit allowlist of every key that may leave the tool (nested keys included). */
  keys: readonly string[];
  /** ≤ AI_TOOL_LIMITS.maxRows unless the plan documents an exception (count_shifts byDay: 62). */
  maxRows: number;
  /** Default AI_TOOL_LIMITS.defaultOutputBytes, hard maximum AI_TOOL_LIMITS.maxOutputBytes. */
  maxBytes?: number;
}

export interface AiToolInputLimits {
  /** Longest date range the input accepts, in organisation-local days. */
  maxDays?: number;
}

/**
 * `@DefineTool(options)` (class decorator, `modules/ai/tools/define-tool.decorator.ts`). Stored with
 * `Reflect.defineMetadata`; tools are collected only from ONE reviewed array (`AI_READ_TOOLS` in tools/index.ts, multi
 * token `AI_TOOL_CLASSES`) — never a DiscoveryService scan.
 */
export interface DefineToolOptions<TInput extends z.ZodType = z.ZodType> {
  /** Matches AI_TOOL_NAME_PATTERN. */
  name: string;
  /** ≤ AI_TOOL_LIMITS.maxDescriptionChars; fixed server text. */
  description: string;
  /** One catalogue line (`name: summary`) in the system prompt; fixed server text, no record data. */
  summary: string;
  kind: AiToolKind;
  /** Exactly one flag for `read` and `write`; null only for `meta` and `pause`. */
  permission: PermissionFlagType | null;
  /** `.strict()` zod object. Refuses organisationId, workspaceId, staffId, userId, status and sql keys. */
  input: TInput;
  output: AiToolOutputPolicy;
  limits?: AiToolInputLimits;
  approval?: AiApprovalTemplate;
}

/** What a decorated read-tool class implements. Runs an EXISTING domain service method in its own tenant transaction. */
export interface AiDefinedReadTool<TInput extends z.ZodType = z.ZodType> {
  run(actor: AiActor, input: z.infer<TInput>): Promise<Record<string, unknown>>;
}

/** The registry's internal definition, target shape (Phase 1 `AiToolDefinition` + the Phase 3 fields). */
export interface AiToolDefinitionV2<TInput extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  summary: string;
  kind: AiToolKind;
  permission: PermissionFlagType | null;
  input: TInput;
  outputKeys: readonly string[];
  maxRows: number;
  maxBytes: number;
  limits: AiToolInputLimits;
  approval?: AiApprovalTemplate;
  run(actor: AiActor, input: z.infer<TInput>): Promise<Record<string, unknown>>;
}

/**
 * Who a turn's tool checks run as. `session` = the signed-in user (AiAccessService.assertStillAllowed). `agent` = the
 * Phase 6 delegated principal (assertAgentStillAllowed) — NOT constructible before EX-3. The registry depends only on this
 * interface, never on how the principal was built, so the same filtering and re-checks apply to both.
 */
export interface AiPermissionChecker {
  readonly principal: 'session' | 'agent';
  /** Flags held right now (rebuilt from PostgreSQL; for an agent: role ∩ user ∩ consent). The discovery filter. */
  permissions(): ReadonlySet<PermissionFlagType>;
  /** Full fresh re-check (session, account, org, AI gates, and `flag` if given). Throws AiAccessRevokedError to abort the turn. */
  assertStillAllowed(flag?: PermissionFlagType): Promise<void>;
  /** One read-only statement (P3 §2.3): version vector + session revocation + org AI row + permission overrides. */
  fingerprint(): Promise<string>;
}

/** Live tool step events (P2 §7): the stream `tool` event and `calls[]` use the INNER name when permitted. */
export interface AiToolRunEmitter {
  toolStarted(name: string): void;
  toolFinished(name: string, outcome: AiToolCallOutcome, rows: number | null): void;
  /** Current offset into the turn's content (for `AiToolCallSummaryV2.offset`). */
  offset(): number;
  /** C1 (CD-7, p3 merge, Agent 3 REQUEST Q1): the latest `update_plan` steps (masked labels) for the stream. Optional. */
  plan?(steps: AiPlanStep[]): void;
}

/** Per-turn counters the registry enforces (AI_TOOL_LIMITS, AI_SKILL_LIMITS.turnCharBudget). */
export interface AiTurnToolBudget {
  toolCalls: number;
  learnCalls: number;
  skillChars: number;
}

/** The registry's per-call context, target shape (Phase 1 `AiToolRunContext` + emitter, budget and mode). */
export interface AiToolRunContextV2 {
  actor: AiActor;
  turnId: string;
  conversationId: string;
  abortTurn: (reason: 'access_revoked' | 'service_unavailable') => void;
  calls: AiToolCallSummaryV2[];
  emit: AiToolRunEmitter;
  budget: AiTurnToolBudget;
  /** `agent` (6b only): no pause tools offered, `propose_action` does not pause. */
  mode: 'interactive' | 'agent';
}

/** One permitted read tool in the system prompt's "Tools you may use" block, name-sorted, byte-stable. */
export interface AiToolCatalogueLine {
  name: string;
  summary: string;
}

/** `registry.forTurn(...)` — the ONLY entry point the runner uses after 3w (replaces `buildToolSet`). */
export interface AiTurnToolBinding {
  /** Permitted read tools, name-sorted (passed to `buildSystemPrompt`). */
  catalogue: readonly AiToolCatalogueLine[];
  /** The fixed SDK set: meta (+ pause from 5b) tools only, name-sorted, ≤ AI_MAX_SDK_TOOLS. */
  toolSet: ToolSet;
  /** Inner tool names permitted for this turn right now. */
  permitted: ReadonlySet<string>;
  /** Registered on the heartbeat tick: fingerprint; on change, full check + recompute; losing a catalogued tool's flag aborts. */
  recheck(): Promise<void>;
}

export interface AiToolRegistryContract {
  forTurn(run: AiToolRunContextV2, checker: AiPermissionChecker): Promise<AiTurnToolBinding>;
  /** Admin / Settings view: every registered tool (no schemas). */
  catalogue(): ReadonlyArray<Pick<AiToolDefinitionV2, 'name' | 'kind' | 'permission' | 'maxRows' | 'maxBytes' | 'summary'> & { label: string; parameters: readonly AiToolParameterView[] }>;
}

/** `learn_tools` input (strict; 1..AI_TOOL_LIMITS.maxNamesPerLearn names matching the pattern). */
export interface AiLearnToolsInput {
  names: string[];
}

export interface AiLearnedTool {
  name: string;
  description: string;
  /** Frozen at boot from `z.toJSONSchema(input)`, with `pattern` stripped (`format` kept) — P3 T-L3. */
  inputSchema: Record<string, unknown>;
  outputFields: readonly string[];
  limits: AiToolInputLimits;
  /** Write tools (5b): proposal-only, reachable only through `propose_action`. */
  requiresApproval?: true;
}

/**
 * `learn_tools` result. An unknown and a not-permitted name get the SAME entry (404-not-403); the model's string is never
 * echoed — entries are by position in the request, suggestions come only from this turn's permitted names.
 */
export interface AiLearnToolsResult {
  tools: AiLearnedTool[];
  unknown: { index: number; suggestions: string[] }[];
}

/** `execute_tool` input (strict; args JSON ≤ AI_TOOL_LIMITS.maxExecuteArgsBytes). */
export interface AiExecuteToolInput {
  name: string;
  args: Record<string, unknown>;
}

/** Fixed error results a tool call can return to the model (wrapped as data). Never a raw exception or record text. */
export type AiToolErrorResult =
  | { error: 'unknown_tool'; suggestions: string[] }
  | { error: 'invalid_input'; issues: string[] }
  | { error: 'tool_call_limit' }
  | { error: 'output_too_large' }
  | { error: 'tool_failed' }
  | { error: 'skill_budget_exceeded' }
  /** `execute_tool` named a write tool (5b): use `propose_action`. */
  | { error: 'proposal_required' };

/** C1 (CD-7): `update_plan` input (strict; ≤ AI_PLAN_LIMITS.maxSteps steps, label ≤ 100). Kind `meta`, no permission, no data access. */
export interface AiUpdatePlanInput {
  steps: { label: string; status: 'pending' | 'in_progress' | 'done' }[];
}
