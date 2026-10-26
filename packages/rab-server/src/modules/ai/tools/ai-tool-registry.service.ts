import { AI_PLAN_LIMITS, AiPlanStep, AiToolCallOutcome, AiToolCallSummary, AiToolParameterView, PermissionFlag, PermissionFlagType } from '@rab/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { jsonSchema, tool, ToolSet } from 'ai';
import { z } from 'zod';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import type {
  AiDefinedReadTool,
  AiLearnedTool,
  AiLearnToolsResult,
  AiPermissionChecker,
  AiToolCatalogueLine,
  AiToolDefinitionV2,
  AiToolRegistryContract,
  AiToolRunContextV2,
  AiTurnToolBinding,
  AiTurnToolBudget,
} from '../contracts/tools';
import { AiAccessRevokedError } from '../exceptions/ai.exceptions';
import { wrapToolData } from '../prompt/system-prompt';
import { AiAccessService, AiActor, aiTenantContext, PLATFORM_NOT_READY } from '../services/ai-access.service';
import {
  EXECUTE_TOOL_DESCRIPTION,
  EXECUTE_TOOL_INPUT,
  EXECUTE_TOOL_JSON_SCHEMA,
  LEARN_TOOLS_DESCRIPTION,
  LEARN_TOOLS_INPUT,
  LEARN_TOOLS_JSON_SCHEMA,
  learnedToolOf,
  toolParametersOf,
  UPDATE_PLAN_DESCRIPTION,
  UPDATE_PLAN_INPUT,
  UPDATE_PLAN_JSON_SCHEMA,
} from './ai-meta-tools';
import { AiToolOutputRefused, jsonBytes, redactForModel, sanitiseText } from './ai-output-guard';
import { AiSessionPermissionChecker } from './ai-session-permission-checker';
import { suggestTools } from './ai-tool-suggest';
import {
  AI_ACCESS_FULL_RECHECK_MS,
  AI_ACCESS_MAX_RECHECK_FAILURES,
  AI_MAX_LEARN_CALLS_PER_TURN,
  AI_MAX_TOOL_CALLS_PER_TURN,
  AI_TOOL_DEFAULT_MAX_ROWS,
  AI_TOOL_FORBIDDEN_INPUT_KEYS,
  AI_TOOL_MAX_DESCRIPTION_CHARS,
  AI_TOOL_MAX_OUTPUT_BYTES,
  AI_TOOL_MAX_ROWS_EXCEPTIONS,
  AI_READ_TOOL_LABELS,
  AI_UNAVAILABLE_TOOL_NAME,
} from './ai-tool.constants';
import { AI_TOOL_NAME_PATTERN, AiToolDefinition, AiToolExecutionContext } from './ai-tool.types';
import { toToolDefinition } from './define-tool.decorator';
import { AI_TOOL_CLASSES } from './index';

/** Phase 1 runner context (unchanged; the runner is not Phase 3's — 3w replaces `buildToolSet` with `forTurn`). */
export interface AiToolRunContext extends AiToolExecutionContext {
  calls: AiToolCallSummary[];
}

/**
 * The five Phase 1 tools the UNCHANGED Phase 1 runner still offers directly through the `buildToolSet` facade until 3w.
 * Every other read tool is reachable only lazily (`forTurn` → `learn_tools` / `execute_tool`), so no new tool reaches a
 * model before the reviewed 3w wiring (catalogue prompt, byte caps, per-turn caps, 2 s fingerprint) is in place.
 */
export const AI_LEGACY_DIRECT_TOOL_NAMES = Object.freeze(['compare_payroll_runs', 'get_attendance_summary', 'get_fill_rate', 'get_offer_status', 'list_unfilled_shifts']);

/** Audited outcome codes. The server-only codes (`not_offered`, `invalid_name`, `output_refused`) never reach a client. */
type AuditOutcome = AiToolCallOutcome | 'not_offered' | 'output_refused' | 'tool_failed';

const KNOWN_FLAGS = new Set<string>(Object.values(PermissionFlag));
const META_KEYS = { learn_tools: new Set(['names']), execute_tool: new Set(['name', 'args']), update_plan: new Set(['steps']) } as const;

