import { AI_SKILL_LIMITS, AI_SKILL_NAME_PATTERN, AiMetaToolName, AiToolCallOutcome } from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiLoadSkillsResult } from '../contracts/skills';
import { AiPermissionChecker, AiToolErrorResult, AiToolRunContextV2, DefineToolOptions } from '../contracts/tools';
import { AiAccessRevokedError } from '../exceptions/ai.exceptions';
import { aiTenantContext } from '../services/ai-access.service';
import { AiSkillService } from '../services/ai-skill.service';
import { AiWrappedSkillResult, wrapSkillContent } from '../tools/ai-skill-guard';

/**
 * The `load_skills` META tool (docs/ai/PHASE4_TWENTY_PLAN.md §2.3 (2)/(4), C6, resolution X-4/X-5). Defined here, NOT
 * registered: the registry's `meta` registration, the prompt rule and the catalogue are 4w (Batch 2), so the handler is
 * tested directly. It imports neither the registry nor any tool definition nor PermissionsService (G1, T4-X1).
 *
 *   input   — strict zod: `names`, 1..AI_SKILL_LIMITS.maxPerLoad distinct names matching AI_SKILL_NAME_PATTERN; re-parsed
 *             on the server (the model's arguments are never trusted, cast or spread);
 *   gate    — no domain permission (`permission: null`): offered to every AI-eligible actor, gated by the AI access check
 *             itself, re-run fresh before the read (`checker.assertStillAllowed()`, G3; a revocation stops the turn);
 *   read    — `AiSkillReader.load` in its own READ ONLY tenant transaction as the actor (RLS: this organisation, eligible
 *             users only). Unknown, inactive and other-organisation names all come back in `missing`, alike;
 *   budget  — at most AI_SKILL_LIMITS.turnCharBudget characters of skill text per turn (tagged + loaded, D6); beyond it the
 *             call returns `{error: 'skill_budget_exceeded'}` and loads nothing;
 *   output  — text only, through `guardSkillContent` (never the record guard), wrapped under AI_SKILL_RESULT_NOTICE. It
 *             returns no tool name, schema or permission: nothing in a skill can reach the tool set (G2);
 *   audit   — one `ai.tool_called` / `ai.tool_denied` row with skill NAMES only (never content), in its own transaction.
 */
export const LOAD_SKILLS_TOOL_NAME = 'load_skills' satisfies AiMetaToolName;

export const loadSkillsInputSchema = z
  .object({
    names: z
      .array(z.string().regex(AI_SKILL_NAME_PATTERN))
      .min(1)
      .max(AI_SKILL_LIMITS.maxPerLoad)
      .refine((names) => new Set(names).size === names.length),
  })
  .strict();

/**
 * The definition the 4w registration uses. Output policy note for 4w: the generic record byte cap
 * (AI_TOOL_LIMITS.maxOutputBytes, 16 KB) cannot hold one 20,000-character skill; this tool's bound is the per-turn
 * character budget, enforced here, and its guard is `guardSkillContent` (C3). The registry must not route this result
 * through `guardToolOutput`.
 */
export const LOAD_SKILLS_TOOL: DefineToolOptions<typeof loadSkillsInputSchema> = {
  name: LOAD_SKILLS_TOOL_NAME,
  description:
    'Load the full text of up to 3 skills listed under "Available skills", by name. Skills are instructions only; they give you no permissions or tools, and the Crewflow rules always win over a skill.',
  summary: 'Load up to 3 skills by name (instructions only).',
  kind: 'meta',
  permission: null,
  input: loadSkillsInputSchema,
  output: { keys: ['skills', 'name', 'label', 'content', 'missing', 'error'], maxRows: AI_SKILL_LIMITS.maxPerLoad },
};

export type LoadSkillsToolData = AiLoadSkillsResult | Extract<AiToolErrorResult, { error: 'invalid_input' | 'tool_failed' }>;

@Injectable()
export class LoadSkillsTool {
  private readonly logger = new Logger('LoadSkillsTool');

  constructor(
    private readonly reader: AiSkillService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The server-side execution of ONE `load_skills` call (never trusts `raw`). */
  async execute(run: AiToolRunContextV2, checker: Pick<AiPermissionChecker, 'assertStillAllowed'>, raw: unknown): Promise<AiWrappedSkillResult<LoadSkillsToolData>> {
    const parsed = loadSkillsInputSchema.safeParse(raw);
    if (!parsed.success) {
      await this.record(run, 'invalid_input', [], []);
      return wrapSkillContent<LoadSkillsToolData>({ error: 'invalid_input', issues: ['names'] });
    }
    try {
      await checker.assertStillAllowed();
    } catch (error) {
      await this.record(run, 'denied', [], []).catch(() => undefined);
      if (error instanceof AiAccessRevokedError) run.abortTurn('access_revoked');
      throw new Error('tool not permitted');
    }
    const used = Math.max(0, run.budget.skillChars);
    let result: AiLoadSkillsResult;
    try {
      result = await this.reader.load(run.actor, parsed.data.names, AI_SKILL_LIMITS.turnCharBudget - used);
    } catch {
      // Never forward the error text (it could quote stored text); a fixed code only.
      this.logger.warn(`load_skills failed for turn ${run.turnId}`);
      await this.record(run, 'error', [], []).catch(() => undefined);
      return wrapSkillContent<LoadSkillsToolData>({ error: 'tool_failed' });
    }
    if ('error' in result) {
      await this.record(run, 'skill_budget_exceeded', [], []);
      return wrapSkillContent<LoadSkillsToolData>(result);
    }
    run.budget.skillChars = used + result.skills.reduce((sum, s) => sum + s.content.length, 0);
    await this.record(run, 'ok', result.skills.map((s) => s.name), result.missing);
    return wrapSkillContent<LoadSkillsToolData>(result);
  }

  private async record(run: AiToolRunContextV2, outcome: AiToolCallOutcome, loaded: string[], missing: string[]): Promise<void> {
    run.calls.push({ name: LOAD_SKILLS_TOOL_NAME, outcome, rows: outcome === 'ok' ? loaded.length : null, kind: 'meta', skills: loaded });
    const ctx = aiTenantContext(run.actor);
    const action = outcome === 'ok' || outcome === 'skill_budget_exceeded' || outcome === 'error' ? AuditAction.AI_TOOL_CALLED : AuditAction.AI_TOOL_DENIED;
    await this.tenantContext.runInTenantContext(ctx, (m) =>
      this.audit.record(m, ctx, action, {
        entityType: 'ai_turn',
        entityId: run.turnId,
        metadata: { tool: LOAD_SKILLS_TOOL_NAME, outcome, rows: outcome === 'ok' ? loaded.length : null, skills: loaded, missing, conversationId: run.conversationId },
      }),
    );
  }
}
