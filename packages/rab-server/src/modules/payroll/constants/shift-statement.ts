/**
 * Approved Shift Statement pipeline constants, shared by the API (state projection) and the worker (dispatcher,
 * BullMQ consumer). Kept here (no Nest, no Redis import) so both processes read one definition.
 */
export const SHIFT_STATEMENT_QUEUE_NAME = 'rab-shift-statements';
export const SHIFT_STATEMENT_JOB_NAME = 'generate-shift-statement';

/** A failing statement is retried (dispatcher reconciliation) up to this many attempts, then reported `failed`. */
export const SHIFT_STATEMENT_MAX_ATTEMPTS = 5;

/** Minimal BullMQ payload: the worker re-reads every fact from PostgreSQL under the record's own tenant context. */
export interface ShiftStatementJobData {
  payrollRecordId: string;
  organisationId: string;
  workspaceId: string;
  /** statement_dispatch_generation at publish time; a job from an older generation is ignored. */
  generation: number;
}

/** What staff and managers see. Internal outbox states (pending / queued / processing / retrying) are all `processing`. */
export type ShiftStatementState = 'processing' | 'available' | 'failed';

/** Payroll statuses whose approval releases a statement. */
export const STATEMENT_RELEASING_STATUSES = ['approved', 'processing', 'paid'] as const;

export function publicStatementState(payrollStatus: string, rawStatus: string, attempts: number): ShiftStatementState | null {
  if (!(STATEMENT_RELEASING_STATUSES as readonly string[]).includes(payrollStatus)) return null;
  if (rawStatus === 'generated') return 'available';
  if (rawStatus === 'failed' && attempts >= SHIFT_STATEMENT_MAX_ATTEMPTS) return 'failed';
  return 'processing';
}