/** C1 (CD-7): the turn emitter MAY carry `plan` (contract request: add it to `AiToolRunEmitter`). */
type AiPlanEmitter = { plan?(steps: AiPlanStep[]): void };

/**
 * The typed, allowlisted tool registry (Phase 1 docs/ai/PHASE1_PLAN.md; Phase 3 docs/ai/PHASE3_TWENTY_PLAN.md §2). The
 * model's choice is never trusted:
 *   registration — ONLY the reviewed `AI_READ_TOOLS` array (tools/index.ts, `AI_TOOL_CLASSES`), each class declaring its
 *                  contract with `@DefineTool()`; `validate()` refuses anything outside Phase 3 at boot (fail closed);
 *   discovery    — `forTurn` lists in the catalogue only the read tools whose ONE flag the user holds right now (read
 *                  from PostgreSQL); the SDK sees only the fixed meta tools (`execute_tool`, `learn_tools`);
 *   lookup       — `execute_tool` / `learn_tools` resolve names ONLY in this turn's permitted set: an unknown name and a
 *                  known-but-not-permitted name get the SAME `unknown_tool` answer (404-not-403), suggestions are drawn
 *                  only from permitted names, and the model's string is never echoed; the audit keeps the detail;
 *   input        — the strict Zod schema is re-applied on the server before every run (the ONLY inner check, rule 7.1);
 *   recheck      — immediately before running, the session, account, organisation, AI gates and the tool's flag are
 *                  re-read in a fresh transaction (revocation stops the whole turn); every 2 s the access fingerprint
 *                  (`binding.recheck`, on Phase 2's heartbeat at 3w), with a full re-check on change and every 15 s;
 *   execution    — the domain `assistant*` method, in its own short READ ONLY tenant transaction (crewflow_app, RLS);
 *   output       — `redactForModel`: allowlist, denylist refusal, masking, row bound, byte cap, wrapped as untrusted data;
 *   limits       — per turn: 12 tool executions, 3 `learn_tools` calls, 5 names per learn, 2 KB of arguments;
 *   audit        — one `ai.tool_called` / `ai.tool_denied` row per call (name, outcome, rows) in its own transaction.
 */
@Injectable()
export class AiToolRegistry implements AiToolRegistryContract {
  private readonly logger = new Logger('AiToolRegistry');
  private readonly definitions: readonly AiToolDefinition[];
  private readonly byName: ReadonlyMap<string, AiToolDefinition>;
  private readonly learned: ReadonlyMap<string, AiLearnedTool>;
  /** C1 (CD-9): each tool's human parameter list, derived once from its strict zod input. */
  private readonly parameters: ReadonlyMap<string, readonly AiToolParameterView[]>;
  /** Every distinct flag a registered tool declares (the discovery read). */
  private readonly toolFlags: readonly PermissionFlagType[];
  /** Per-turn budgets for contexts that carry none (the Phase 1 runner). Keyed by the run object, never global. */
  private readonly budgets = new WeakMap<object, AiTurnToolBudget>();
  /** `update_plan` calls per turn (at most AI_PLAN_LIMITS.maxUpdatesPerTurn). */
  private readonly planUpdates = new WeakMap<object, number>();

  constructor(
    @Inject(AI_TOOL_CLASSES) tools: readonly AiDefinedReadTool[],
    private readonly access: AiAccessService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
    private readonly permissionsService: PermissionsService,
  ) {
    this.definitions = AiToolRegistry.validate(tools.map((t) => toToolDefinition(t)));
    this.byName = new Map(this.definitions.map((d) => [d.name, d]));
    this.learned = new Map(this.definitions.map((d) => [d.name, learnedToolOf(d)]));
    this.parameters = new Map(this.definitions.map((d) => [d.name, Object.freeze(toolParametersOf(d))]));
    this.toolFlags = [...new Set(this.definitions.map((d) => d.permission!))];
  }

