import { AI_TOOL_LIMITS } from '@rab/shared';
import { EntityManager } from 'typeorm';

/** Per-statement bound of every `assistant*` read (rule 7.3, P3-D11). Equal to `AI_TOOL_LIMITS.statementTimeoutMs`. */
export const ASSISTANT_STATEMENT_TIMEOUT_MS = AI_TOOL_LIMITS.statementTimeoutMs;

/**
 * The first statements of every assistant read (AI Phase 3, docs/ai/PHASE3_TWENTY_PLAN.md §2.6): the transaction the
 * domain service already opened with `runInWorkspaceContext` (the user's own tenant context, crewflow_app, RLS bound)
 * becomes READ ONLY and every later statement in it is cancelled after 5 s. Both are transaction-scoped (`SET LOCAL` /
 * `SET TRANSACTION`), so a pooled connection never carries them into another request. A cancelled statement throws;
 * the AI tool layer answers the model with the fixed `tool_failed` and the turn continues.
 */
export async function beginAssistantRead(manager: EntityManager): Promise<void> {
  await manager.query(`SET LOCAL statement_timeout = '${Math.trunc(ASSISTANT_STATEMENT_TIMEOUT_MS)}ms'`);
  await manager.query('SET TRANSACTION READ ONLY');
}
