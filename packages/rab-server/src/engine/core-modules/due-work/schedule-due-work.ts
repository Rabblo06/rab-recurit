import { EntityManager } from 'typeorm';

/**
 * Writes or moves a due-work pointer (see the WorkerDueWork migration). Called by business code INSIDE the subject's own transaction, so the
 * pointer commits or rolls back with the business change that made the work due.
 *
 * Discovery only. The pointer carries no authority: the worker re-reads the subject from its own workspace and revalidates it before any
 * side effect. `dueAt` is a scheduling hint; the worker recomputes the real deadline and reschedules the pointer if this one was early.
 *
 * Runs under the caller's tenant context. The table's RLS policy checks organisation and workspace on insert and update, so a caller can
 * only schedule work in the workspace it is bound to. A mismatch fails the write, which fails the business change too (fail closed).
 */
export async function schedulePointer(
  manager: EntityManager,
  pointer: {
    organisationId: string;
    workspaceId: string;
    jobType: 'manager_confirmation_timeout';
    subjectType: 'job_offer';
    subjectId: string;
    dueAt: Date;
  },
): Promise<void> {
  await manager.query(
    `INSERT INTO core.worker_due_work (organisation_id, workspace_id, job_type, subject_type, subject_id, due_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (job_type, subject_type, subject_id)
     DO UPDATE SET due_at = EXCLUDED.due_at, status = 'PENDING', lease_until = NULL, lease_token = NULL, updated_at = now()`,
    [pointer.organisationId, pointer.workspaceId, pointer.jobType, pointer.subjectType, pointer.subjectId, pointer.dueAt],
  );
}
