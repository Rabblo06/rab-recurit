import { Injectable, Logger } from '@nestjs/common';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { AiCatalogueModel, isRealProvider } from '../../../engine/core-modules/ai/models/catalog';
import { maxInputTokensFromBytes, stepCostUsdMicros, worstCaseStepUsdMicros } from '../../../engine/core-modules/ai/models/cost';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiTitleJobData } from '../../../engine/worker-shared/ai-jobs.contract';
import { AI_CHAT_TIER, AI_TITLE_MAX_COLLECTED_CHARS, AI_TITLE_TIMEOUT_MS } from '../constants/ai.constants';
import { AI_MODEL_TIER_FOR_USE } from '../contracts/models';
import { AiTitleOutcome, AiTurnIds } from '../contracts/turn';
import { AiAccessRevokedError, AiTooManyRequestsException } from '../exceptions/ai.exceptions';
import { AiStepRefusedError, ModelGatewayService } from '../gateway/model-gateway.service';
import { AI_TITLE_SYSTEM_PROMPT, buildTitleMessages, sanitiseTitle } from '../prompt/title-prompt';
import { AiAccessService, AiActor, PLATFORM_NOT_READY } from './ai-access.service';
import { AiConfigService } from './ai-config.service';
import { AiCostBudgetExhaustedError, AiCostMeterService } from './ai-cost-meter.service';
import { AiQuotaService, utcDay } from './ai-quota.service';
import { AiStreamService } from './ai-stream.service';
import { AiUsageService } from './ai-usage.service';

/** The ids of an `ai-title` job, or null for anything malformed (skipped, nothing read). Lookup inputs only. */
export function titleJobIds(job: unknown): AiTurnIds | null {
  if (!job || typeof job !== 'object') return null;
  const j = job as Partial<AiTitleJobData>;
  if (j.v !== 2 || j.kind !== 'title') return null;
  const ids = [j.turnId, j.conversationId, j.organisationId, j.workspaceId, j.userId];
  if (!ids.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 64)) return null;
  return { turnId: j.turnId!, conversationId: j.conversationId!, organisationId: j.organisationId!, workspaceId: j.workspaceId!, userId: j.userId! };
}

interface TitleFacts {
  title_source: string;
  first: string | null;
  session_id: string | null;
}

/**
 * Thread titles in the Worker (docs/ai/PHASE2_TWENTY_PLAN.md §2.5, P2-C9): one internal model call the user did not
 * directly ask for, so it gets EVERY control a turn gets and nothing a turn does not need.
 *
 *   trigger   the conversation's first submit enqueues `ai-title.<conversationId>` (IDs only, at most one, no retry), only
 *             while AI_TITLE_GENERATION is on and `title_source = 'auto'`;
 *   authority `rebuildForWorker` from PostgreSQL (session, account, organisation, ai.use, eligibility, both switches, the
 *             kill switch, a usable fast-tier model, EX-1 clearance); then the `auto → pending` compare-and-set;
 *   the call  `ModelGatewayService.stream` — the one `streamText` (telemetry off, `prepareStep`: model still usable, for a
 *             real provider the EX-1 request-time synthetic re-check and the outgoing payload scan, then `beforeStep`:
 *             access re-check + the worst-case cost reservation). No tools (so exactly one step; a second is refused), a
 *             20 s timeout, the output cut off after AI_TITLE_MAX_COLLECTED_CHARS. The ONLY input is the first user
 *             message, masked for a real provider and wrapped in `<data>` (prompt/title-prompt.ts, versioned);
 *   billing   the organisation's token budget is reserved before the call and reconciled after it; the estimated cost is
 *             reserved per step and settled; `ai_usage_daily` gets the tokens + cost + `title_calls += 1`, `turns`
 *             unchanged; rate-exempt (P7-D7-9);
 *   output    sanitised (one line, no Markdown, masked, ≤ 120) and written only while `pending` (→ `model`), audited
 *             `ai.title_generated {model, tokens}`; published as a `title` event on the turn's stream if it is still open;
 *   failure   the fallback title stays, the state returns to `auto`, no retry, the user sees no error. A refusal is
 *             audited `ai.turn_refused` (stage `title`, codes only — never the matched text).
 */
@Injectable()
export class AiTitleService {
  private readonly logger = new Logger('AiTitle');
  private readonly inflight = new Set<AbortController>();

