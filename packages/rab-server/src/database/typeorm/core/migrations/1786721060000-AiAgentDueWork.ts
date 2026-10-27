import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI Phase 6a, M6.4 (docs/ai/PHASE6_TWENTY_PLAN.md §3, §5, conflict C6): the due-work pointer kinds the 6b agent scan will
 * use, on the EXISTING cross-tenant discovery table `core.worker_due_work` (WorkerDueWork1786676800000; ENABLE, NOT FORCE,
 * already on NOT_FORCED_ALLOWLIST — no allowlist change, no new NOT-FORCE table, no second scheduler).
 *
 *  - `worker_due_work_job_type_check`     += 'ai_agent_schedule', 'ai_agent_event'
 *  - `worker_due_work_subject_type_check` += 'ai_agent_trigger'
 *  - NEW `worker_due_work_ai_agent_subject_check`: an `ai_agent_*` job always names an `ai_agent_trigger` subject and the
 *    existing job type only its `job_offer` subject (the pair is fixed, so a pointer can never point the wrong claimer at a
 *    record of another kind).
 *
 * The claim / complete / reschedule SECURITY DEFINER functions are already generic by `job_type` and are not touched.
 * NOTHING writes or claims these job types in 6a: there is no producer (no enable, no recorder) and no consumer (no scan,
 * no processor) until the owner approves EX-3 (Phase 6b). The trigger rows they would point at cannot be enabled
 * (`ai_agent_trigger_ex3_gate`, AiAgentSchema1786721050000).
 *
 * down(): deletes any `ai_agent_%` pointer (none can exist in 6a), then restores the original single-value CHECKs.
 * Not production-approved (N1). Dev number in Agent 6's range; Agent 9 renumbers it at the integration merge.
 */
export class AiAgentDueWork1786721060000 implements MigrationInterface {
  name = 'AiAgentDueWork1786721060000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE core.worker_due_work
        DROP CONSTRAINT worker_due_work_job_type_check,
        DROP CONSTRAINT worker_due_work_subject_type_check,
        ADD CONSTRAINT worker_due_work_job_type_check CHECK (job_type IN ('manager_confirmation_timeout', 'ai_agent_schedule', 'ai_agent_event')),
        ADD CONSTRAINT worker_due_work_subject_type_check CHECK (subject_type IN ('job_offer', 'ai_agent_trigger')),
        ADD CONSTRAINT worker_due_work_ai_agent_subject_check CHECK ((job_type IN ('ai_agent_schedule', 'ai_agent_event')) = (subject_type = 'ai_agent_trigger'));
    `);
    const [check] = (await runner.query(
      `SELECT
         (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'core.worker_due_work'::regclass AND conname = 'worker_due_work_job_type_check') AS job_type,
         (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'core.worker_due_work'::regclass AND conname = 'worker_due_work_subject_type_check') AS subject_type,
         (SELECT count(*) FROM pg_constraint WHERE conrelid = 'core.worker_due_work'::regclass AND conname = 'worker_due_work_ai_agent_subject_check' AND convalidated)::int AS pair,
         (SELECT c.relrowsecurity AND NOT c.relforcerowsecurity FROM pg_class c WHERE c.oid = 'core.worker_due_work'::regclass) AS rls_unchanged`,
    )) as Array<{ job_type: string | null; subject_type: string | null; pair: number; rls_unchanged: boolean }>;
    const has = (def: string | null, values: string[]) => typeof def === 'string' && values.every((v) => def.includes(`'${v}'`));
    if (
      !has(check.job_type, ['manager_confirmation_timeout', 'ai_agent_schedule', 'ai_agent_event']) ||
      !has(check.subject_type, ['job_offer', 'ai_agent_trigger']) ||
      check.pair !== 1 ||
      check.rls_unchanged !== true
    ) {
      throw new Error(`${this.name}: post-condition failed ${JSON.stringify(check)}`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DELETE FROM core.worker_due_work WHERE job_type LIKE 'ai\\_agent\\_%' OR subject_type = 'ai_agent_trigger';`);
    await runner.query(`
      ALTER TABLE core.worker_due_work
        DROP CONSTRAINT IF EXISTS worker_due_work_ai_agent_subject_check,
        DROP CONSTRAINT worker_due_work_job_type_check,
        DROP CONSTRAINT worker_due_work_subject_type_check,
        ADD CONSTRAINT worker_due_work_job_type_check CHECK (job_type = 'manager_confirmation_timeout'),
        ADD CONSTRAINT worker_due_work_subject_type_check CHECK (subject_type = 'job_offer');
    `);
  }
}
