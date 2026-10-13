import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.9 gap review, item 2 (owner-approved, corrected design) — a genuinely terminal,
 * non-retryable workspace-schema status for a workspace whose owning Initial Manager invitation
 * has been replaced. `core.manager_workspace` is owned by `rab_secure_owner` (confirmed this
 * session, same as `core.organisation`/`core.user`) — this migration MUST run via the `rab`
 * superuser connection (`DATABASE_URL_UNPOOLED=postgres://rab:rab@...`), not the ordinary
 * `crewflow` migration role, same requirement as `ManagerWorkspacePlatformAdminRls1786712000000`.
 *
 * Why `FAILED` alone is not enough (proven, not assumed, by reading the actual provisioner and
 * worker-discovery code):
 *  - `core.worker_list_pending_workspace_schemas` (the Worker's own discovery query) selects
 *    `schema_status IN ('CREATING', 'FAILED')` — a FAILED workspace is explicitly retryable BY
 *    DESIGN, so marking a superseded workspace merely FAILED would let a later Worker poll pick
 *    it back up and actually provision a real schema for an identity nobody can ever activate.
 *  - Worse: `core.mark_workspace_schema_failed`'s only existing refusal is `v_status = 'READY'`.
 *    If a Worker's apply transaction is already in flight when we mark SUPERSEDED (its own lock
 *    is on `workspace_schema_registry`, a different row — the two don't contend), its own
 *    `mark_workspace_schema_ready` call later fails closed (good, its allow-list already excludes
 *    anything but CREATING/FAILED) — but its failure handler then calls `mark_workspace_schema_
 *    failed`, which WOULD overwrite our SUPERSEDED marker back to FAILED, silently re-opening it
 *    to a future retry. This migration closes exactly that gap.
 *
 * The fix adds exactly one new terminal value and lets the EXISTING allow-list-shaped guards in
 * `begin_workspace_schema_attempt`/`mark_workspace_schema_ready` do the rest for free — neither is
 * modified, because neither ever allowed anything but CREATING/FAILED as a starting/target state,
 * so SUPERSEDED is automatically excluded by construction. Only `mark_workspace_schema_failed`
 * needs one extra condition in its own refusal guard, to stop it from undoing a supersede.
 */
export class WorkspaceSchemaSupersededStatus1786714000000 implements MigrationInterface {
  name = 'WorkspaceSchemaSupersededStatus1786714000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.manager_workspace
        DROP CONSTRAINT manager_workspace_schema_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE core.manager_workspace
        ADD CONSTRAINT manager_workspace_schema_status_check
          CHECK (schema_status IS NULL OR schema_status IN ('CREATING', 'READY', 'MIGRATING', 'FAILED', 'SUPERSEDED'));
    `);

    // Narrower than mark_workspace_schema_failed's own allow-list on purpose: an ALLOW-list
    // (only CREATING or FAILED may become SUPERSEDED), not a deny-list — READY, MIGRATING, an
    // already-NULL legacy row, and any future status are all refused, exactly as the owner
    // required ("reject READY, MIGRATING and any other state that is not legitimately
    // replaceable"). Idempotent: calling it twice on an already-SUPERSEDED workspace is a
    // harmless no-op success (needed for a safely-retried replace request), never an error.
    // Handles an absent registry row the same way mark_workspace_schema_failed already does
    // (its own UPDATE simply matches zero rows — no IF NOT FOUND check needed there).
    await queryRunner.query(`
      CREATE FUNCTION core.mark_workspace_schema_superseded(p_workspace_id uuid, p_safe_reason text)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'pg_catalog', 'pg_temp'
      AS $function$
      DECLARE
        v_org    uuid;
        v_status text;
        v_error  text;
        v_prev   text;
      BEGIN
        SELECT w.organisation_id, w.schema_status INTO v_org, v_status
          FROM core.manager_workspace w WHERE w.id = p_workspace_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_status = 'SUPERSEDED' THEN
          RETURN;
        END IF;
        IF v_status IS DISTINCT FROM 'CREATING' AND v_status IS DISTINCT FROM 'FAILED' THEN
          RAISE EXCEPTION 'workspace schema is %, it cannot be superseded', coalesce(v_status, 'NULL') USING ERRCODE = '55000';
        END IF;
        v_error := left(coalesce(p_safe_reason, 'superseded'), 500);
        v_prev := current_setting('rab.organisation_id', true);
        PERFORM set_config('rab.organisation_id', v_org::text, true);
        -- Registry may not exist yet when this runs before registration (dev environments where
        -- the Worker never ran, or a replacement made before the Worker's first poll) — same
        -- "may not exist" handling mark_workspace_schema_failed already uses; this UPDATE simply
        -- matches zero rows in that case.
        UPDATE core.workspace_schema_registry
           SET status = 'FAILED', migration_error = v_error
         WHERE workspace_id = p_workspace_id AND status IN ('PROVISIONING', 'FAILED');
        UPDATE core.manager_workspace
           SET schema_status = 'SUPERSEDED', schema_last_error = v_error
         WHERE id = p_workspace_id;
        PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
      END;
      $function$
    `);

    // The one guard addition: mark_workspace_schema_failed must never undo a supersede. Every
    // other behaviour (READY refusal, registry-may-not-exist handling, idempotent FAILED->FAILED)
    // is unchanged — copied verbatim from WorkspaceSchemaLifecycleGate1786677000000's current body.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.mark_workspace_schema_failed(p_workspace_id uuid, p_safe_error text)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'pg_catalog', 'pg_temp'
      AS $function$
      DECLARE
        v_org    uuid;
        v_status text;
        v_error  text;
        v_prev   text;
      BEGIN
        SELECT w.organisation_id, w.schema_status INTO v_org, v_status
          FROM core.manager_workspace w WHERE w.id = p_workspace_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_status = 'READY' THEN
          RAISE EXCEPTION 'a READY workspace schema cannot be marked failed' USING ERRCODE = '55000';
        END IF;
        IF v_status = 'SUPERSEDED' THEN
          RAISE EXCEPTION 'a SUPERSEDED workspace schema cannot be marked failed' USING ERRCODE = '55000';
        END IF;
        v_error := left(coalesce(p_safe_error, 'provisioning failed'), 500);
        v_prev := current_setting('rab.organisation_id', true);
        PERFORM set_config('rab.organisation_id', v_org::text, true);
        UPDATE core.workspace_schema_registry
           SET status = 'FAILED', migration_error = v_error
         WHERE workspace_id = p_workspace_id AND status IN ('PROVISIONING', 'FAILED');
        UPDATE core.manager_workspace
           SET schema_status = 'FAILED', schema_last_error = v_error
         WHERE id = p_workspace_id;
        PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
      END;
      $function$
    `);

    // This is the FIRST time the ordinary runtime connection gets any workspace-schema-lifecycle
    // mutation capability (every sibling function above is provisioner-only: crewflow +
    // rab_secure_owner, confirmed by live grant inspection this session — crewflow_app had none).
    // Deliberately narrow: this function can only ever move a workspace to a STRICTLY MORE
    // restrictive, non-advancing terminal state (never READY, never back to CREATING) — it
    // can never be used to fake or accelerate provisioning.
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.mark_workspace_schema_superseded(uuid, text) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.mark_workspace_schema_superseded(uuid, text) TO crewflow_app;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.mark_workspace_schema_superseded(uuid, text) TO rab_secure_owner;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.mark_workspace_schema_failed(p_workspace_id uuid, p_safe_error text)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'pg_catalog', 'pg_temp'
      AS $function$
      DECLARE
        v_org    uuid;
        v_status text;
        v_error  text;
        v_prev   text;
      BEGIN
        SELECT w.organisation_id, w.schema_status INTO v_org, v_status
          FROM core.manager_workspace w WHERE w.id = p_workspace_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_status = 'READY' THEN
          RAISE EXCEPTION 'a READY workspace schema cannot be marked failed' USING ERRCODE = '55000';
        END IF;
        v_error := left(coalesce(p_safe_error, 'provisioning failed'), 500);
        v_prev := current_setting('rab.organisation_id', true);
        PERFORM set_config('rab.organisation_id', v_org::text, true);
        UPDATE core.workspace_schema_registry
           SET status = 'FAILED', migration_error = v_error
         WHERE workspace_id = p_workspace_id AND status IN ('PROVISIONING', 'FAILED');
        UPDATE core.manager_workspace
           SET schema_status = 'FAILED', schema_last_error = v_error
         WHERE id = p_workspace_id;
        PERFORM set_config('rab.organisation_id', coalesce(v_prev, ''), true);
      END;
      $function$
    `);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.mark_workspace_schema_superseded(uuid, text);`);
    await queryRunner.query(`
      ALTER TABLE core.manager_workspace
        DROP CONSTRAINT manager_workspace_schema_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE core.manager_workspace
        ADD CONSTRAINT manager_workspace_schema_status_check
          CHECK (schema_status IS NULL OR schema_status IN ('CREATING', 'READY', 'MIGRATING', 'FAILED'));
    `);
  }
}