  constructor(
    private readonly config: AiConfigService,
    private readonly env: EnvironmentService,
    private readonly access: AiAccessService,
    private readonly gateway: ModelGatewayService,
    private readonly quota: AiQuotaService,
    private readonly costMeter: AiCostMeterService,
    private readonly usage: AiUsageService,
    private readonly streams: AiStreamService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** AI_TITLE_GENERATION (default true, P2-D8). Off ⇒ no title job is enqueued and a queued one does nothing. */
  get enabled(): boolean {
    return this.env.get('AI_TITLE_GENERATION') === true;
  }

  /** Graceful Worker shutdown: every in-flight title call is aborted (the fallback title stays). */
  abortAll(): number {
    for (const controller of this.inflight) controller.abort(new Error('ai title aborted: shutdown'));
    return this.inflight.size;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  async run(job: unknown): Promise<AiTitleOutcome> {
    const ids = titleJobIds(job);
    if (!ids || !this.enabled) return 'skipped';
    const ctx: AuthContext = { organisationId: ids.organisationId, workspaceId: ids.workspaceId, userId: ids.userId, role: '' };

    // The conversation (owner predicate under RLS), its first question and the first turn's session — lookups only.
    const [facts] = await this.tenantContext.runInTenantContext(ctx, (m) =>
      m.query<TitleFacts[]>(
        `SELECT c.title_source,
                (SELECT u.content FROM core.ai_message u WHERE u.conversation_id = c.id AND u.role = 'user' ORDER BY u.seq LIMIT 1) AS first,
                (SELECT a.session_id FROM core.ai_message a WHERE a.id = $2 AND a.conversation_id = c.id AND a.role = 'assistant') AS session_id
           FROM core.ai_conversation c WHERE c.id = $1`,
        [ids.conversationId, ids.turnId],
      ),
    );
    if (!facts || facts.title_source !== 'auto' || !facts.first || !facts.session_id) return 'skipped';

    let actor: AiActor;
    try {
      actor = await this.access.rebuildForWorker({ organisationId: ids.organisationId, workspaceId: ids.workspaceId, userId: ids.userId, sessionId: facts.session_id });
      // Titles use the fast tier (AI_MODEL_TIER_FOR_USE.title), resolved by the same resolver as chat; if the two tiers
      // ever differ this refuses instead of calling a model chosen for another use.
      if ((AI_MODEL_TIER_FOR_USE.title as string) !== AI_CHAT_TIER) throw new AiAccessRevokedError(PLATFORM_NOT_READY);
    } catch (error) {
      await this.refused(ctx, ids, error instanceof AiAccessRevokedError ? error.reason : 'unknown', []);
      return 'refused';
    }

    const [pending] = await this.tenantContext.runInTenantContext(ctx, (m) =>
      m.query<Array<{ id: string }>>(`UPDATE core.ai_conversation SET title_source = 'pending', updated_at = now() WHERE id = $1 AND title_source = 'auto' RETURNING id`, [ids.conversationId]),
    );
    if (!pending) return 'skipped';

    let written = false;
    try {
      const outcome = await this.generate(ctx, ids, actor, facts.first);
      written = outcome === 'written';
      return outcome;
    } catch (error) {
      this.logger.warn(`title for conversation ${ids.conversationId} failed internally (${(error as Error)?.name ?? 'Error'})`);
      return 'failed';
    } finally {
      if (!written) {
        await this.tenantContext
          .runInTenantContext(ctx, (m) => m.query(`UPDATE core.ai_conversation SET title_source = 'auto', updated_at = now() WHERE id = $1 AND title_source = 'pending'`, [ids.conversationId]))
          .catch(() => undefined);
      }
    }
  }

  private async generate(ctx: AuthContext, ids: AiTurnIds, actor: AiActor, firstMessage: string): Promise<AiTitleOutcome> {
    const model: AiCatalogueModel = actor.model;
    const real = isRealProvider(model);
    const messages = buildTitleMessages(firstMessage, { maskForProvider: real });
    const day = utcDay();

    // The organisation's daily TOKEN budget, reserved before the call (upper bound of this call) and reconciled after.
    const reservation = maxInputTokensFromBytes(Buffer.byteLength(AI_TITLE_SYSTEM_PROMPT, 'utf8') + Buffer.byteLength(JSON.stringify(messages), 'utf8')) + this.config.maxOutputTokensFor(model);
    try {
      const seed = (await this.quota.budgetKeyExists(ids.organisationId, day)) ? null : await this.tenantContext.runInTenantContext(ctx, (m) => this.usage.dayTokens(m, ids.organisationId, day));
      await this.quota.reserveBudget(ids.organisationId, day, reservation, seed);
    } catch (error) {
      // Budget spent ⇒ no call, the fallback stays; the meter unavailable ⇒ no call either (fail closed).
      return error instanceof AiTooManyRequestsException ? 'skipped' : 'failed';
    }

    const controller = new AbortController();
    this.inflight.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('ai title timeout')), AI_TITLE_TIMEOUT_MS);
    const open: number[] = [];
    let settledMicros = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let text = '';
    let enough = false;
    let failed = false;
    let refusal: AiStepRefusedError | null = null;
    try {
      const result = this.gateway.stream({
        model,
        system: AI_TITLE_SYSTEM_PROMPT,
        messages,
        tools: {},
        abortSignal: controller.signal,
        realProviderPermitted: actor.realProviderPermitted,
        beforeStep: async (info) => {
          // Exactly one model call: with no tools the SDK has no reason for a second step; one would be refused here.
          if (info.stepNumber > 0) {
            controller.abort(new Error('ai title: one step only'));
            throw new AiStepRefusedError('not_ready');
          }
          try {
            await this.access.assertStillAllowed(actor);
          } catch {
            throw new AiStepRefusedError('access_revoked');
          }
          const amount = worstCaseStepUsdMicros(info.model, info.maxInputTokens, info.maxOutputTokens);
          if (amount <= 0) {
            open.push(0);
            return;
          }
          try {
            await this.costMeter.reserve(ids.organisationId, day, amount, () => this.tenantContext.runInTenantContext(ctx, (m) => this.usage.dayCostMicros(m, ids.organisationId, day)));
          } catch (error) {
            throw new AiStepRefusedError(error instanceof AiCostBudgetExhaustedError ? 'budget' : 'meter_unavailable');
          }
          open.push(amount);
        },
        // EX-1 control 6 for a real provider: the organisation is re-verified as synthetic immediately before the request.
        realRequestGuard: async () => {
          const check = await this.access.syntheticCheckForRealRequest(actor);
          if (check !== 'ok') {
            const r = new AiStepRefusedError('content_refused', [check]);
            refusal = r;
            throw r;
          }
        },
        // EX-1 control 7: the unmasked first message is scanned too (a detected item refuses, it is not masked away).
        unmaskedUserTexts: [firstMessage],
        onRefused: (error) => {
          refusal = error;
        },
      });
      try {
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            text += part.text;
            if (text.length >= AI_TITLE_MAX_COLLECTED_CHARS) {
              enough = true;
              controller.abort(new Error('ai title: enough text'));
            }
          } else if (part.type === 'finish-step') {
            inputTokens += part.usage.inputTokens ?? 0;
            outputTokens += part.usage.outputTokens ?? 0;
            const reserved = open.shift() ?? 0;
            const actual = stepCostUsdMicros(model, part.usage);
            settledMicros += actual;
            if (actual !== reserved) await this.costMeter.settle(ids.organisationId, day, actual - reserved).catch(() => undefined);
          } else if (part.type === 'error') {
            failed = true;
          }
        }
      } catch (error) {
        if (error instanceof AiStepRefusedError) refusal ??= error;
        if (!enough) failed = true;
      }
    } finally {
      clearTimeout(timer);
      this.inflight.delete(controller);
      await this.quota.adjustBudget(ids.organisationId, day, inputTokens + outputTokens - reservation);
    }

    const refused = refusal as AiStepRefusedError | null;
    const called = inputTokens + outputTokens > 0 || settledMicros > 0;
    const title = refused || failed ? null : sanitiseTitle(text);
    const tokens = inputTokens + outputTokens;
    const stored = await this.tenantContext.runInTenantContext(ctx, async (m) => {
      if (called) await this.usage.recordTitle(m, ids.organisationId, day, { model: model.id, costUsdMicros: settledMicros, inputTokens, outputTokens });
      if (!title) return false;
      const [row] = await m.query<Array<{ id: string }>>(
        `UPDATE core.ai_conversation SET title = $2, title_source = 'model', updated_at = now() WHERE id = $1 AND title_source = 'pending' RETURNING id`,
        [ids.conversationId, title],
      );
      if (!row) return false;
      await this.audit.record(m, ctx, AuditAction.AI_TITLE_GENERATED, {
        entityType: 'ai_conversation',
        entityId: ids.conversationId,
        metadata: { model: model.id, tokens },
      });
      return true;
    });

    if (refused) {
      if (refused.reason === 'content_refused' || refused.reason === 'access_revoked') {
        await this.refused(ctx, ids, refused.reason, refused.categories);
        return 'refused';
      }
      return refused.reason === 'budget' ? 'skipped' : 'failed';
    }
    if (!stored || !title) return 'failed';
    // Plain text, already sanitised. Only onto a stream that is still open (never re-creates an expired one).
    await this.streams.publishIfOpen(ids.conversationId, ids.turnId, { type: 'title', turnId: ids.turnId, title });
    return 'written';
  }

  /** `ai.turn_refused` for a title (stage `title`): fixed reason / category codes only, never the matched text. */
  private async refused(ctx: AuthContext, ids: AiTurnIds, reason: string, categories: readonly string[]): Promise<void> {
    await this.tenantContext
      .runInTenantContext(ctx, (m) =>
        this.audit.record(m, ctx, AuditAction.AI_TURN_REFUSED, {
          entityType: 'ai_conversation',
          entityId: ids.conversationId,
          metadata: { reason, stage: 'title', ...(categories.length ? { categories: [...categories] } : {}) },
        }),
      )
      .catch(() => undefined);
  }
}
