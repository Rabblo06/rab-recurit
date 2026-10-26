import type { AiProposalFieldType, PermissionFlagType } from '@rab/shared';
import type { EntityManager } from 'typeorm';

import type { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import type { AiWriteToolDefinition } from '../contracts/actions';

/** The C0 contract (modules/ai/contracts/actions.ts), re-exported — never forked. */
export type { AiPrepared, AiWriteToolDefinition } from '../contracts/actions';

/** How a card renders one editable argument (`AiProposalFieldView` without the value). Fixed server text. */
export interface AiWriteToolFieldSpec {
  key: string;
  label: string;
  type: AiProposalFieldType;
  min?: number;
  max?: number;
  maxLength?: number;
}

/**
 * The server-side registration of one write tool: the C0 `AiWriteToolDefinition` (prepare + apply, NO run) plus two
 * things the proposal service and executor need and the contract does not carry (listed in REQUEST.md as a proposed
 * contract addition):
 *  - `fields`: how each editable argument is shown on the card;
 *  - `lockAndHash`: inside the executor's transaction, lock the snapshot rows (`FOR UPDATE` for the row the write
 *    changes, `FOR SHARE` for rows it only depends on) and return the SAME hash `prepare()` computed from them, so a
 *    change between proposal and approval is detected under the lock (stale → 409, nothing written).
 * `apply` is called ONLY by `AiProposalExecutorService` (static test T5-C1).
 */
export interface AiWriteTool<I extends Record<string, unknown> = Record<string, unknown>> extends AiWriteToolDefinition<I> {
  fields: readonly AiWriteToolFieldSpec[];
  lockAndHash(m: EntityManager, ctx: AuthContext, input: I): Promise<string>;
  /**
   * S6 (Batch 3): the target record's current values of the card fields, for the before → after diff — ONLY when the
   * record still hashes to `snapshotHash` (so they ARE the values the proposal was made against). Read-only, no lock,
   * under the viewer's RLS and the domain's own ownership / state checks; null when there is nothing to compare, the
   * record cannot be read by this viewer, or it changed. The caller checks the viewer's flags first. Never throws on a
   * domain refusal (null instead). A tool that creates a new record (or a note) has nothing to compare and omits it.
   */
  previousValues?(m: EntityManager, ctx: AuthContext, input: I, snapshotHash: string): Promise<Record<string, string | number | null> | null>;
  /** S6: the flags a viewer must hold, besides `permission`, to see `previousValues` (e.g. reading the record). */
  previousValuesPermissions?: readonly PermissionFlagType[];
}

/**
 * Keys no proposal argument object may carry (mirrors the CHECK in AiActionProposalActivate1786720960000). The strict
 * zod schemas already refuse them; this list is the boot check and the second line before the INSERT.
 */
export const AI_FORBIDDEN_ARGUMENT_KEYS: readonly string[] = [
  'organisationId',
  'organisation_id',
  'workspaceId',
  'workspace_id',
  'userId',
  'user_id',
  'status',
  'payRatePence',
  'pay_rate_pence',
  'chargeRatePence',
  'charge_rate_pence',
];
