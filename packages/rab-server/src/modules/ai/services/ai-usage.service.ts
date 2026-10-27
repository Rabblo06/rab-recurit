import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

export interface AiTurnUsageRecord {
  /** Catalogue id of the model the turn ran on (part of the row key since AiDevRealProvider1786720230000). */
  model: string;
  /** Settled estimated cost of the turn in integer micro-USD (0 for the mock). Never money/pence. */
  costUsdMicros: number;
  inputTokens: number;
  outputTokens: number;
  outcome: 'completed' | 'failed' | 'cancelled';
  toolCalls: number;
  /** 7b: the cache-read and cache-write input tokens (subsets of `inputTokens`, M7-1 columns). Absent ⇒ 0. */
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

export interface AiAdminUsageRow {
  organisationId: string;
  organisationName: string;
  aiEnabled: boolean;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  failedTurns: number;
  cancelledTurns: number;
  toolCalls: number;
  /** 7b (M7-1 summary columns): estimated cost in integer micro-USD and the cache split of `inputTokens`. */
  costUsdMicros: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** 7b: today's raised budget alerts for the organisation (Redis flags only; empty when unreadable). */
  budgetAlerts?: Array<'cost' | 'tokens'>;
}

/**
 * `core.ai_usage_daily` — per-organisation, per-UTC-day, per-model counters and estimated cost (metadata only). Written in the SAME transaction as a
 * turn's terminal transition (exactly once per turn: that UPDATE is a compare-and-set), so a retried completion can
 * never double-count. Read as the seed of the Redis budget counter and by the admin summary.
 */
@Injectable()
export class AiUsageService {
  async recordTurn(m: EntityManager, organisationId: string, day: string, usage: AiTurnUsageRecord): Promise<void> {
    await m.query(
      `INSERT INTO core.ai_usage_daily (organisation_id, usage_date, model, input_tokens, output_tokens, turns, failed_turns, cancelled_turns, tool_calls, cost_usd_micros, cached_input_tokens, cache_write_tokens)
       VALUES ($1, $2::date, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (organisation_id, usage_date, model) DO UPDATE SET
         input_tokens = core.ai_usage_daily.input_tokens + EXCLUDED.input_tokens,
         cached_input_tokens = core.ai_usage_daily.cached_input_tokens + EXCLUDED.cached_input_tokens,
         cache_write_tokens = core.ai_usage_daily.cache_write_tokens + EXCLUDED.cache_write_tokens,
         output_tokens = core.ai_usage_daily.output_tokens + EXCLUDED.output_tokens,
         turns = core.ai_usage_daily.turns + 1,
         failed_turns = core.ai_usage_daily.failed_turns + EXCLUDED.failed_turns,
         cancelled_turns = core.ai_usage_daily.cancelled_turns + EXCLUDED.cancelled_turns,
         tool_calls = core.ai_usage_daily.tool_calls + EXCLUDED.tool_calls,
         cost_usd_micros = core.ai_usage_daily.cost_usd_micros + EXCLUDED.cost_usd_micros,
         updated_at = now()`,
      [
        organisationId,
        day,
        usage.model,
        Math.max(0, Math.trunc(usage.inputTokens)),
        Math.max(0, Math.trunc(usage.outputTokens)),
        usage.outcome === 'failed' ? 1 : 0,
        usage.outcome === 'cancelled' ? 1 : 0,
        Math.max(0, Math.trunc(usage.toolCalls)),
        String(Math.max(0, Math.ceil(usage.costUsdMicros))),
        String(Math.max(0, Math.trunc(usage.cachedInputTokens ?? 0))),
        String(Math.max(0, Math.trunc(usage.cacheWriteTokens ?? 0))),
      ],
    );
  }

  /**
   * Phase 2 titles (P2-C9): one billed title call into the SAME per-model row — tokens and estimated cost add up with
   * the turns (so the budget seed and the admin summary include it), `title_calls += 1`, `turns` unchanged
   * (AiUsageTitleCalls1786720980000). Called in the tenant transaction that settles the title.
   */
  async recordTitle(m: EntityManager, organisationId: string, day: string, usage: Pick<AiTurnUsageRecord, 'model' | 'costUsdMicros' | 'inputTokens' | 'outputTokens'>): Promise<void> {
    await m.query(
      `INSERT INTO core.ai_usage_daily (organisation_id, usage_date, model, input_tokens, output_tokens, title_calls, cost_usd_micros)
       VALUES ($1, $2::date, $3, $4, $5, 1, $6)
       ON CONFLICT (organisation_id, usage_date, model) DO UPDATE SET
         input_tokens = core.ai_usage_daily.input_tokens + EXCLUDED.input_tokens,
         output_tokens = core.ai_usage_daily.output_tokens + EXCLUDED.output_tokens,
         title_calls = core.ai_usage_daily.title_calls + 1,
         cost_usd_micros = core.ai_usage_daily.cost_usd_micros + EXCLUDED.cost_usd_micros,
         updated_at = now()`,
      [organisationId, day, usage.model, Math.max(0, Math.trunc(usage.inputTokens)), Math.max(0, Math.trunc(usage.outputTokens)), String(Math.max(0, Math.ceil(usage.costUsdMicros)))],
    );
  }

  /** Estimated cost (micro-USD) persisted for the organisation's day across every model, or 0. Seeds the cost meter. */
  async dayCostMicros(m: EntityManager, organisationId: string, day: string): Promise<number> {
    const [row] = await m.query<Array<{ cost: string | null }>>(
      `SELECT coalesce(sum(cost_usd_micros), 0)::text AS cost FROM core.ai_usage_daily WHERE organisation_id = $1 AND usage_date = $2::date`,
      [organisationId, day],
    );
    return row?.cost ? Number(row.cost) : 0;
  }

  /** Tokens (input + output) persisted for the organisation's day, or 0. */
  async dayTokens(m: EntityManager, organisationId: string, day: string): Promise<number> {
    const [row] = await m.query<Array<{ tokens: string | null }>>(
      `SELECT coalesce(sum(input_tokens + output_tokens), 0)::text AS tokens FROM core.ai_usage_daily WHERE organisation_id = $1 AND usage_date = $2::date`,
      [organisationId, day],
    );
    return row?.tokens ? Number(row.tokens) : 0;
  }

  /** Platform-admin usage metadata across organisations (`core.ai_admin_usage_summary`, 42501 for anyone else). */
  async adminSummary(m: EntityManager, from: string, to: string, limit: number): Promise<AiAdminUsageRow[]> {
    const rows = await m.query<Array<Record<string, unknown>>>(`SELECT * FROM core.ai_admin_usage_summary($1::date, $2::date, $3)`, [from, to, limit]);
    return rows.map((r) => ({
      organisationId: r.organisationId as string,
      organisationName: r.organisationName as string,
      aiEnabled: r.aiEnabled === true,
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      turns: Number(r.turns),
      failedTurns: Number(r.failedTurns),
      cancelledTurns: Number(r.cancelledTurns),
      toolCalls: Number(r.toolCalls),
      costUsdMicros: Number(r.costUsdMicros ?? 0),
      cachedInputTokens: Number(r.cachedInputTokens ?? 0),
      cacheWriteTokens: Number(r.cacheWriteTokens ?? 0),
    }));
  }
}