  /**
   * Boot-time validation (fail closed: the API / Worker refuse to start on a bad definition). Phase 3 registers READ tools
   * only (`meta` tools are built in, `pause` / `write` wait for 5b) and every rule of DefineToolOptions is enforced here.
   */
  static validate(defs: readonly AiToolDefinition[]): readonly AiToolDefinition[] {
    const names = new Set<string>();
    for (const d of defs) {
      if (d.kind !== 'read') throw new Error(`AI tool ${d.name}: Phase 3 registers read tools only (${String(d.kind)} refused)`);
      if (!AI_TOOL_NAME_PATTERN.test(d.name) || names.has(d.name)) throw new Error(`AI tool name invalid or duplicated: ${d.name}`);
      if (!d.permission || d.outputKeys.length === 0 || d.maxRows < 1) throw new Error(`AI tool ${d.name}: permission, output allowlist and row bound are required`);
      if (!KNOWN_FLAGS.has(d.permission)) throw new Error(`AI tool ${d.name}: unknown permission flag ${d.permission}`);
      if (d.approval) throw new Error(`AI tool ${d.name}: an approval template is refused on a read tool`);
      if (!d.description || d.description.length > AI_TOOL_MAX_DESCRIPTION_CHARS) throw new Error(`AI tool ${d.name}: description required, at most ${AI_TOOL_MAX_DESCRIPTION_CHARS} characters`);
      if (!d.summary || d.summary.length > AI_TOOL_MAX_DESCRIPTION_CHARS || /[\r\n]/.test(d.summary)) throw new Error(`AI tool ${d.name}: one-line summary required, at most ${AI_TOOL_MAX_DESCRIPTION_CHARS} characters`);
      const rowCap = AI_TOOL_MAX_ROWS_EXCEPTIONS[d.name] ?? AI_TOOL_DEFAULT_MAX_ROWS;
      if (d.maxRows > rowCap) throw new Error(`AI tool ${d.name}: maxRows ${d.maxRows} exceeds ${rowCap}`);
      if (!Number.isInteger(d.maxBytes) || d.maxBytes < 1 || d.maxBytes > AI_TOOL_MAX_OUTPUT_BYTES) throw new Error(`AI tool ${d.name}: maxBytes must be 1..${AI_TOOL_MAX_OUTPUT_BYTES}`);
      if (!(d.input instanceof z.ZodObject) || d.input._zod.def.catchall?._zod.def.type !== 'never') throw new Error(`AI tool ${d.name}: input must be a strict zod object`);
      const forbidden = Object.keys(d.input.shape).filter((k) => AI_TOOL_FORBIDDEN_INPUT_KEYS.includes(k));
      if (forbidden.length) throw new Error(`AI tool ${d.name}: input may not declare ${forbidden.join(', ')}`);
      names.add(d.name);
    }
    return Object.freeze([...defs]);
  }

  /** Every registered tool (no schemas) — the admin view, Settings → AI → Tools (Phase 8) and tests. */
  catalogue(): Array<Pick<AiToolDefinitionV2, 'name' | 'kind' | 'permission' | 'maxRows' | 'maxBytes' | 'summary'> & { label: string; parameters: readonly AiToolParameterView[] }> {
    return this.definitions.map((d) => ({
      name: d.name,
      label: AI_READ_TOOL_LABELS[d.name] ?? d.name,
      kind: d.kind,
      permission: d.permission,
      maxRows: d.maxRows,
      maxBytes: d.maxBytes,
      summary: d.summary,
      parameters: this.parameters.get(d.name) ?? [],
    }));
  }

  /**
   * C1 (CD-8): the caller's PERMITTED read tools (`GET /ai/capabilities`, built by Agent 9): exactly `forTurn`'s filter,
   * the flags the user holds right now, read from PostgreSQL by `sessionChecker`; never a second registry or list.
   */
  async permittedCatalogue(actor: AiActor): Promise<Array<{ name: string; label: string; summary: string }>> {
    const checker = await this.sessionChecker(actor);
    return this.catalogueFor(checker.permissions()).map((l) => ({ name: l.name, label: AI_READ_TOOL_LABELS[l.name] ?? l.name, summary: l.summary }));
  }

