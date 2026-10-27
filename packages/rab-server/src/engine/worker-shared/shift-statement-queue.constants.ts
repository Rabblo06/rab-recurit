/**
 * The `rab-shift-statements` BullMQ queue and job names (Approved Shift Statement pipeline). Moved here from
 * `modules/payroll/constants/shift-statement.ts` (which re-exports them unchanged) so `engine/` — the canonical queue
 * registry in `worker-shared/queue-registry.ts` and the Admin Panel's queue view — can name the queue without ever
 * importing from `modules/` (CLAUDE.md: the dependency only flows modules → engine). Values are unchanged.
 */
export const SHIFT_STATEMENT_QUEUE_NAME = 'rab-shift-statements';
export const SHIFT_STATEMENT_JOB_NAME = 'generate-shift-statement';
