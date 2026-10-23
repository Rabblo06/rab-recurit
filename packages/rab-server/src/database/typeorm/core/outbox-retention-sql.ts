/**
 * FROZEN with migration OutboxRetentionReplay1786719940000 (never edited after merge; a change is a new file + migration).
 *
 * Waves 4+5 lane DB5 (G6, CREWFLOW_TWENTY_FULL_ENGINE_PARITY_REPORT.md §3.14): retention purge for TERMINAL outbox rows and
 * an audited replay of a FAILED email. Contract: docs/evidence/w45-db5/CONTRACT.md §5.
 *
 * Purge:
 *  - one narrow function per table (no dynamic table name), SECURITY DEFINER owned by the table owner `crewflow` so the
 *    runtime role can purge without holding DELETE itself (REVOKEd here). The tables are FORCE RLS, so the policy binds the
 *    owner too: a call deletes only rows visible to the bound tenant context (org, and workspace where the policy has
 *    one) — the worker iterates organisations (and workspaces) exactly like every other per-tenant job. No context → 0.
 *  - terminal statuses only, re-checked on the outer DELETE after the row lock (`FOR UPDATE SKIP LOCKED`), so a row that a
 *    concurrent replay moved back to PENDING is never deleted;
 *  - the age is measured from the TERMINAL time, not created_at;
 *  - `p_retention` must be at least the table's floor (22023 otherwise). The floors are safety minimums chosen by this lane;
 *    the retention VALUES are an owner decision (G6), scheduled by the OPS lane behind a default-off flag.
 *
 * Replay: SECURITY INVOKER (the caller's RLS and grants apply), refuses scrubbed token-bearing bodies (F1 nulls them at
 * FAILED — the user must request a new link) and, unless explicitly allowed, a DELIVERY_UNCERTAIN failure (the provider
 * may already have sent it). The row goes to RETRY (NOT PENDING: the dispatcher publishes PENDING rows under the fixed
 * jobId `email-outbox.<id>.attempt.0`, which BullMQ would dedupe against the old failed job it still retains for 30
 * days — the replay would silently never run). A RETRY row with no provider call is "safe to recover": the dispatcher
 * bumps `dispatch_generation` and republishes under `...attempt.<generation>`, a job id no earlier attempt used, once the
 * RETRY staleness window has passed. The replay itself also bumps the generation (fencing: any in-flight worker holding
 * the old generation/token can no longer write the row). The audit row is written in the same transaction.
 */

interface PurgeSpec {
  table: string;
  terminal: readonly string[];
  age: string;
  minimum: string;
}

export const OUTBOX_PURGE_SPECS: readonly PurgeSpec[] = [
  { table: 'email_outbox', terminal: ['SENT', 'FAILED', 'CANCELLED'], age: 'coalesce(sent_at, failed_at, cancelled_at, updated_at)', minimum: '30 days' },
  { table: 'push_delivery', terminal: ['ACCEPTED', 'FAILED', 'CANCELLED'], age: 'coalesce(accepted_at, failed_at, cancelled_at, updated_at)', minimum: '30 days' },
  { table: 'realtime_event', terminal: ['completed', 'failed', 'cancelled'], age: 'coalesce(processed_at, last_error_at, updated_at)', minimum: '7 days' },
  { table: 'worker_event', terminal: ['completed', 'failed', 'cancelled'], age: 'coalesce(processed_at, last_error_at, updated_at)', minimum: '30 days' },
];

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');
const qualified = (age: string, alias: string) => age.replace(/\b(sent_at|failed_at|cancelled_at|accepted_at|processed_at|last_error_at|updated_at)\b/g, `${alias}.$1`);

