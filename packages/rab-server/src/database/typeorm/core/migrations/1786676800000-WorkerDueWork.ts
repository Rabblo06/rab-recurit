import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Due-work pointer foundation (HWS Phase 3, approved).
 *
 * A pointer tells a timer job WHICH workspace may have work due, so the job stops enumerating every workspace each tick. It is DISCOVERY
 * ONLY: never tenancy authority and never business authority. Before any side effect the worker re-reads the subject from its own
 * workspace (WorkspaceExecutionContext) and revalidates it. A pointer that is stale, or whose subject was cancelled or changed, is discarded
 * or rescheduled with no side effect. Side-effect idempotency stays with core.worker_event; this table does not replace it.
 *
 * Lifecycle:  PENDING (due_at) --claim--> PROCESSING (lease_until, lease_token) --complete--> row deleted
 *                                                                              --reschedule--> PENDING (new due_at)
 * A worker that crashes leaves PROCESSING with an expired lease, which the claim treats as claimable again. A PROCESSING row never strands
 * work.
 *
 * Access:
 *  - Writers (business code, under the subject's tenant context, as rab_app): INSERT/UPDATE, constrained by RLS to the bound organisation
 *    and workspace.
 *  - Discovery (worker, as rab_app): only through the three SECURITY DEFINER functions below. They return routing ids and a lease token,
 *    never business data. Each is owned by rab_owner, has a fixed search_path, revokes PUBLIC EXECUTE and grants EXECUTE to rab_app only.
 *
 * SECURITY TRADE-OFF (owner review): the table is ENABLE but NOT FORCE. Discovery must see due work across every tenant, and a FORCE policy
 * would also hide rows from the definer functions (they run as the table owner). rab_app is not the owner, so the policy binds it fully.
 * Recorded in tools/check-rls-coverage.ts. The alternative (per-tenant discovery) is the scan this table exists to remove.
 */
export class WorkerDueWork1786676800000 implements MigrationInterface {
  name = 'WorkerDueWork1786676800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.worker_due_work (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id      uuid NOT NULL REFERENCES core.manager_workspace(id) ON DELETE CASCADE,
        job_type          text NOT NULL CHECK (job_type IN ('manager_confirmation_timeout')),
        subject_type      text NOT NULL CHECK (subject_type IN ('job_offer')),
        subject_id        uuid NOT NULL,
        due_at            timestamptz NOT NULL,
        status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING')),
        lease_until       timestamptz,
        lease_token       uuid,
        attempt_count     integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT worker_due_work_subject_key UNIQUE (job_type, subject_type, subject_id),
        CONSTRAINT worker_due_work_lease_ck CHECK (
          (status = 'PENDING' AND lease_until IS NULL AND lease_token IS NULL)
          OR (status = 'PROCESSING' AND lease_until IS NOT NULL AND lease_token IS NOT NULL)
        )
      );
    `);
    // Due-work lookup: only PENDING rows, ordered by due time, so a claim reads a bounded index range and never the whole table.
    await queryRunner.query(`CREATE INDEX worker_due_work_pending_due ON core.worker_due_work (job_type, due_at) WHERE status = 'PENDING';`);
    // Expired-lease lookup: only PROCESSING rows, so a crashed claim is found without scanning the table.
    await queryRunner.query(`CREATE INDEX worker_due_work_lease ON core.worker_due_work (job_type, lease_until) WHERE status = 'PROCESSING';`);

    await queryRunner.query(`ALTER TABLE core.worker_due_work ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY worker_due_work_tenant ON core.worker_due_work
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace())
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`REVOKE ALL ON core.worker_due_work FROM PUBLIC;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.worker_due_work TO rab_app;`);

    // Claim: take up to p_batch due (or lease-expired) pointers. FOR UPDATE SKIP LOCKED: two claimers never get the same row.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.worker_claim_due_work(p_job_type text, p_batch integer, p_lease_seconds integer)
      RETURNS TABLE (pointer_id uuid, organisation_id uuid, workspace_id uuid, subject_id uuid, lease_token uuid, attempt_count integer)
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $function$
        WITH picked AS (
          SELECT w.id FROM core.worker_due_work w
           WHERE w.job_type = p_job_type
             AND ((w.status = 'PENDING' AND w.due_at <= now()) OR (w.status = 'PROCESSING' AND w.lease_until < now()))
           ORDER BY w.due_at ASC
           LIMIT LEAST(GREATEST(COALESCE(p_batch, 50), 1), 500)
           FOR UPDATE SKIP LOCKED
        )
        UPDATE core.worker_due_work w
           SET status = 'PROCESSING',
               lease_until = now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 120), 5), 900)),
               lease_token = gen_random_uuid(),
               attempt_count = w.attempt_count + 1,
               updated_at = now()
          FROM picked
         WHERE w.id = picked.id
        RETURNING w.id, w.organisation_id, w.workspace_id, w.subject_id, w.lease_token, w.attempt_count
      $function$;
    `);
    // Complete: delete the pointer, only if this caller still holds the lease. A stale holder (lease expired and reclaimed) gets false.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.worker_complete_due_work(p_id uuid, p_lease_token uuid)
      RETURNS boolean
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $function$
        WITH d AS (
          DELETE FROM core.worker_due_work w
           WHERE w.id = p_id AND w.status = 'PROCESSING' AND w.lease_token = p_lease_token
          RETURNING 1
        )
        SELECT EXISTS (SELECT 1 FROM d)
      $function$;
    `);
    // Reschedule: release the lease and set the next due time, only for the lease holder.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.worker_reschedule_due_work(p_id uuid, p_lease_token uuid, p_due_at timestamptz)
      RETURNS boolean
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $function$
        WITH u AS (
          UPDATE core.worker_due_work w
             SET status = 'PENDING', due_at = p_due_at, lease_until = NULL, lease_token = NULL, updated_at = now()
           WHERE w.id = p_id AND w.status = 'PROCESSING' AND w.lease_token = p_lease_token
          RETURNING 1
        )
        SELECT EXISTS (SELECT 1 FROM u)
      $function$;
    `);
    for (const fn of [
      'core.worker_claim_due_work(text, integer, integer)',
      'core.worker_complete_due_work(uuid, uuid)',
      'core.worker_reschedule_due_work(uuid, uuid, timestamptz)',
    ]) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${fn} TO rab_app;`);
    }

    // Backfill: every offer already waiting for manager confirmation gets a pointer. Due immediately: the worker's revalidation reschedules
    // it to the real deadline (staff_accepted_at + timeout) if that has not passed. Done per workspace, under that workspace's own context,
    // because job_offer is FORCE RLS and the owner sees nothing without one.
    await queryRunner.query(`
      DO $backfill$
      DECLARE ws record;
      BEGIN
        FOR ws IN SELECT id, organisation_id FROM core.manager_workspace LOOP
          PERFORM set_config('rab.organisation_id', ws.organisation_id::text, true),
                  set_config('rab.workspace_id', ws.id::text, true);
          INSERT INTO core.worker_due_work (organisation_id, workspace_id, job_type, subject_type, subject_id, due_at)
          SELECT o.organisation_id, o.workspace_id, 'manager_confirmation_timeout', 'job_offer', o.id, o.staff_accepted_at
            FROM core.job_offer o
           WHERE o.workspace_id = ws.id AND o.status = 'staff_accepted' AND o.staff_accepted_at IS NOT NULL
          ON CONFLICT (job_type, subject_type, subject_id) DO NOTHING;
        END LOOP;
      END
      $backfill$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.worker_reschedule_due_work(uuid, uuid, timestamptz);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.worker_complete_due_work(uuid, uuid);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.worker_claim_due_work(text, integer, integer);`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.worker_due_work;`);
  }
}
