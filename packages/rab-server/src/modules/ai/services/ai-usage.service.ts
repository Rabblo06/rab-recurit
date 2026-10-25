import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

export interface AiTurnUsageRecord {
  inputTokens: number;
  outputTokens: number;
  outcome: 'completed' | 'failed' | 'cancelled';
  toolCalls: number;
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
}

/**
 * `core.ai_usage_daily` — per-organisation, per-UTC-day counters (metadata only). Written in the SAME transaction as a
 * turn's terminal transition (exactly once per turn: that UPDATE is a compare-and-set), so a retried completion can
 * never double-count. Read as the seed of the Redis budget counter and by the admin summary.
 */
@Injectable()
export class AiUsageService {
  async recordTurn(m: EntityManager, organisationId: string, day: string, usage: AiTurnUsageRecord): Promise<void> {
    await m.query(
      `INSERT INTO core.ai_usage_daily (organisation_id, usage_date, input_tokens, output_tokens, turns, failed_turns, cancelled_turns, tool_calls)
       VALUES ($1, $2::date, $3, $4, 1, $5, $6, $7)
       ON CONFLICT (organisation_id, usage_date) DO UPDATE SET
         input_tokens = core.ai_usage_daily.input_tokens + EXCLUDED.input_tokens,
         output_tokens = core.ai_usage_daily.output_tokens + EXCLUDED.output_tokens,
         turns = core.ai_usage_daily.turns + 1,
         failed_turns = core.ai_usage_daily.failed_turns + EXCLUDED.failed_turns,
         cancelled_turns = core.ai_usage_daily.cancelled_turns + EXCLUDED.cancelled_turns,
         tool_calls = core.ai_usage_daily.tool_calls + EXCLUDED.tool_calls,
         updated_at = now()`,
      [
        organisationId,
        day,
        Math.max(0, Math.trunc(usage.inputTokens)),
        Math.max(0, Math.trunc(usage.outputTokens)),
        usage.outcome === 'failed' ? 1 : 0,
        usage.outcome === 'cancelled' ? 1 : 0,
        Math.max(0, Math.trunc(usage.toolCalls)),
      ],
    );
  }

  /** Tokens (input + output) persisted for the organisation's day, or 0. */
  async dayTokens(m: EntityManager, organisationId: string, day: string): Promise<number> {
    const [row] = await m.query<Array<{ tokens: string | null }>>(
      `SELECT (input_tokens + output_tokens)::text AS tokens FROM core.ai_usage_daily WHERE organisation_id = $1 AND usage_date = $2::date`,
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
    }));
  }
}
