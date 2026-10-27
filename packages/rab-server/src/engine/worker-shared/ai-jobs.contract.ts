/**
 * AI contracts C0 — `rab-ai` JOB DATA v2 (docs/ai/AI_CONTRACTS.md §2.2). Types and fixed names only: no behaviour.
 *
 * Lives in engine/ (next to ai-queue.constants.ts) because both the API producer (`modules/ai`) and the Worker consumer
 * need it and engine/ never imports modules/. The Phase 1 `AiTurnJobData` (v1) in ./ai-queue.constants.ts stays valid:
 * a v1 job still in Redis at deploy is treated as `{ v: 2, kind: 'turn' }` by the Worker.
 *
 * Job data is IDENTIFIERS ONLY (rule 9.3): never a prompt, a reply, a record, a role list, a permission, a key or a
 * skill's content. The Worker treats every field as a LOOKUP INPUT: the row is re-read under RLS bound to these ids (a
 * forged combination matches no row) and authority is rebuilt from PostgreSQL before anything runs. The Worker refuses a
 * job whose `kind` does not match its BullMQ job name (`AI_JOB_NAME_FOR_KIND`).
 */
import type { AiTurnContinuationCause } from '@rab/shared';

/** Job names on the one `rab-ai` queue (P2-D2: no new queue). `ai-turn` is AI_TURN_JOB_NAME in ./ai-queue.constants.ts. */
export const AI_TITLE_JOB_NAME = 'ai-title' as const;
/** Phase 6b only. Nothing may enqueue it before the owner approves EX-3. */
export const AI_AGENT_RUN_JOB_NAME = 'ai-agent-run' as const;

interface AiJobIds {
  organisationId: string;
  workspaceId: string;
  /** The turn's owner. For an agent run: the run-as user (re-validated against the trigger, never trusted). */
  userId: string;
  conversationId: string;
}

/** An interactive chat turn (Phase 1 `AiTurnJobData` + version and kind). */
export interface AiTurnJobDataV2 extends AiJobIds {
  v: 2;
  kind: 'turn';
  turnId: string;
}

/**
 * Phase 5b: the continuation turn after a person decided a proposal or answered a question/form. `turnId` is the NEW
 * assistant turn; `pausedTurnId` the `waiting_for_input` one; `refId` the proposal id or input-request id. The
 * continuation's history carries only the server-written tool result (never a note body).
 */
export interface AiResumeJobData extends AiJobIds {
  v: 2;
  kind: 'resume';
  turnId: string;
  pausedTurnId: string;
  cause: AiTurnContinuationCause;
  refId: string;
}

/** Phase 2 titles (job id `ai-title.<conversationId>`, so at most one). `turnId` = the first turn, for the `title` event. */
export interface AiTitleJobData extends AiJobIds {
  v: 2;
  kind: 'title';
  turnId: string;
}

/** Phase 6b only (EX-3). `triggerId` null = a manual run by the signed-in caller. */
export interface AiAgentRunJobData extends AiJobIds {
  v: 2;
  kind: 'agent-run';
  turnId: string;
  agentId: string;
  triggerId: string | null;
}

export type AiJobDataV2 = AiTurnJobDataV2 | AiResumeJobData | AiTitleJobData | AiAgentRunJobData;
export type AiJobKind = AiJobDataV2['kind'];

/** The only valid (kind → BullMQ job name) pairs. */
export const AI_JOB_NAME_FOR_KIND = {
  turn: 'ai-turn',
  resume: 'ai-turn',
  title: AI_TITLE_JOB_NAME,
  'agent-run': AI_AGENT_RUN_JOB_NAME,
} as const satisfies Record<AiJobKind, string>;
