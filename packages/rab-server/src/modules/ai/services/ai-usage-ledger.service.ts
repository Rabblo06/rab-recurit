import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AI_MODEL_ID_PATTERN } from '../../../engine/core-modules/ai/models/catalog';
import { AI_AGENT_EXECUTION_APPROVED } from '../contracts/agents';
import { AiUsageLedgerRow } from '../contracts/usage';
import { AiQuotaUnavailableError } from '../exceptions/ai.exceptions';

const KINDS: ReadonlySet<string> = new Set(['chat', 'title', 'agent']);
const OUTCOMES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A ledger row that cannot be written as given (a programming error in the caller, never user input). */
export class AiUsageLedgerRowError extends Error {
  constructor(readonly field: string) {
    super(`ai_usage ledger row refused (${field})`);
    this.name = 'AiUsageLedgerRowError';
  }
}

function count(field: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new AiUsageLedgerRowError(field);
  return value;
}

/**
 * `core.ai_usage` — the per-turn, per-user, INSERT-ONLY usage ledger (PHASE7_TWENTY_PLAN §2.3, C7-2; migration
 * AiUsageLedger in the 7xxx range). One row per terminal turn (`UNIQUE (turn_id)`, deliberately no FK to the turn, so the
 * row outlives the conversation): it seeds the per-user cost meter (deleting a chat never hands budget back) and feeds the
 * Usage view and the per-turn usage popover (C1 CD-6: `contextUsedTokens` = the last step's input tokens,
 * `contextLimitTokens` = the `context-budget.ts` limit). Metadata only — ids, kind, model, step and token counts,
 * estimated cost in integer micro-USD, outcome — never content.
 *
 * Layers: the caller runs inside `runInTenantContext` bound to the TURN'S user (the INSERT policy requires
 * `user_id = core.current_uid()` and the bound organisation; a CEO reads the organisation, everyone else only their own
 * rows; `crewflow_app` holds SELECT + INSERT only — no UPDATE, no DELETE). Called by the runner from 7b, inside the turn's
 * terminal transaction (the compare-and-set UPDATE), so a retried completion writes nothing twice.
 */
@Injectable()
export class AiUsageLedgerService {
  /**
   * Writes the turn's ledger row. Idempotent: a second insert for the same `turnId` is a no-op (`ON CONFLICT (turn_id)
   * DO NOTHING`). Returns true when this call wrote the row. Refuses an `agent` row while EX-3 is not approved.
   */
  async insertTerminal(m: EntityManager, row: AiUsageLedgerRow): Promise<boolean> {
    if (!UUID.test(row.organisationId)) throw new AiUsageLedgerRowError('organisationId');
    if (!UUID.test(row.userId)) throw new AiUsageLedgerRowError('userId');
    if (!UUID.test(row.turnId)) throw new AiUsageLedgerRowError('turnId');
    if (!DAY.test(row.usageDate)) throw new AiUsageLedgerRowError('usageDate');
    if (!KINDS.has(row.kind)) throw new AiUsageLedgerRowError('kind');
    if (row.kind === 'agent' && !AI_AGENT_EXECUTION_APPROVED) throw new AiUsageLedgerRowError('kind');
    if (!AI_MODEL_ID_PATTERN.test(row.model)) throw new AiUsageLedgerRowError('model');
    if (!OUTCOMES.has(row.outcome)) throw new AiUsageLedgerRowError('outcome');
    const tokens = Number.MAX_SAFE_INTEGER;
    const values = [
      row.organisationId,
      row.userId,
      row.turnId,
      row.usageDate,
      row.kind,
      row.model,
      count('steps', row.steps, 32_767),
      String(count('inputTokens', row.inputTokens, tokens)),
      String(count('cachedInputTokens', row.cachedInputTokens, tokens)),
      String(count('cacheWriteTokens', row.cacheWriteTokens, tokens)),
      String(count('outputTokens', row.outputTokens, tokens)),
      String(count('costUsdMicros', row.costUsdMicros, tokens)),
      String(count('contextUsedTokens', row.contextUsedTokens ?? 0, tokens)),
      String(count('contextLimitTokens', row.contextLimitTokens ?? 0, tokens)),
      row.outcome,
    ];
    const inserted = await m.query<Array<{ id: string }>>(
      `INSERT INTO core.ai_usage (organisation_id, user_id, turn_id, usage_date, kind, model, steps, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd_micros, context_used_tokens, context_limit_tokens, outcome)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (turn_id) DO NOTHING
       RETURNING id`,
      values,
    );
    return inserted.length === 1;
  }

  /**
   * The user's persisted estimated cost (integer micro-USD) for `day` — the seed of the per-user Redis meter. Rows survive
   * conversation deletion, so deleting a chat never lowers it. Fail closed: read from any context other than the user's
   * own (or the organisation CEO's), RLS would hide the rows and the seed would read low, so it refuses instead
   * (AiQuotaUnavailableError → the step or submit is refused).
   */
  async userDayCostMicros(m: EntityManager, organisationId: string, userId: string, day: string): Promise<number> {
    if (!UUID.test(organisationId) || !UUID.test(userId) || !DAY.test(day)) throw new AiQuotaUnavailableError();
    const [row] = await m.query<Array<{ visible: boolean | null; cost: string | null }>>(
      `SELECT (core.current_org() = $1::uuid AND (core.current_uid() = $2::uuid OR core.ai_settings_writer())) AS visible,
              (SELECT coalesce(sum(u.cost_usd_micros), 0)::text FROM core.ai_usage u
                WHERE u.organisation_id = $1::uuid AND u.user_id = $2::uuid AND u.usage_date = $3::date) AS cost`,
      [organisationId, userId, day],
    );
    if (row?.visible !== true) throw new AiQuotaUnavailableError();
    const cost = Number(row.cost ?? '0');
    if (!Number.isFinite(cost) || cost < 0) throw new AiQuotaUnavailableError();
    return cost;
  }
}