function purgeFunctionSql(s: PurgeSpec): string {
  return `
CREATE INDEX ${s.table}_terminal_purge_idx ON core.${s.table} (organisation_id, (${s.age})) WHERE status IN (${list(s.terminal)});

CREATE FUNCTION core.purge_terminal_${s.table}(p_retention interval, p_batch integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $f$
DECLARE
  v_org uuid := core.current_org();
  v_n   integer;
BEGIN
  IF p_retention IS NULL OR p_retention < interval '${s.minimum}' THEN
    RAISE EXCEPTION 'purge_terminal_${s.table}: retention must be at least ${s.minimum}' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION 'purge_terminal_${s.table}: batch must be 1..10000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_org IS NULL THEN RETURN 0; END IF;
  DELETE FROM core.${s.table} o
   WHERE o.id IN (SELECT x.id FROM core.${s.table} x
                   WHERE x.organisation_id = v_org AND x.status IN (${list(s.terminal)})
                     AND ${qualified(s.age, 'x')} < pg_catalog.now() - p_retention
                   ORDER BY ${qualified(s.age, 'x')}
                   LIMIT p_batch
                   FOR UPDATE SKIP LOCKED)
     AND o.organisation_id = v_org
     AND o.status IN (${list(s.terminal)});
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$f$;
ALTER FUNCTION core.purge_terminal_${s.table}(interval, integer) OWNER TO crewflow;
REVOKE ALL ON FUNCTION core.purge_terminal_${s.table}(interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.purge_terminal_${s.table}(interval, integer) TO crewflow_app;
REVOKE DELETE, TRUNCATE ON core.${s.table} FROM crewflow_app;
`;
}

export const REPLAY_FAILED_EMAIL_SQL = `
CREATE FUNCTION core.replay_failed_email(p_email_id uuid, p_allow_uncertain boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $f$
DECLARE
  v_org   uuid := core.current_org();
  v_actor uuid := core.current_uid();
  r       record;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN RETURN 'NOT_FOUND'; END IF;
  SELECT o.id, o.organisation_id, o.status, o.rendered_html, o.rendered_text, o.last_error_code, o.dispatch_generation, o.job_type
    INTO r
    FROM core.email_outbox o
   WHERE o.id = p_email_id AND o.organisation_id = v_org
   FOR UPDATE;
  IF NOT FOUND OR r.status <> 'FAILED' THEN RETURN 'NOT_FOUND'; END IF;
  IF r.rendered_html IS NULL AND r.rendered_text IS NULL THEN RETURN 'NO_BODY'; END IF;
  IF r.last_error_code = 'DELIVERY_UNCERTAIN' AND NOT coalesce(p_allow_uncertain, false) THEN RETURN 'UNCERTAIN'; END IF;

  UPDATE core.email_outbox o
     SET status = 'RETRY', dispatch_generation = o.dispatch_generation + 1, infrastructure_attempt_count = 0,
         processing_token = NULL, provider_call_started_at = NULL, queued_at = NULL, processing_at = NULL,
         failed_at = NULL, last_error_code = NULL, last_error_message_sanitized = NULL, updated_at = pg_catalog.now()
   WHERE o.id = r.id AND o.status = 'FAILED';

  INSERT INTO core.audit_log (organisation_id, actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (v_org, v_actor, 'email.replay_requested', 'email_outbox', r.id,
          pg_catalog.jsonb_build_object('jobType', r.job_type, 'previousErrorCode', r.last_error_code,
                                        'previousGeneration', r.dispatch_generation, 'newGeneration', r.dispatch_generation + 1,
                                        'allowUncertain', coalesce(p_allow_uncertain, false)));
  RETURN 'REPLAYED';
END;
$f$;
ALTER FUNCTION core.replay_failed_email(uuid, boolean) OWNER TO crewflow;
REVOKE ALL ON FUNCTION core.replay_failed_email(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.replay_failed_email(uuid, boolean) TO crewflow_app;
`;

export const OUTBOX_RETENTION_UP_SQL = OUTBOX_PURGE_SPECS.map(purgeFunctionSql).join('\n') + REPLAY_FAILED_EMAIL_SQL;

export const OUTBOX_RETENTION_DOWN_SQL =
  `DROP FUNCTION IF EXISTS core.replay_failed_email(uuid, boolean);\n` +
  OUTBOX_PURGE_SPECS.map(
    (s) =>
      `DROP FUNCTION IF EXISTS core.purge_terminal_${s.table}(interval, integer);\n` +
      `DROP INDEX IF EXISTS core.${s.table}_terminal_purge_idx;\n` +
      `GRANT DELETE ON core.${s.table} TO crewflow_app;\n`,
  ).join('');