  /** The system prompt's catalogue lines for a set of held flags: permitted read tools only, name-sorted, fixed text. */
  catalogueFor(held: ReadonlySet<PermissionFlagType>): AiToolCatalogueLine[] {
    return this.definitions
      .filter((d) => d.permission && held.has(d.permission))
      .map((d) => ({ name: d.name, summary: d.summary }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Phase 1 facade: names of the DIRECT tools `buildToolSet` would offer this actor. */
  allowedToolNames(actor: Pick<AiActor, 'permissions'>): string[] {
    return this.legacyDirect().filter((d) => actor.permissions.has(d.permission!)).map((d) => d.name);
  }

  /**
   * Phase 1 FACADE (kept until 3w so the unchanged runner and its suites keep working): the five Phase 1 tools as direct
   * SDK tools, filtered by the actor's flags, each executing through `execute` below (now with the byte cap and the
   * per-turn call cap). 3w replaces this with `forTurn`.
   */
  buildToolSet(run: AiToolExecutionContext): ToolSet {
    const tools: ToolSet = {};
    for (const def of this.legacyDirect()) {
      if (!run.actor.permissions.has(def.permission!)) continue;
      tools[def.name] = tool({ description: def.description, inputSchema: def.input, execute: async (raw: unknown) => this.execute(def, raw, run) });
    }
    return tools;
  }

  /**
   * The session `AiPermissionChecker` for a Worker-rebuilt actor: the tool flags it holds RIGHT NOW, read from PostgreSQL
   * in the user's own tenant context (never the JWT, job data or the actor's cached set).
   */
  async sessionChecker(actor: AiActor): Promise<AiSessionPermissionChecker> {
    const ctx = aiTenantContext(actor);
    const held = await this.tenantContext.runInTenantContext(ctx, async (m) => {
      const out = new Set<PermissionFlagType>();
      for (const flag of this.toolFlags) if (await this.permissionsService.userHasPermissionTx(m, ctx, flag)) out.add(flag);
      return out;
    });
    return new AiSessionPermissionChecker(actor, this.access, held);
  }

  /**
   * The ONLY entry point the runner uses after 3w (contract `AiTurnToolBinding`): the catalogue (permitted read tools,
   * name-sorted, for `buildSystemPrompt`), the fixed name-sorted SDK set of meta tools, this turn's permitted names, and
   * `recheck()` for the 2 s heartbeat. The baseline fingerprint is taken here; if it cannot be read the turn does not start.
   */
  async forTurn(run: AiToolRunContextV2, checker: AiPermissionChecker): Promise<AiTurnToolBinding> {
    const held = checker.permissions();
    const catalogue = Object.freeze(this.catalogueFor(held).map((l) => Object.freeze(l)));
    const permitted: ReadonlySet<string> = new Set(catalogue.map((l) => l.name));
    const catalogued = [...new Set(catalogue.map((l) => this.byName.get(l.name)!.permission!))];
    const state = { last: await checker.fingerprint(), lastFull: Date.now(), failures: 0, inFlight: null as Promise<void> | null, stopped: false };

    const fail = (): void => {
      state.failures += 1;
      if (state.failures >= AI_ACCESS_MAX_RECHECK_FAILURES) {
        state.stopped = true;
        run.abortTurn('service_unavailable');
        throw new AiAccessRevokedError(PLATFORM_NOT_READY);
      }
    };
    const tick = async (): Promise<void> => {
      let fingerprint: string;
      try {
        fingerprint = await checker.fingerprint();
      } catch {
        fail();
        return;
      }
      if (fingerprint === state.last && Date.now() - state.lastFull < AI_ACCESS_FULL_RECHECK_MS) {
        state.failures = 0;
        return;
      }
      try {
        // Changed (or 15 s since the last full check): the FULL check, once per catalogued flag — losing any catalogued
        // tool's flag stops the turn; the permitted set never grows mid-turn.
        if (catalogued.length === 0) await checker.assertStillAllowed();
        for (const flag of catalogued) await checker.assertStillAllowed(flag);
      } catch (error) {
        if (error instanceof AiAccessRevokedError) {
          state.stopped = true;
          run.abortTurn(error.reason === PLATFORM_NOT_READY ? 'service_unavailable' : 'access_revoked');
          throw error;
        }
        fail();
        return;
      }
      state.failures = 0;
      state.last = fingerprint;
      state.lastFull = Date.now();
    };
    const recheck = async (): Promise<void> => {
      if (state.stopped) throw new AiAccessRevokedError('stopped');
      if (state.inFlight) return; // never overlaps itself
      state.inFlight = tick().finally(() => {
        state.inFlight = null;
      });
      return state.inFlight;
    };

    // Once a recheck stopped the turn, no further tool call of this binding runs (fail closed).
    const guard = (): void => {
      if (state.stopped) throw new Error('tool not permitted');
    };
    const toolSet: ToolSet = {
      execute_tool: tool({
        description: EXECUTE_TOOL_DESCRIPTION,
        inputSchema: jsonSchema(structuredClone(EXECUTE_TOOL_JSON_SCHEMA) as JsonSchemaInput),
        execute: async (raw: unknown) => this.executeByName(run, checker, permitted, raw, guard),
      }),
      learn_tools: tool({
        description: LEARN_TOOLS_DESCRIPTION,
        inputSchema: jsonSchema(structuredClone(LEARN_TOOLS_JSON_SCHEMA) as JsonSchemaInput),
        execute: async (raw: unknown) => this.learn(run, checker, permitted, raw, guard),
      }),
      update_plan: tool({
        description: UPDATE_PLAN_DESCRIPTION,
        inputSchema: jsonSchema(structuredClone(UPDATE_PLAN_JSON_SCHEMA) as JsonSchemaInput),
        execute: async (raw: unknown) => this.updatePlan(run, raw, guard),
      }),
    };
    return { catalogue, toolSet, permitted, recheck };
  }

  /**
   * `learn_tools`: for each requested name IN THIS TURN'S PERMITTED SET, the frozen description + published schema + output
   * fields + limits. Any other name (unknown or not permitted, identically) is reported by its POSITION with suggestions
   * from permitted names only — the model's string is never echoed. ≤ 3 calls per turn; a full access re-check first.
   */
  async learn(run: AiToolRunContextV2, checker: AiPermissionChecker, permitted: ReadonlySet<string>, raw: unknown, guard?: () => void): Promise<unknown> {
    guard?.();
    const budget = this.budgetOf(run);
    budget.learnCalls += 1;
    if (budget.learnCalls > AI_MAX_LEARN_CALLS_PER_TURN) {
      this.record(run, 'learn_tools', 'tool_call_limit', null, 'meta');
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, 'learn_tools', 'tool_call_limit', null).catch(() => undefined);
      return wrapToolData('learn_tools', { error: 'tool_call_limit' });
    }
    const parsed = LEARN_TOOLS_INPUT.safeParse(raw);
    if (!parsed.success) {
      this.record(run, 'learn_tools', 'invalid_input', null, 'meta');
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, 'learn_tools', 'invalid_input', null).catch(() => undefined);
      return wrapToolData('learn_tools', { error: 'invalid_input', issues: safeIssues(parsed.error, META_KEYS.learn_tools) });
    }
    try {
      await checker.assertStillAllowed();
    } catch (error) {
      this.record(run, 'learn_tools', 'denied', null, 'meta');
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, 'learn_tools', 'denied', null).catch(() => undefined);
      if (error instanceof AiAccessRevokedError) run.abortTurn('access_revoked');
      throw new Error('tool not permitted');
    }
    const result: AiLearnToolsResult = { tools: [], unknown: [] };
    const learnedNames: string[] = [];
    const unknownNames: string[] = [];
    parsed.data.names.forEach((name, index) => {
      const entry = permitted.has(name) ? this.learned.get(name) : undefined;
      if (entry && !learnedNames.includes(name)) {
        result.tools.push(entry);
        learnedNames.push(name);
      } else if (!entry) {
        result.unknown.push({ index, suggestions: suggestTools(name, permitted) });
        unknownNames.push(this.byName.has(name) ? `${name}:denied` : `${name}:not_offered`);
      }
    });
    const payload = wrapToolData('learn_tools', result);
    if (jsonBytes(payload) > AI_TOOL_MAX_OUTPUT_BYTES) {
      this.record(run, 'learn_tools', 'output_too_large', null, 'meta');
      await this.auditCall(run, AuditAction.AI_TOOL_CALLED, 'learn_tools', 'output_too_large', null).catch(() => undefined);
      return wrapToolData('learn_tools', { error: 'output_too_large' });
    }
    this.record(run, 'learn_tools', 'ok', result.tools.length, 'meta');
    await this.auditCall(run, AuditAction.AI_TOOL_CALLED, 'learn_tools', 'ok', result.tools.length, { learned: learnedNames, unknown: unknownNames }).catch(() => undefined);
    return payload;
  }

