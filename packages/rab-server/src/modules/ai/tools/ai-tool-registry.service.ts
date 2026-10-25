import { AiToolCallSummary } from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';
import { tool, ToolSet } from 'ai';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AttendanceService } from '../../attendance/services/attendance.service';
import { OfferService } from '../../offer/services/offer.service';
import { PayrollRunService } from '../../payroll/services/payroll-run.service';
import { SchedulingService } from '../../scheduling/services/scheduling.service';
import { AiAccessRevokedError } from '../exceptions/ai.exceptions';
import { wrapToolData } from '../prompt/system-prompt';
import { AiAccessService, AiActor, aiTenantContext } from '../services/ai-access.service';
import { AiToolOutputRefused, guardToolOutput } from './ai-output-guard';
import { buildAiToolDefinitions } from './ai-tool-definitions';
import { AI_TOOL_NAME_PATTERN, AiToolDefinition } from './ai-tool.types';

export interface AiToolRunContext {
  actor: AiActor;
  turnId: string;
  conversationId: string;
  /** Stops the whole turn (access revoked mid-turn). */
  abortTurn: (reason: 'access_revoked') => void;
  /** Metadata of every executed/refused call, persisted on the turn (never arguments or results). */
  calls: AiToolCallSummary[];
}

/**
 * The typed, allowlisted tool registry (docs/ai/PHASE1_PLAN.md). The model only ever sees the tools this method
 * returns for THIS user, and every call goes through `execute` below — the model's choice is never trusted:
 *   discovery   — a tool is offered only if the actor (rebuilt from PostgreSQL at Worker start) holds its permission;
 *   input       — the strict Zod schema is re-applied on the server (the SDK validated it too); unknown fields refuse;
 *   recheck     — immediately before running, the session, account, organisation, AI gates and the tool's permission are
 *                 re-read in a fresh transaction; a revocation stops the whole turn, not just the call;
 *   execution   — the existing domain service method, in its own short tenant transaction (crewflow_app, RLS bound);
 *   output      — allowlisted keys only, denylist refusal, value masking, row bound, wrapped as untrusted `data`;
 *   audit       — one `ai.tool_called` / `ai.tool_denied` row (tool name, outcome, row count) in its own transaction.
 * Phase 1 registers READ tools only; a non-read definition refuses at construction.
 */
@Injectable()
export class AiToolRegistry {
  private readonly logger = new Logger('AiToolRegistry');
  private readonly definitions: readonly AiToolDefinition[];

