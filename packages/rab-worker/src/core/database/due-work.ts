import { DataSource } from 'typeorm';

/**
 * Worker client for the due-work pointer (see the WorkerDueWork migration). Runs on the runtime crewflow DataSource and reaches the table only
 * through three SECURITY DEFINER functions. A pointer is a discovery hint. Before any side effect the caller must re-read the subject in its
 * own workspace (WorkspaceExecutionContext) and revalidate it. Nothing here grants access to business rows.
 */

export type JobType = 'manager_confirmation_timeout';

export interface ClaimedPointer {
  pointer_id: string;
  organisation_id: string;
  workspace_id: string;
  subject_id: string;
  lease_token: string;
  attempt_count: number;
}

/**
 * Claims up to `batch` pointers that are due, or whose lease has expired. Two workers never receive the same pointer (SKIP LOCKED inside
 * the function). Each claim gets a fresh lease token, so a worker that lost its lease cannot complete or reschedule the pointer afterwards.
 */
export async function claimDueWork(
  runtime: DataSource,
  jobType: JobType,
  options: { batch: number; leaseSeconds: number },
): Promise<ClaimedPointer[]> {
  return runtime.query<ClaimedPointer[]>(`SELECT * FROM core.worker_claim_due_work($1, $2, $3)`, [jobType, options.batch, options.leaseSeconds]);
}

/** Deletes the pointer, only if the caller still holds its lease. Returns false for a stale holder. */
export async function completeDueWork(runtime: DataSource, pointerId: string, leaseToken: string): Promise<boolean> {
  const [row] = await runtime.query<Array<{ worker_complete_due_work: boolean }>>(`SELECT core.worker_complete_due_work($1, $2) AS worker_complete_due_work`, [
    pointerId,
    leaseToken,
  ]);
  return row?.worker_complete_due_work === true;
}

/** Releases the lease and sets the next due time, only for the lease holder. Returns false for a stale holder. */
export async function rescheduleDueWork(runtime: DataSource, pointerId: string, leaseToken: string, dueAt: Date): Promise<boolean> {
  const [row] = await runtime.query<Array<{ worker_reschedule_due_work: boolean }>>(
    `SELECT core.worker_reschedule_due_work($1, $2, $3) AS worker_reschedule_due_work`,
    [pointerId, leaseToken, dueAt],
  );
  return row?.worker_reschedule_due_work === true;
}