  /**
   * `execute_tool`: the outer strict parse, then the name looked up ONLY in this turn's permitted set (unknown and not
   * permitted: the same `unknown_tool` answer, the model's string never echoed, no service call), then the same server
   * path as a direct call (`runTool`). Recorded and streamed under the inner name when permitted, else `unavailable_tool`.
   */
  async executeByName(run: AiToolRunContextV2, checker: AiPermissionChecker, permitted: ReadonlySet<string>, raw: unknown, guard?: () => void): Promise<unknown> {
    guard?.();
    const rawName = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).name : undefined;
    const def = typeof rawName === 'string' && permitted.has(rawName) ? this.byName.get(rawName) : undefined;
    const shown = def?.name ?? AI_UNAVAILABLE_TOOL_NAME;
    const auditName = typeof rawName === 'string' && AI_TOOL_NAME_PATTERN.test(rawName) ? rawName : 'invalid_name';
    run.emit?.toolStarted(shown);
    const finish = (outcome: AiToolCallOutcome, rows: number | null) => run.emit?.toolFinished(shown, outcome, rows);

    const budget = this.budgetOf(run);
    budget.toolCalls += 1;
    if (budget.toolCalls > AI_MAX_TOOL_CALLS_PER_TURN) {
      this.record(run, shown, 'tool_call_limit', null, def ? 'read' : undefined);
      finish('tool_call_limit', null);
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, auditName, 'tool_call_limit', null).catch(() => undefined);
      return wrapToolData('execute_tool', { error: 'tool_call_limit' });
    }
    const parsed = EXECUTE_TOOL_INPUT.safeParse(raw);
    if (!parsed.success) {
      this.record(run, shown, 'invalid_input', null, def ? 'read' : undefined);
      finish('invalid_input', null);
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, auditName, 'invalid_input', null).catch(() => undefined);
      return wrapToolData(def?.name ?? 'execute_tool', { error: 'invalid_input', issues: safeIssues(parsed.error, META_KEYS.execute_tool) });
    }
    if (!def) {
      this.record(run, shown, 'unknown_tool', null);
      finish('unknown_tool', null);
      // Server-side detail only: whether the name exists at all ('denied') or not ('not_offered').
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, auditName, this.byName.has(parsed.data.name) ? 'denied' : 'not_offered', null).catch(() => undefined);
      return wrapToolData('execute_tool', { error: 'unknown_tool', suggestions: suggestTools(parsed.data.name, permitted) });
    }
    const out = await this.runTool(def, parsed.data.args, run, { meta: true, recheck: (flag) => checker.assertStillAllowed(flag), finish });
    return out;
  }

  /**
   * `update_plan` (C1 CD-7): masks and records an informational checklist; no permission, no data access, no domain call.
   * At most 6 updates per turn AND each counted in the per-turn tool-call cap. Stored on the turn's call summary (`plan`)
   * and streamed as a `plan` event through the emitter. The result never says "approved".
   */
  async updatePlan(run: AiToolRunContextV2, raw: unknown, guard?: () => void): Promise<unknown> {
    guard?.();
    const budget = this.budgetOf(run);
    budget.toolCalls += 1;
    const updates = (this.planUpdates.get(run) ?? 0) + 1;
    this.planUpdates.set(run, updates);
    if (budget.toolCalls > AI_MAX_TOOL_CALLS_PER_TURN || updates > AI_PLAN_LIMITS.maxUpdatesPerTurn) {
      this.record(run, 'update_plan', 'tool_call_limit', null, 'meta');
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, 'update_plan', 'tool_call_limit', null).catch(() => undefined);
      return wrapToolData('update_plan', { error: 'tool_call_limit' });
    }
    const parsed = UPDATE_PLAN_INPUT.safeParse(raw);
    if (!parsed.success) {
      this.record(run, 'update_plan', 'invalid_input', null, 'meta');
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, 'update_plan', 'invalid_input', null).catch(() => undefined);
      return wrapToolData('update_plan', { error: 'invalid_input', issues: safeIssues(parsed.error, META_KEYS.update_plan) });
    }
    // Plain text only: control characters and markup stripped, emails / phones / NI / account-like numbers masked.
    const steps: AiPlanStep[] = parsed.data.steps.map((st) => ({ label: sanitiseText(st.label).slice(0, AI_PLAN_LIMITS.labelMaxChars), status: st.status }));
    const offset = run.emit?.offset();
    run.calls.push({ name: 'update_plan', outcome: 'ok', rows: steps.length, kind: 'meta', plan: steps, ...(offset !== undefined ? { offset } : {}) });
    (run.emit as (AiToolRunContextV2['emit'] & AiPlanEmitter) | undefined)?.plan?.(steps);
    await this.auditCall(run, AuditAction.AI_TOOL_CALLED, 'update_plan', 'ok', steps.length).catch(() => undefined);
    return wrapToolData('update_plan', { recorded: true, steps: steps.length });
  }

  /** Exported for tests and the Phase 1 facade: the server-side execution path of ONE direct tool call (never trusts `raw`). */
  async execute(def: AiToolDefinition, raw: unknown, run: AiToolExecutionContext): Promise<unknown> {
    const budget = this.budgetOf(run);
    budget.toolCalls += 1;
    if (budget.toolCalls > AI_MAX_TOOL_CALLS_PER_TURN) {
      this.record(run, def.name, 'tool_call_limit', null);
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, def.name, 'tool_call_limit', null).catch(() => undefined);
      return wrapToolData(def.name, { error: 'tool_call_limit' });
    }
    if (!run.actor.permissions.has(def.permission!)) {
      // Only reachable from a test: the facade never offers a tool whose flag the actor lacks.
      const parsed = def.input.safeParse(raw);
      if (!parsed.success) return this.invalid(def, run, false, parsed.error);
      this.record(run, def.name, 'denied', null);
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, def.name, 'denied', null);
      return wrapToolData(def.name, { error: 'not_permitted' });
    }
    return this.runTool(def, raw, run, { meta: false, recheck: (flag) => this.access.assertStillAllowed(run.actor, flag) });
  }

  /** A tool the model named that this user was not offered (or that does not exist): never executed, audited. */
  async recordUnknownToolCall(run: AiToolExecutionContext, toolName: string): Promise<void> {
    const name = AI_TOOL_NAME_PATTERN.test(toolName) ? toolName : 'invalid_name';
    this.record(run, name, 'denied', null);
    await this.auditCall(run, AuditAction.AI_TOOL_DENIED, name, 'not_offered', null).catch(() => undefined);
  }

  /** Strict parse → fresh access + flag re-check (revoked: stop the turn) → domain read → redactForModel → audit. */
  private async runTool(
    def: AiToolDefinition,
    raw: unknown,
    run: AiToolExecutionContext,
    opts: { meta: boolean; recheck: (flag: PermissionFlagType) => Promise<void>; finish?: (outcome: AiToolCallOutcome, rows: number | null) => void },
  ): Promise<unknown> {
    const parsed = def.input.safeParse(raw);
    if (!parsed.success) {
      opts.finish?.('invalid_input', null);
      return this.invalid(def, run, opts.meta, parsed.error);
    }
    try {
      await opts.recheck(def.permission!);
    } catch (error) {
      this.record(run, def.name, 'denied', null, opts.meta ? 'read' : undefined);
      opts.finish?.('denied', null);
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, def.name, 'denied', null).catch(() => undefined);
      if (error instanceof AiAccessRevokedError) run.abortTurn('access_revoked');
      throw new Error('tool not permitted');
    }
    try {
      const result = await def.run(run.actor, parsed.data);
      const redacted = redactForModel(result, def);
      if (!redacted.ok) {
        this.record(run, def.name, opts.meta ? 'output_too_large' : 'error', null, opts.meta ? 'read' : undefined);
        opts.finish?.('output_too_large', null);
        await this.auditCall(run, AuditAction.AI_TOOL_CALLED, def.name, 'output_too_large', null).catch(() => undefined);
        return wrapToolData(def.name, { error: 'output_too_large' });
      }
      this.record(run, def.name, 'ok', redacted.rows, opts.meta ? 'read' : undefined);
      opts.finish?.('ok', redacted.rows);
      await this.auditCall(run, AuditAction.AI_TOOL_CALLED, def.name, 'ok', redacted.rows, redacted.truncated ? { truncated: true } : undefined);
      return redacted.payload;
    } catch (error) {
      // Never forward the error text to the model or the log (it could quote record values); a fixed code only.
      const outcome = error instanceof AiToolOutputRefused ? 'output_refused' : 'tool_failed';
      this.logger.warn(`tool ${def.name} failed for turn ${run.turnId}: ${outcome}`);
      this.record(run, def.name, 'error', null, opts.meta ? 'read' : undefined);
      opts.finish?.('error', null);
      await this.auditCall(run, AuditAction.AI_TOOL_CALLED, def.name, outcome === 'tool_failed' ? 'error' : outcome, null).catch(() => undefined);
      return wrapToolData(def.name, { error: 'tool_failed' });
    }
  }

  private async invalid(def: AiToolDefinition, run: AiToolExecutionContext, meta: boolean, error: z.ZodError): Promise<unknown> {
    this.record(run, def.name, 'invalid_input', null, meta ? 'read' : undefined);
    await this.auditCall(run, AuditAction.AI_TOOL_DENIED, def.name, 'invalid_input', null);
    // The Phase 1 direct path keeps its exact answer; the lazy path adds issue codes (never the model's values).
    return wrapToolData(def.name, meta ? { error: 'invalid_input', issues: safeIssues(error, new Set(Object.keys((def.input as z.ZodObject).shape))) } : { error: 'invalid_input' });
  }

  private legacyDirect(): AiToolDefinition[] {
    return this.definitions.filter((d) => AI_LEGACY_DIRECT_TOOL_NAMES.includes(d.name));
  }

  private budgetOf(run: AiToolExecutionContext): AiTurnToolBudget {
    if (run.budget) return run.budget;
    let budget = this.budgets.get(run);
    if (!budget) this.budgets.set(run, (budget = { toolCalls: 0, learnCalls: 0, skillChars: 0 }));
    return budget;
  }

  private record(run: AiToolExecutionContext, name: string, outcome: AiToolCallOutcome, rows: number | null, kind?: 'read' | 'meta'): void {
    const offset = run.emit?.offset();
    run.calls.push({ name, outcome, rows, ...(kind ? { kind } : {}), ...(offset !== undefined ? { offset } : {}) });
  }

  private async auditCall(
    run: AiToolExecutionContext,
    action: typeof AuditAction.AI_TOOL_CALLED | typeof AuditAction.AI_TOOL_DENIED,
    tool: string,
    outcome: AuditOutcome,
    rows: number | null,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const ctx = aiTenantContext(run.actor);
    await this.tenantContext.runInTenantContext(ctx, (m) =>
      this.audit.record(m, ctx, action, { entityType: 'ai_turn', entityId: run.turnId, metadata: { tool, outcome, rows, conversationId: run.conversationId, ...(extra ?? {}) } }),
    );
  }
}

/** Zod issues as fixed codes, with a path segment only when it is one of the schema's own keys (never a model value). */
export function safeIssues(error: z.ZodError, knownKeys: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const issue of error.issues) {
    const head = issue.path[0];
    out.add(typeof head === 'string' && knownKeys.has(head) ? `${head}: ${issue.code}` : issue.code);
    if (out.size >= 5) break;
  }
  return [...out];
}

type JsonSchemaInput = Parameters<typeof jsonSchema>[0];
