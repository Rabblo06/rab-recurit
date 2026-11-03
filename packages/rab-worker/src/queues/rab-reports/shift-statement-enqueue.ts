import { enqueueRegisteredJob, QueueProducerLike, registeredJob, RegisteredJob } from '@rab/server/engine/worker-shared/queue-enqueue';
import { SHIFT_STATEMENT_QUEUE_NAME } from '@rab/server/engine/worker-shared/shift-statement-queue.constants';
import { SHIFT_STATEMENT_JOB_NAME, ShiftStatementJobData } from '@rab/server/modules/payroll/constants/shift-statement';

/**
 * Phase D-Q1: the ONE builder of a `rab-shift-statements` job, used by BOTH claim modes (per_scope: the report
 * processor's dispatcher adapter; global: dispatch-wiring's statement binding). The declared tenant scope is the claimed
 * `payroll_record` row's own organisation (the dispatcher read it under RLS in the claim transaction — never a client
 * value); the payload is the four identifiers, built field by field; the options (attempts 1, 7 d completed / 30 d failed)
 * come from the queue registry and the jobId keeps its format `shift-statement.<payrollRecordId>.gen.<generation>`.
 * `shift-statement-enqueue.spec.ts` pins it equal to the pre-D-Q1 literal (`shiftStatementJobOptions`).
 */
export function shiftStatementJob(data: ShiftStatementJobData): RegisteredJob<typeof SHIFT_STATEMENT_QUEUE_NAME, ShiftStatementJobData> {
  return registeredJob(
    SHIFT_STATEMENT_QUEUE_NAME,
    SHIFT_STATEMENT_JOB_NAME,
    { kind: 'organisation', organisationId: data.organisationId },
    { payrollRecordId: data.payrollRecordId, organisationId: data.organisationId, workspaceId: data.workspaceId, generation: data.generation },
    { jobId: `shift-statement.${data.payrollRecordId}.gen.${data.generation}` },
  );
}

/** Builds and adds the job (the queue is the Worker's bounded, fail-fast statement producer). */
export async function enqueueShiftStatement(queue: QueueProducerLike<ShiftStatementJobData>, data: ShiftStatementJobData): Promise<void> {
  await enqueueRegisteredJob(queue, shiftStatementJob(data));
}