  constructor(
    scheduling: SchedulingService,
    offers: OfferService,
    attendance: AttendanceService,
    payrollRuns: PayrollRunService,
    private readonly access: AiAccessService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {
    this.definitions = AiToolRegistry.validate(buildAiToolDefinitions({ scheduling, offers, attendance, payrollRuns }));
  }

  static validate(defs: AiToolDefinition[]): readonly AiToolDefinition[] {
    const names = new Set<string>();
    for (const d of defs) {
      if (d.kind !== 'read') throw new Error(`AI tool ${d.name}: Phase 1 allows read tools only`);
      if (!AI_TOOL_NAME_PATTERN.test(d.name) || names.has(d.name)) throw new Error(`AI tool name invalid or duplicated: ${d.name}`);
      if (!d.permission || d.outputKeys.length === 0 || d.maxRows < 1) throw new Error(`AI tool ${d.name}: permission, output allowlist and row bound are required`);
      names.add(d.name);
    }
    return Object.freeze([...defs]);
  }

  /** Every registered tool (name, permission, kind) — metadata for the admin view and tests. */
  catalogue(): Array<Pick<AiToolDefinition, 'name' | 'kind' | 'permission' | 'maxRows'>> {
    return this.definitions.map((d) => ({ name: d.name, kind: d.kind, permission: d.permission, maxRows: d.maxRows }));
  }

  /** Names of the tools this actor may be offered (discovery filter). */
  allowedToolNames(actor: Pick<AiActor, 'permissions'>): string[] {
    return this.definitions.filter((d) => actor.permissions.has(d.permission)).map((d) => d.name);
  }

  buildToolSet(run: AiToolRunContext): ToolSet {
    const tools: ToolSet = {};
    for (const def of this.definitions) {
      if (!run.actor.permissions.has(def.permission)) continue;
      tools[def.name] = tool({
        description: def.description,
        inputSchema: def.input,
        execute: async (raw: unknown) => this.execute(def, raw, run),
      });
    }
    return tools;
  }

  /** Exported for tests: the server-side execution path of ONE tool call (never trusts `raw`). */
  async execute(def: AiToolDefinition, raw: unknown, run: AiToolRunContext): Promise<unknown> {
    const parsed = def.input.safeParse(raw);
    if (!parsed.success) {
      run.calls.push({ name: def.name, outcome: 'invalid_input', rows: null });
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, def.name, 'invalid_input', null);
      return wrapToolData(def.name, { error: 'invalid_input' });
    }
    if (!run.actor.permissions.has(def.permission)) {
      run.calls.push({ name: def.name, outcome: 'denied', rows: null });
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, def.name, 'denied', null);
      return wrapToolData(def.name, { error: 'not_permitted' });
    }
    try {
      await this.access.assertStillAllowed(run.actor, def.permission);
    } catch (error) {
      run.calls.push({ name: def.name, outcome: 'denied', rows: null });
      await this.auditCall(run, AuditAction.AI_TOOL_DENIED, def.name, 'denied', null).catch(() => undefined);
      if (error instanceof AiAccessRevokedError) run.abortTurn('access_revoked');
      throw new Error('tool not permitted');
    }
    try {
      const result = await def.run(run.actor, parsed.data);
      const guarded = guardToolOutput(result, { allowedKeys: new Set(def.outputKeys), maxRows: def.maxRows });
      const rows = countRows(guarded);
      run.calls.push({ name: def.name, outcome: 'ok', rows });
      await this.auditCall(run, AuditAction.AI_TOOL_CALLED, def.name, 'ok', rows);
      return wrapToolData(def.name, guarded);
    } catch (error) {
      // Never forward the error text to the model or the log (it could quote record values); a fixed code only.
      const outcome = error instanceof AiToolOutputRefused ? 'output_refused' : 'error';
      this.logger.warn(`tool ${def.name} failed for turn ${run.turnId}: ${outcome}`);
      run.calls.push({ name: def.name, outcome: 'error', rows: null });
      await this.auditCall(run, AuditAction.AI_TOOL_CALLED, def.name, outcome, null).catch(() => undefined);
      return wrapToolData(def.name, { error: 'tool_failed' });
    }
  }

  /** A tool the model named that this user was not offered (or that does not exist): never executed, audited. */
  async recordUnknownToolCall(run: AiToolRunContext, toolName: string): Promise<void> {
    const name = AI_TOOL_NAME_PATTERN.test(toolName) ? toolName : 'invalid_name';
    run.calls.push({ name, outcome: 'denied', rows: null });
    await this.auditCall(run, AuditAction.AI_TOOL_DENIED, name, 'not_offered', null).catch(() => undefined);
  }

  private async auditCall(run: AiToolRunContext, action: typeof AuditAction.AI_TOOL_CALLED | typeof AuditAction.AI_TOOL_DENIED, tool: string, outcome: string, rows: number | null): Promise<void> {
    const ctx = aiTenantContext(run.actor);
    await this.tenantContext.runInTenantContext(ctx, (m) =>
      this.audit.record(m, ctx, action, { entityType: 'ai_turn', entityId: run.turnId, metadata: { tool, outcome, rows, conversationId: run.conversationId } }),
    );
  }
}

function countRows(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) if (Array.isArray(inner)) return inner.length;
  }
  return 1;
}
