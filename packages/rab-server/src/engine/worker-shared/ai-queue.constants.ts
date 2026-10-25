/**
 * AI Phase 1 — the `rab-ai` BullMQ queue (docs/ai/PHASE1_PLAN.md §4.1). Pure constants (no Nest, no Redis, no `modules/`
 * import) so the canonical queue registry, the API producer (`modules/ai`) and the Worker consumer share one spelling.
 *
 * Prefix: the legacy `bull` prefix, exactly like the other API-published consumer queues (rab-email, rab-push) — see
 * queue-registry.ts. It moves with them in any future single-prefix cutover.
 */
export const AI_QUEUE_NAME = 'rab-ai';
export const AI_TURN_JOB_NAME = 'ai-turn';

/**
 * The ONLY payload of an `ai-turn` job: identifiers. Never a prompt, a reply, a record, a role list, a permission or a
 * key. The Worker treats every field as a LOOKUP INPUT: the turn is re-read under RLS bound to these ids (a forged
 * combination matches no row) and the caller's authority is rebuilt from PostgreSQL (session, membership, status,
 * permissions, switches) before anything runs.
 */
export interface AiTurnJobData {
  v: 1;
  turnId: string;
  conversationId: string;
  organisationId: string;
  workspaceId: string;
  userId: string;
}

/** BullMQ custom ids may not contain ':' — `.` separated, one job per turn (a duplicate add is deduplicated). */
export function aiTurnJobId(turnId: string): string {
  return `ai-turn.${turnId}`;
}
