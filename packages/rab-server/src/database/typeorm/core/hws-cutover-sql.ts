// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, function, role and column names, the closed table list); no request or row data reaches these templates. Inside the function bodies every identifier goes through format('%I') / quote_ident / regclass output, and every value through EXECUTE ... USING. Reviewed 2026-11-15 (C3, FOR OWNER REVIEW).
/**
 * OWNER-DB-ULTIMATE Part C3 (HWS cutover), option A′ — PENDING OWNER CHOICE (A′ vs B′) AND SQL REVIEW
 * (docs/plans/phase-x3/SQL-DRAFTS.md §3 and §6 "FOR OWNER REVIEW — C3"). Runs only on throwaway databases until approved.
 *
 * The copy path for the 21 workspace-business tables from the `core` copies into each workspace's own schema, under the one
 * runtime login (`crewflow_owner`, never superuser / BYPASSRLS, §0.1) with FORCE ROW LEVEL SECURITY kept on everything (§0.2):
 *
 *   - FORCE RLS binds the table owner too, so a SECURITY DEFINER owned by `crewflow` (the owner of both copies) still sees only
 *     what the tenant policies show it, and the workspace INSERT policies refuse historical rows (an approved payroll record,
 *     a review written by someone else). Option A′ lifts FORCE on exactly the tables one call touches, INSIDE that call's
 *     transaction, under ACCESS EXCLUSIVE (no other session can read or write them meanwhile), restores FORCE and asserts it
 *     before returning. Any error aborts the transaction, so a NO FORCE state can never be committed.
 *   - The migration-lock and tenant checks (core.hws_cutover_schema) are GUARDS AGAINST MISTAKES (a call from the wrong
 *     session, with the wrong tenant bound, on a workspace that is not READY), NOT an authorization boundary: a session that
 *     can act as crewflow can already ALTER these tables itself (BC-01 / G-02, owner-accepted). The authorization boundary is
 *     EXECUTE: crewflow and its members only; PUBLIC and crewflow_app hold nothing.
 *   - CHECK constraints (money, `<table>_workspace_bound`), FKs and triggers stay on. `payroll_record_guard` is BEFORE UPDATE
 *     only; the statement-pointer INSERT trigger fires, and the pointers it creates for the rows the SAME batch inserted are
 *     reconciled by hws_cutover_drop_new_statement_pointers (Q13).
 *   - Copy = INSERT ... ON CONFLICT DO NOTHING: idempotent, resumable, never an UPDATE or DELETE of either copy
 *     (attendance_correction stays insert-only; the core copies are never written).
 *   - core.hws_cutover_state (review L-2): the per-workspace cutover state (started → verified); core.hws_cutover_activation
 *     (re-check N-1 / N-2): the one-way, instance-wide "cutover active" sentinel the cutover writes on its first run with HWS
 *     on. Both rab_secure_owner-owned, ENABLE + FORCE, written only through owner-only policies (CURRENT_USER = crewflow /
 *     rab_secure_owner): the runtime logins and crewflow_app can read but never write them. Together they drive the
 *     resolver (fail closed: started → 503; once active, anything not verified → 503), the core write fence (review M-3) and
 *     the HWS-off boot refusal. New workspaces are marked verified by an AFTER INSERT trigger on core.manager_workspace,
 *     only once the sentinel exists — never by an application call (re-check N-1).
 *
 * Twenty has no RLS and no cross-schema copy: this is a Crewflow addition (§0). Twenty's per-workspace command shape
 * (`workspace-command-runner.service.ts:106-153`, twentyhq/twenty @ eedb0a73) is followed by the C3 upgrade command.
 */

/** The 21 workspace-business tables (WORKSPACE_TABLES, provision-workspace-schema.ts). Frozen here: the SQL bodies are reviewed. */
export const HWS_CUTOVER_TABLES = [
  'staff_profile', 'user_note', 'venue', 'venue_manager_staff', 'job_role', 'venue_role_rate', 'manager_venue', 'shift',
  'shift_request_staff', 'shift_assignment', 'job_offer', 'replacement_request', 'attendance', 'attendance_correction', 'shift_report', 'shift_staff_review',
  'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document',
] as const;

const TABLE_ARRAY_SQL = `ARRAY[${HWS_CUTOVER_TABLES.map((t) => `'${t}'`).join(', ')}]::text[]`;

/** Every function this module creates, as `regprocedure` text (core-qualified). */
export const HWS_CUTOVER_FUNCTIONS = [
  'core.hws_cutover_schema(uuid)',
  'core.hws_cutover_source_sql(text)',
  'core.hws_cutover_probe(uuid)',
  'core.hws_cutover_copy_batch(uuid,text,text,integer)',
  'core.hws_cutover_verify_range(uuid,text,text,integer)',
  'core.hws_cutover_started_any()',
  'core.hws_cutover_core_fence()',
  'core.hws_cutover_drop_new_statement_pointers(uuid,uuid[])',
  'core.hws_cutover_purge_core_statement_pointers(uuid)',
  'core.hws_cutover_new_workspace_trg()',
] as const;

export const HWS_CUTOVER_FENCE_TRIGGER = 'hws_cutover_core_fence';
export const HWS_CUTOVER_NEW_WORKSPACE_TRIGGER = 'hws_cutover_new_workspace';

/**
 * (T1) The per-workspace cutover state. One row per workspace once its copy has started; 'verified' once every table matched,
 * once the cutover found nothing of it in core, or — for a workspace created after activation — at its creation. FK to the
 * workspace (cascade). OWNED BY rab_secure_owner (the new-workspace trigger on core.manager_workspace, a secure table, must be
 * a rab_secure_owner function, and R4 forbids it to name a crewflow-owned table). ENABLE + FORCE; policies:
 *   - tenant SELECT for everyone (`organisation_id = current_org()`): the resolver, the fence and the scan read it;
 *   - owner-only SELECT for crewflow (no tenant): the boot-check definer core.hws_cutover_started_any();
 *   - owner-only INSERT / UPDATE for crewflow, within the bound organisation: the cutover (SET LOCAL ROLE crewflow);
 *   - owner-only ALL for rab_secure_owner: the new-workspace trigger function.
 * The owner-only expressions (CURRENT_USER = …) mean a MEMBER of crewflow — the runtime login — is never admitted. Grants:
 * SELECT to crewflow_app; SELECT, INSERT, UPDATE to crewflow; DELETE / TRUNCATE to nobody (owner only).
 */
export const HWS_CUTOVER_STATE_TABLE_SQL: readonly string[] = [
  `CREATE TABLE core.hws_cutover_state (
  workspace_id uuid NOT NULL,
  organisation_id uuid NOT NULL,
  state text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  verified_at timestamptz,
  CONSTRAINT hws_cutover_state_pkey PRIMARY KEY (workspace_id),
  CONSTRAINT hws_cutover_state_state_check CHECK (state IN ('started', 'verified')),
  CONSTRAINT hws_cutover_state_verified_check CHECK ((state = 'verified') = (verified_at IS NOT NULL)),
  CONSTRAINT hws_cutover_state_workspace_org_fkey FOREIGN KEY (workspace_id, organisation_id)
    REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE
)`,
  'CREATE INDEX hws_cutover_state_organisation_idx ON core.hws_cutover_state (organisation_id)',
  'ALTER TABLE core.hws_cutover_state ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.hws_cutover_state FORCE ROW LEVEL SECURITY',
  `CREATE POLICY hws_cutover_state_tenant_read ON core.hws_cutover_state AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (organisation_id = core.current_org())`,
  `CREATE POLICY hws_cutover_state_crewflow_read ON core.hws_cutover_state AS PERMISSIVE FOR SELECT TO crewflow
  USING (CURRENT_USER = 'crewflow'::name)`,
  `CREATE POLICY hws_cutover_state_crewflow_insert ON core.hws_cutover_state AS PERMISSIVE FOR INSERT TO crewflow
  WITH CHECK (CURRENT_USER = 'crewflow'::name AND organisation_id = core.current_org())`,
  `CREATE POLICY hws_cutover_state_crewflow_update ON core.hws_cutover_state AS PERMISSIVE FOR UPDATE TO crewflow
  USING (CURRENT_USER = 'crewflow'::name AND organisation_id = core.current_org())
  WITH CHECK (CURRENT_USER = 'crewflow'::name AND organisation_id = core.current_org())`,
  `CREATE POLICY hws_cutover_state_secure_owner_definer ON core.hws_cutover_state AS PERMISSIVE FOR ALL TO rab_secure_owner
  USING (CURRENT_USER = 'rab_secure_owner'::name) WITH CHECK (CURRENT_USER = 'rab_secure_owner'::name)`,
  'REVOKE ALL ON TABLE core.hws_cutover_state FROM PUBLIC',
  'GRANT SELECT ON TABLE core.hws_cutover_state TO crewflow_app',
  'GRANT SELECT, INSERT, UPDATE ON TABLE core.hws_cutover_state TO crewflow',
];

/**
 * (T2) Re-check N-1 / N-2: the instance-wide, ONE-WAY "cutover active" sentinel (at most one row). Written by the cutover
 * command on its first run with HWS on (also on a fresh install with no workspace); never removed (no UPDATE / DELETE
 * policy: not even its owner can, short of ALTER). Once it exists: routing requires a verified state (fail closed), new
 * workspaces are marked verified at insertion, and an HWS-off API / Worker refuses to boot. No organisation_id: an instance
 * fact, not tenant data — ENABLE + FORCE anyway (tools/check-rls-coverage.ts FORCED_NON_TENANT_TABLES), readable by everyone,
 * insertable only by crewflow itself. Owned by rab_secure_owner (read by the new-workspace trigger function, R4).
 */
export const HWS_CUTOVER_ACTIVATION_TABLE_SQL: readonly string[] = [
  `CREATE TABLE core.hws_cutover_activation (
  singleton boolean NOT NULL DEFAULT true,
  activated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT hws_cutover_activation_pkey PRIMARY KEY (singleton),
  CONSTRAINT hws_cutover_activation_singleton_check CHECK (singleton)
)`,
  'ALTER TABLE core.hws_cutover_activation ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.hws_cutover_activation FORCE ROW LEVEL SECURITY',
  `CREATE POLICY hws_cutover_activation_read ON core.hws_cutover_activation AS PERMISSIVE FOR SELECT TO PUBLIC USING (true)`,
  `CREATE POLICY hws_cutover_activation_crewflow_insert ON core.hws_cutover_activation AS PERMISSIVE FOR INSERT TO crewflow
  WITH CHECK (CURRENT_USER = 'crewflow'::name)`,
  'REVOKE ALL ON TABLE core.hws_cutover_activation FROM PUBLIC',
  'GRANT SELECT ON TABLE core.hws_cutover_activation TO crewflow_app',
  'GRANT SELECT, INSERT ON TABLE core.hws_cutover_activation TO crewflow',
];

/**
 * (T3) Re-check N-1: the creation hook in the database. AFTER INSERT on core.manager_workspace (INSERT only — an UPDATE that
 * fakes a new workspace's columns never fires it): once the cutover is active, the new workspace starts 'verified' (no core
 * data by construction), in the creating transaction. Before activation it does nothing (an HWS-off deployment's new
 * workspace keeps its data in core and is copied by the cutover later). rab_secure_owner definer bound to its one table.
 */
export const HWS_CUTOVER_NEW_WORKSPACE_TRG_SQL = `
CREATE FUNCTION core.hws_cutover_new_workspace_trg()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'core' OR TG_TABLE_NAME IS DISTINCT FROM 'manager_workspace'
     OR TG_OP IS DISTINCT FROM 'INSERT' OR TG_WHEN IS DISTINCT FROM 'AFTER' OR TG_LEVEL IS DISTINCT FROM 'ROW' THEN
    RAISE EXCEPTION 'hws cutover: core.hws_cutover_new_workspace_trg() is attached to the wrong table or event' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM core.hws_cutover_activation) THEN
    INSERT INTO core.hws_cutover_state (workspace_id, organisation_id, state, verified_at)
    VALUES (NEW.id, NEW.organisation_id, 'verified', pg_catalog.now())
    ON CONFLICT (workspace_id) DO NOTHING;
  END IF;
  RETURN NULL;
END
$fn$`;

export const HWS_CUTOVER_NEW_WORKSPACE_TRIGGER_SQL = `CREATE TRIGGER hws_cutover_new_workspace AFTER INSERT ON core.manager_workspace
  FOR EACH ROW EXECUTE FUNCTION core.hws_cutover_new_workspace_trg()`;

/**
 * (0a) Guard shared by the crewflow definers (SECURITY INVOKER: it runs as the calling definer, i.e. crewflow). Returns the
 * workspace's schema name or raises: 42501 no migration lock on this backend / tenant not this workspace; 55000 not READY or
 * not the derived name. The lock key is the single-bigint 0x637265776d696772 ("crewmigr", migration-lock.ts), which pg_locks
 * spells classid 1668441463, objid 1835624306, objsubid 1. A guard against mistakes, not an authorization boundary.
 */
export const HWS_CUTOVER_SCHEMA_SQL = `
CREATE FUNCTION core.hws_cutover_schema(p_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_schema text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks l
                  WHERE l.locktype = 'advisory' AND l.pid = pg_catalog.pg_backend_pid() AND l.granted
                    AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
                    AND l.classid = 1668441463::oid AND l.objid = 1835624306::oid AND l.objsubid = 1) THEN
    RAISE EXCEPTION 'hws cutover: the migration lock is not held by this session' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NULL OR core.current_workspace() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'hws cutover: tenant context is not this workspace' USING ERRCODE = '42501';
  END IF;
  SELECT r.schema_name INTO v_schema
    FROM core.workspace_schema_registry r
   WHERE r.workspace_id = p_workspace_id AND r.organisation_id = core.current_org() AND r.status = 'READY';
  IF v_schema IS NULL OR v_schema <> 'workspace_' || pg_catalog.replace(p_workspace_id::text, '-', '')
     OR pg_catalog.to_regnamespace(v_schema) IS NULL THEN
    RAISE EXCEPTION 'hws cutover: workspace schema not READY or not its derived name' USING ERRCODE = '55000';
  END IF;
  RETURN v_schema;
END
$fn$`;

/**
 * (0b) The core-side source rows of one table for workspace $1 (a uuid parameter), as a SELECT with alias-free columns
 * `c.*` plus `j` = the row as jsonb in the WORKSPACE table's shape. Pure text builder (IMMUTABLE, no table access).
 *   - 20 tables: `core.<t> WHERE workspace_id = $1 AND organisation_id = current_org()` (review L-1: a row of W carrying
 *     another organisation is never copied; the probe reports it and the command refuses W).
 *   - user_note: core.user_note has no workspace_id (HWS backfill Part 15, user-note-mapping.ts). A note belongs to W when its
 *     subject has EXACTLY ONE profile (staff or manager) in the organisation and that profile is in W; `workspace_id` is merged
 *     into j. Notes whose subject has no profile or more than one are never copied and are reported by the probe.
 */
export const HWS_CUTOVER_SOURCE_SQL = `
CREATE FUNCTION core.hws_cutover_source_sql(p_table text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF p_table IS NULL OR NOT (p_table = ANY (${TABLE_ARRAY_SQL})) THEN
    RAISE EXCEPTION 'hws cutover: table not allowed' USING ERRCODE = '22023';
  END IF;
  IF p_table = 'user_note' THEN
    RETURN 'SELECT c.*, pg_catalog.to_jsonb(c) || pg_catalog.jsonb_build_object(''workspace_id'', $1::uuid) AS j
              FROM core.user_note c
             WHERE c.organisation_id = core.current_org()
               AND (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM core.staff_profile s WHERE s.user_id = c.subject_user_id
                                                      UNION ALL
                                                      SELECT 1 FROM core.manager_profile m WHERE m.user_id = c.subject_user_id) x) = 1
               AND (EXISTS (SELECT 1 FROM core.staff_profile s WHERE s.user_id = c.subject_user_id AND s.workspace_id = $1::uuid)
                    OR EXISTS (SELECT 1 FROM core.manager_profile m WHERE m.user_id = c.subject_user_id AND m.workspace_id = $1::uuid))';
  END IF;
  RETURN pg_catalog.format('SELECT c.*, pg_catalog.to_jsonb(c) AS j FROM core.%I c WHERE c.workspace_id = $1::uuid AND c.organisation_id = core.current_org()', p_table);
END
$fn$`;

/** Key columns per table (all uuid). Three junction tables have a composite primary key; every other table has `id`. */
const KEYS_CASE_SQL = `CASE p_table
    WHEN 'manager_venue' THEN ARRAY['manager_profile_id', 'venue_id']
    WHEN 'venue_manager_staff' THEN ARRAY['manager_profile_id', 'staff_profile_id']
    WHEN 'shift_request_staff' THEN ARRAY['shift_id', 'staff_profile_id']
    ELSE ARRAY['id'] END`;

/** The relations one call lifts FORCE on: core.<t> and <schema>.<t>, plus the two profile tables user_note's mapping reads. */
const RELS_SQL = `v_rels := ARRAY[pg_catalog.format('core.%I', p_table)::pg_catalog.regclass, pg_catalog.format('%I.%I', v_schema, p_table)::pg_catalog.regclass];
  IF p_table = 'user_note' THEN
    v_rels := v_rels || ARRAY['core.staff_profile'::pg_catalog.regclass, 'core.manager_profile'::pg_catalog.regclass];
  END IF`;

const LIFT_SQL = `FOREACH v_rel IN ARRAY v_rels LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', v_rel);
  END LOOP`;

/** FORCE back on, then proven (ENABLE + FORCE on every lifted relation); otherwise the whole transaction rolls back. */
const RESTORE_SQL = `FOREACH v_rel IN ARRAY v_rels LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', v_rel);
  END LOOP;
  SELECT pg_catalog.bool_and(c.relrowsecurity AND c.relforcerowsecurity) INTO v_ok
    FROM pg_catalog.pg_class c WHERE c.oid = ANY (v_rels::pg_catalog.oid[]);
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'hws cutover: FORCE ROW LEVEL SECURITY not restored' USING ERRCODE = 'XX000';
  END IF`;

/** Table + limit check, the guard, the key columns, and the keyset `after` parsed into a uuid[] of the key's arity. */
const PREAMBLE_SQL = `IF p_table IS NULL OR NOT (p_table = ANY (${TABLE_ARRAY_SQL})) THEN
    RAISE EXCEPTION 'hws cutover: table not allowed' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'hws cutover: limit out of range' USING ERRCODE = '22023';
  END IF;
  v_schema := core.hws_cutover_schema(p_workspace_id);
  v_keys := ${KEYS_CASE_SQL};
  IF p_after IS NOT NULL THEN
    v_after := pg_catalog.string_to_array(p_after, '|')::uuid[];
    IF pg_catalog.cardinality(v_after) IS DISTINCT FROM pg_catalog.cardinality(v_keys) THEN
      RAISE EXCEPTION 'hws cutover: malformed keyset position' USING ERRCODE = '22023';
    END IF;
  END IF;
  SELECT pg_catalog.string_agg('c.' || pg_catalog.quote_ident(u.k), ', ' ORDER BY u.o),
         pg_catalog.string_agg('w.' || pg_catalog.quote_ident(u.k), ', ' ORDER BY u.o),
         pg_catalog.string_agg('c.' || pg_catalog.quote_ident(u.k) || '::text', ', ' ORDER BY u.o),
         pg_catalog.string_agg(pg_catalog.quote_ident(u.k) || '::text', ', ' ORDER BY u.o),
         pg_catalog.string_agg('$2[' || u.o || ']', ', ' ORDER BY u.o),
         pg_catalog.string_agg('$3[' || u.o || ']', ', ' ORDER BY u.o)
    INTO v_ckeys, v_wkeys, v_ktext, v_rtext, v_after_ref, v_upto_ref
    FROM pg_catalog.unnest(v_keys) WITH ORDINALITY AS u(k, o);
  v_src := core.hws_cutover_source_sql(p_table)`;

const PREAMBLE_DECLARE_SQL = `v_schema    text;
  v_keys      text[];
  v_after     uuid[];
  v_ckeys     text;
  v_wkeys     text;
  v_ktext     text;
  v_rtext     text;
  v_after_ref text;
  v_upto_ref  text;
  v_src       text;
  v_rels      pg_catalog.regclass[];
  v_rel       pg_catalog.regclass;
  v_ok        boolean;`;

/**
 * (A) One keyset batch of one table, core → the workspace's own schema. Returns rows inserted (copied), source rows read in
 * this batch (read_rows; fewer than p_limit = the table is done), the last key read (`k1` or `k1|k2`, to pass back as
 * p_after) and the keys this batch INSERTED (inserted_keys; review M-1: only their statement pointers are reconciled).
 * Original ids and every value at full precision (jsonb_populate_record against the TARGET row type, the same conversion
 * hws:backfill uses); generated columns are recomputed by PostgreSQL.
 */
export const HWS_CUTOVER_COPY_BATCH_SQL = `
CREATE FUNCTION core.hws_cutover_copy_batch(p_workspace_id uuid, p_table text, p_after text, p_limit integer)
RETURNS TABLE (copied integer, read_rows integer, last_key text, inserted_keys text[])
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
AS $fn$
DECLARE
  ${PREAMBLE_DECLARE_SQL}
  v_cols      text;
  v_sel       text;
BEGIN
  ${PREAMBLE_SQL};
  SELECT pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' ORDER BY a.attnum),
         pg_catalog.string_agg('r.' || pg_catalog.quote_ident(a.attname), ', ' ORDER BY a.attnum)
    INTO v_cols, v_sel
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = pg_catalog.format('%I.%I', v_schema, p_table)::pg_catalog.regclass
     AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '';
  ${RELS_SQL};
  ${LIFT_SQL};
  EXECUTE pg_catalog.format(
    'WITH src AS MATERIALIZED (
       SELECT c.j, pg_catalog.concat_ws(''|'', %1$s) AS k, pg_catalog.row_number() OVER (ORDER BY %2$s) AS rn
         FROM (%3$s) c
        WHERE ($2::uuid[] IS NULL OR (%2$s) > (%4$s))
        ORDER BY %2$s
        LIMIT $3),
     ins AS (
       INSERT INTO %5$I.%6$I (%7$s)
       SELECT %8$s FROM src, LATERAL pg_catalog.jsonb_populate_record(NULL::%5$I.%6$I, src.j) AS r
       ON CONFLICT DO NOTHING
       RETURNING pg_catalog.concat_ws(''|'', %9$s) AS k)
     SELECT (SELECT pg_catalog.count(*) FROM ins)::integer,
            (SELECT pg_catalog.count(*) FROM src)::integer,
            (SELECT s.k FROM src s ORDER BY s.rn DESC LIMIT 1),
            (SELECT coalesce(pg_catalog.array_agg(i.k), ARRAY[]::text[]) FROM ins i)',
    v_ktext, v_ckeys, v_src, v_after_ref, v_schema, p_table, v_cols, v_sel, v_rtext)
    INTO copied, read_rows, last_key, inserted_keys
    USING p_workspace_id, v_after, p_limit;
  ${RESTORE_SQL};
  RETURN NEXT;
END
$fn$`;

/**
 * (B) Verification of one key range of one table: the range is (p_after, upto] on CORE keys, upto = the p_limit-th core key;
 * the last range (fewer than p_limit core rows left) is open-ended, so workspace rows above the last core key are caught.
 * Per side: row count, md5 of the rows' canonical jsonb text ordered by key, money (pence) and worked-minutes totals; both
 * directions of the row comparison (EXCEPT ALL); and column_gap = core columns the workspace table does not have (their
 * data could not be copied), NULL when none. The core side of user_note carries the mapped workspace_id (as copied).
 */
export const HWS_CUTOVER_VERIFY_RANGE_SQL = `
CREATE FUNCTION core.hws_cutover_verify_range(p_workspace_id uuid, p_table text, p_after text, p_limit integer)
RETURNS TABLE (core_rows integer, ws_rows integer, missing integer, extra integer, last_key text,
               core_md5 text, ws_md5 text, core_pence numeric, ws_pence numeric, core_minutes numeric, ws_minutes numeric,
               column_gap text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
AS $fn$
DECLARE
  ${PREAMBLE_DECLARE_SQL}
  v_upto      uuid[];
  v_n         integer;
  v_upto_text text;
  v_pence     text;
  v_minutes   text;
BEGIN
  ${PREAMBLE_SQL};
  v_pence := CASE p_table WHEN 'payroll_record' THEN 'amount_pence' WHEN 'payroll_run_line' THEN 'amount_pence'
                          WHEN 'payslip' THEN 'net_pence' WHEN 'attendance' THEN 'earned_pence' ELSE NULL END;
  v_minutes := CASE p_table WHEN 'payroll_record' THEN 'worked_minutes' WHEN 'payroll_run_line' THEN 'worked_minutes'
                            WHEN 'attendance' THEN 'worked_minutes' ELSE NULL END;
  SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY a.attnum) INTO column_gap
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = pg_catalog.format('core.%I', p_table)::pg_catalog.regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute b
                      WHERE b.attrelid = pg_catalog.format('%I.%I', v_schema, p_table)::pg_catalog.regclass
                        AND b.attname = a.attname AND b.attnum > 0 AND NOT b.attisdropped);
  ${RELS_SQL};
  ${LIFT_SQL};
  EXECUTE pg_catalog.format(
    'SELECT pg_catalog.count(*)::integer, (pg_catalog.array_agg(c.k ORDER BY c.rn DESC))[1]
       FROM (SELECT pg_catalog.concat_ws(''|'', %1$s) AS k, pg_catalog.row_number() OVER (ORDER BY %2$s) AS rn
               FROM (%3$s) c
              WHERE ($2::uuid[] IS NULL OR (%2$s) > (%4$s))
              ORDER BY %2$s
              LIMIT $3) c',
    v_ktext, v_ckeys, v_src, v_after_ref)
    INTO v_n, v_upto_text
    USING p_workspace_id, v_after, p_limit;
  IF v_n < p_limit THEN
    v_upto_text := NULL;
  END IF;
  v_upto := pg_catalog.string_to_array(v_upto_text, '|')::uuid[];
  EXECUTE pg_catalog.format(
    'WITH a AS (SELECT ROW(%1$s) AS key, c.j::text AS j, %6$s AS pence, %7$s AS minutes
                  FROM (%3$s) c
                 WHERE ($2::uuid[] IS NULL OR (%1$s) > (%4$s)) AND ($3::uuid[] IS NULL OR (%1$s) <= (%5$s))),
          b AS (SELECT ROW(%2$s) AS key, pg_catalog.to_jsonb(w)::text AS j, %8$s AS pence, %9$s AS minutes
                  FROM %10$I.%11$I w
                 WHERE ($2::uuid[] IS NULL OR (%2$s) > (%4$s)) AND ($3::uuid[] IS NULL OR (%2$s) <= (%5$s)))
     SELECT (SELECT pg_catalog.count(*) FROM a)::integer,
            (SELECT pg_catalog.count(*) FROM b)::integer,
            (SELECT pg_catalog.count(*) FROM (SELECT j FROM a EXCEPT ALL SELECT j FROM b) x)::integer,
            (SELECT pg_catalog.count(*) FROM (SELECT j FROM b EXCEPT ALL SELECT j FROM a) x)::integer,
            (SELECT pg_catalog.md5(coalesce(pg_catalog.string_agg(a.j, E''\\n'' ORDER BY a.key), '''')) FROM a),
            (SELECT pg_catalog.md5(coalesce(pg_catalog.string_agg(b.j, E''\\n'' ORDER BY b.key), '''')) FROM b),
            (SELECT pg_catalog.sum(a.pence) FROM a)::numeric, (SELECT pg_catalog.sum(b.pence) FROM b)::numeric,
            (SELECT pg_catalog.sum(a.minutes) FROM a)::numeric, (SELECT pg_catalog.sum(b.minutes) FROM b)::numeric',
    v_ckeys, v_wkeys, v_src, v_after_ref, v_upto_ref,
    coalesce('c.' || pg_catalog.quote_ident(v_pence), 'NULL::bigint'), coalesce('c.' || pg_catalog.quote_ident(v_minutes), 'NULL::integer'),
    coalesce('w.' || pg_catalog.quote_ident(v_pence), 'NULL::bigint'), coalesce('w.' || pg_catalog.quote_ident(v_minutes), 'NULL::integer'),
    v_schema, p_table)
    INTO core_rows, ws_rows, missing, extra, core_md5, ws_md5, core_pence, ws_pence, core_minutes, ws_minutes
    USING p_workspace_id, v_after, v_upto;
  last_key := v_upto_text;
  ${RESTORE_SQL};
  RETURN NEXT;
END
$fn$`;

/**
 * (C) Pre-check of one workspace, all 21 tables in one call: whether the core copy holds rows of W (core_rows), whether W's
 * own table already holds rows (ws_rows), and org_mismatch = core rows of W that carry ANOTHER organisation (review L-1;
 * never copied, the command refuses W) and unowned_rows = core rows of W's ORGANISATION with no workspace at all (re-check
 * Info-A: they belong to no schema and would never be copied; the command refuses W). On the user_note row: ambiguous_notes = notes of the organisation whose subject
 * has a profile in W AND another profile (they cannot be mapped to exactly one workspace: the copy skips them, the command
 * refuses W), unmapped_notes = notes of the organisation whose subject has no profile at all (they belong to no workspace;
 * reported, never copied). Lifts FORCE on all 43 relations at once (ACCESS EXCLUSIVE on each until the transaction ends).
 */
export const HWS_CUTOVER_PROBE_SQL = `
CREATE FUNCTION core.hws_cutover_probe(p_workspace_id uuid)
RETURNS TABLE (table_name text, core_rows boolean, ws_rows boolean, org_mismatch integer, unowned_rows integer, ambiguous_notes integer, unmapped_notes integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
AS $fn$
DECLARE
  v_schema text;
  v_table  text;
  v_rels   pg_catalog.regclass[];
  v_rel    pg_catalog.regclass;
  v_ok     boolean;
BEGIN
  v_schema := core.hws_cutover_schema(p_workspace_id);
  v_rels := ARRAY['core.manager_profile'::pg_catalog.regclass];
  FOREACH v_table IN ARRAY ${TABLE_ARRAY_SQL} LOOP
    v_rels := v_rels || ARRAY[pg_catalog.format('core.%I', v_table)::pg_catalog.regclass,
                              pg_catalog.format('%I.%I', v_schema, v_table)::pg_catalog.regclass];
  END LOOP;
  ${LIFT_SQL};
  FOREACH v_table IN ARRAY ${TABLE_ARRAY_SQL} LOOP
    table_name := v_table;
    EXECUTE pg_catalog.format('SELECT EXISTS (%s)', core.hws_cutover_source_sql(v_table)) INTO core_rows USING p_workspace_id;
    EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %I.%I)', v_schema, v_table) INTO ws_rows;
    org_mismatch := 0;
    unowned_rows := 0;
    ambiguous_notes := 0;
    unmapped_notes := 0;
    IF v_table = 'user_note' THEN
      SELECT pg_catalog.count(*)::integer INTO ambiguous_notes
        FROM core.user_note c
       WHERE c.organisation_id = core.current_org()
         AND (EXISTS (SELECT 1 FROM core.staff_profile s WHERE s.user_id = c.subject_user_id AND s.workspace_id = p_workspace_id)
              OR EXISTS (SELECT 1 FROM core.manager_profile m WHERE m.user_id = c.subject_user_id AND m.workspace_id = p_workspace_id))
         AND (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM core.staff_profile s WHERE s.user_id = c.subject_user_id
                                                UNION ALL
                                                SELECT 1 FROM core.manager_profile m WHERE m.user_id = c.subject_user_id) x) > 1;
      SELECT pg_catalog.count(*)::integer INTO unmapped_notes
        FROM core.user_note c
       WHERE c.organisation_id = core.current_org()
         AND NOT EXISTS (SELECT 1 FROM core.staff_profile s WHERE s.user_id = c.subject_user_id)
         AND NOT EXISTS (SELECT 1 FROM core.manager_profile m WHERE m.user_id = c.subject_user_id);
    ELSE
      EXECUTE pg_catalog.format('SELECT pg_catalog.count(*)::integer FROM core.%I c WHERE c.workspace_id = $1 AND c.organisation_id IS DISTINCT FROM core.current_org()', v_table)
        INTO org_mismatch USING p_workspace_id;
      EXECUTE pg_catalog.format('SELECT pg_catalog.count(*)::integer FROM core.%I c WHERE c.workspace_id IS NULL AND c.organisation_id = core.current_org()', v_table)
        INTO unowned_rows;
    END IF;
    RETURN NEXT;
  END LOOP;
  ${RESTORE_SQL};
END
$fn$`;

/**
 * (D) Boot check (review M-3): has the cutover been activated, or has ANY workspace's cutover started? A crewflow definer
 * reading through the owner-only SELECT policy hws_cutover_state_crewflow_read (no tenant needed) and the public sentinel. Boolean only. An API or Worker with HWS off refuses to start when
 * true (hws-startup-guard.ts): it would read and write the frozen core copies of a workspace served from its own schema.
 */
export const HWS_CUTOVER_STARTED_ANY_SQL = `
CREATE FUNCTION core.hws_cutover_started_any()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT EXISTS (SELECT 1 FROM core.hws_cutover_state) OR EXISTS (SELECT 1 FROM core.hws_cutover_activation)
$fn$`;

/**
 * (E) Review M-3, the DB fence: once a workspace's cutover has STARTED (state row present), its rows in the 21 core copies are
 * read-only for every role except the table owners and a superuser (FK cascades from core.organisation / core.manager_workspace
 * run as the owner crewflow and still pass; the cutover itself never writes core). user_note has no workspace_id: fenced per
 * organisation (any workspace of the organisation cut over). Row-level BEFORE INSERT / UPDATE / DELETE on each core copy;
 * SECURITY INVOKER (it reads hws_cutover_state under the writer's own tenant binding: a write without a tenant is refused by
 * the core RLS anyway). 42501, fixed message, no identifier in it. Rollback note: a previous image (HWS off) can then read but
 * not write the core copy of a cut-over workspace — writes fail loudly instead of being silently lost.
 */
export const HWS_CUTOVER_FENCE_FUNCTION_SQL = `
CREATE FUNCTION core.hws_cutover_core_fence()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_old uuid;
  v_new uuid;
  v_hit boolean;
BEGIN
  IF current_user IN ('crewflow'::name, 'rab_secure_owner'::name)
     OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'user_note' THEN
    IF TG_OP <> 'INSERT' THEN v_old := OLD.organisation_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new := NEW.organisation_id; END IF;
    SELECT EXISTS (SELECT 1 FROM core.hws_cutover_state s WHERE s.organisation_id IN (v_old, v_new)) INTO v_hit;
  ELSE
    IF TG_OP <> 'INSERT' THEN v_old := OLD.workspace_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new := NEW.workspace_id; END IF;
    SELECT EXISTS (SELECT 1 FROM core.hws_cutover_state s WHERE s.workspace_id IN (v_old, v_new)) INTO v_hit;
  END IF;
  IF v_hit THEN
    RAISE EXCEPTION 'permission denied: this workspace is served from its own schema since the HWS cutover; its core copy is read-only'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$fn$`;

export const HWS_CUTOVER_FENCE_TRIGGERS_SQL: readonly string[] = HWS_CUTOVER_TABLES.map(
  (t) => `CREATE TRIGGER ${HWS_CUTOVER_FENCE_TRIGGER} BEFORE INSERT OR UPDATE OR DELETE ON core.${t}
  FOR EACH ROW EXECUTE FUNCTION core.hws_cutover_core_fence()`,
);

/** Same inline lock + tenant check in both rab_secure_owner definers (R4: they may call no crewflow-owned function). */
const POINTER_GUARD_SQL = (label: string) => `IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks l
                  WHERE l.locktype = 'advisory' AND l.pid = pg_catalog.pg_backend_pid() AND l.granted
                    AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
                    AND l.classid = 1668441463::oid AND l.objid = 1835624306::oid AND l.objsubid = 1) THEN
    RAISE EXCEPTION 'hws cutover ${label}: the migration lock is not held by this session' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NULL OR core.current_workspace() IS DISTINCT FROM p_workspace_id
     OR pg_catalog.to_regnamespace(v_schema) IS NULL THEN
    RAISE EXCEPTION 'hws cutover ${label}: tenant context is not this workspace, or no such schema' USING ERRCODE = '42501';
  END IF`;

/**
 * (F) Q13 / review M-1: the copy's INSERT trigger gave a copied approved payroll_record with no statement a NEW
 * workspace-source pointer, due now (key (queue, subject_id, source_schema) since StatementPointerPhysicalIdentity
 * 1786721350000). Called in the SAME transaction as the copy batch, with exactly the ids that batch inserted: such a pointer
 * is kept only when its core twin had one, so the copy creates no new due work — and no pointer of any other row (a live
 * workspace that already serves from its schema) is ever touched. Owned by rab_secure_owner (only it may touch the pointer
 * table: owner-only definer policy); its body names no crewflow-owned table and calls no crewflow-owned function (R4).
 */
export const HWS_CUTOVER_DROP_NEW_SQL = `
CREATE FUNCTION core.hws_cutover_drop_new_statement_pointers(p_workspace_id uuid, p_subject_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_schema text := 'workspace_' || pg_catalog.replace(p_workspace_id::text, '-', '');
  v_n integer;
BEGIN
  ${POINTER_GUARD_SQL('pointers')};
  IF p_subject_ids IS NULL OR pg_catalog.cardinality(p_subject_ids) = 0 THEN
    RETURN 0;
  END IF;
  WITH d AS (
    DELETE FROM core.worker_dispatch_pointer w
     WHERE w.queue = 'statement' AND w.workspace_id = p_workspace_id AND w.source_schema = v_schema
       AND w.subject_id = ANY (p_subject_ids)
       AND NOT EXISTS (SELECT 1 FROM core.worker_dispatch_pointer c
                        WHERE c.queue = 'statement' AND c.subject_id = w.subject_id AND c.source_schema = 'core')
    RETURNING 1)
  SELECT pg_catalog.count(*)::integer INTO v_n FROM d;
  RETURN v_n;
END
$fn$`;

/**
 * (G) Review M-1 / M-2: once ONE workspace has verified and is about to be served from its schema, its core-source statement
 * pointers are dead (R2) and removed — the same rows F2_CUTOVER_SWEEP_SQL names. Called only for a workspace copied and
 * verified in the same run, right before its block is lifted.
 */
export const HWS_CUTOVER_PURGE_CORE_SQL = `
CREATE FUNCTION core.hws_cutover_purge_core_statement_pointers(p_workspace_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_schema text := 'workspace_' || pg_catalog.replace(p_workspace_id::text, '-', '');
  v_n integer;
BEGIN
  ${POINTER_GUARD_SQL('pointers')};
  WITH p AS (
    DELETE FROM core.worker_dispatch_pointer c
     WHERE c.queue = 'statement' AND c.workspace_id = p_workspace_id AND c.source_schema = 'core'
    RETURNING 1)
  SELECT pg_catalog.count(*)::integer INTO v_n FROM p;
  RETURN v_n;
END
$fn$`;

/** Creation order (the helpers before the definers that call them); all handed to crewflow. */
export const HWS_CUTOVER_CREWFLOW_FUNCTIONS_SQL: readonly string[] = [
  HWS_CUTOVER_SCHEMA_SQL,
  HWS_CUTOVER_SOURCE_SQL,
  HWS_CUTOVER_PROBE_SQL,
  HWS_CUTOVER_COPY_BATCH_SQL,
  HWS_CUTOVER_VERIFY_RANGE_SQL,
  HWS_CUTOVER_STARTED_ANY_SQL,
  HWS_CUTOVER_FENCE_FUNCTION_SQL,
];

/** Created as rab_secure_owner (after the two tables). */
export const HWS_CUTOVER_SECURE_FUNCTIONS_SQL: readonly string[] = [HWS_CUTOVER_DROP_NEW_SQL, HWS_CUTOVER_PURGE_CORE_SQL, HWS_CUTOVER_NEW_WORKSPACE_TRG_SQL];

/** Post-condition: owner | definer | config | EXECUTE grantees (sorted, '+'-joined; the owner's implicit right is not listed). */
export const HWS_CUTOVER_STATE_SQL = `
SELECT p.oid::pg_catalog.regprocedure::text AS fn,
       pg_catalog.pg_get_userbyid(p.proowner)::text || '|' || p.prosecdef::text || '|' || COALESCE(pg_catalog.array_to_string(p.proconfig, ';'), '') || '|' ||
       COALESCE((SELECT pg_catalog.string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END, '+'
                                               ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END)
                   FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner), '') AS state
  FROM pg_catalog.pg_proc p
 WHERE p.pronamespace = 'core'::pg_catalog.regnamespace AND p.proname LIKE 'hws\\_cutover\\_%'
 ORDER BY 1`;

const PINNED = 'search_path=pg_catalog, pg_temp';
const PINNED_LOCK = `${PINNED};lock_timeout=10s`;
/** search_path as PostgreSQL prints it when the function is outside search_path (it is pinned to pg_catalog, pg_temp). */
export const HWS_CUTOVER_EXPECTED_STATE: Readonly<Record<string, string>> = Object.freeze({
  'core.hws_cutover_copy_batch(uuid,text,text,integer)': `crewflow|true|${PINNED_LOCK}|`,
  'core.hws_cutover_core_fence()': `crewflow|false|${PINNED}|`,
  'core.hws_cutover_drop_new_statement_pointers(uuid,uuid[])': `rab_secure_owner|true|${PINNED}|crewflow`,
  'core.hws_cutover_probe(uuid)': `crewflow|true|${PINNED_LOCK}|`,
  'core.hws_cutover_purge_core_statement_pointers(uuid)': `rab_secure_owner|true|${PINNED}|crewflow`,
  'core.hws_cutover_schema(uuid)': `crewflow|false|${PINNED}|`,
  'core.hws_cutover_source_sql(text)': `crewflow|false|${PINNED}|`,
  'core.hws_cutover_started_any()': `crewflow|true|${PINNED}|crewflow_app`,
  'core.hws_cutover_new_workspace_trg()': `rab_secure_owner|true|${PINNED}|`,
  'core.hws_cutover_verify_range(uuid,text,text,integer)': `crewflow|true|${PINNED_LOCK}|`,
});

/** Pure: the differences between the observed state rows and the expectation (empty = as reviewed). */
export function hwsCutoverStateProblems(rows: ReadonlyArray<{ fn: string; state: string }>, expectPresent: boolean): string[] {
  const out: string[] = [];
  const seen = new Map(rows.map((r) => [r.fn, r.state]));
  if (!expectPresent) {
    for (const fn of seen.keys()) out.push(`${fn} still exists`);
    return out;
  }
  for (const [fn, state] of Object.entries(HWS_CUTOVER_EXPECTED_STATE)) {
    const got = seen.get(fn);
    if (got === undefined) out.push(`${fn} is missing`);
    else if (got !== state) out.push(`${fn}: expected ${state}, got ${got}`);
  }
  for (const fn of seen.keys()) if (!(fn in HWS_CUTOVER_EXPECTED_STATE)) out.push(`${fn} is not a reviewed C3 function`);
  return out;
}

/** Post-condition of the two tables (owner, RLS, policies, grants) and the triggers (one row of facts). */
export const HWS_CUTOVER_TABLE_FACTS_SQL = `
SELECT pg_catalog.pg_get_userbyid(c.relowner)::text AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
       (SELECT pg_catalog.string_agg(p.polname::text, ',' ORDER BY p.polname) FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies,
       pg_catalog.has_table_privilege('crewflow_app', c.oid, 'SELECT') AS app_select,
       (pg_catalog.has_table_privilege('crewflow_app', c.oid, 'INSERT') OR pg_catalog.has_table_privilege('crewflow_app', c.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege('crewflow_app', c.oid, 'DELETE') OR pg_catalog.has_table_privilege('crewflow_app', c.oid, 'TRUNCATE')) AS app_dml,
       (pg_catalog.has_table_privilege('crewflow', c.oid, 'DELETE') OR pg_catalog.has_table_privilege('crewflow', c.oid, 'TRUNCATE')) AS crewflow_delete,
       pg_catalog.pg_get_userbyid(a.relowner)::text AS activation_owner, a.relrowsecurity AS activation_rls, a.relforcerowsecurity AS activation_force,
       (SELECT pg_catalog.string_agg(p.polname::text, ',' ORDER BY p.polname) FROM pg_catalog.pg_policy p WHERE p.polrelid = a.oid) AS activation_policies,
       (pg_catalog.has_table_privilege('crewflow_app', a.oid, 'INSERT') OR pg_catalog.has_table_privilege('crewflow_app', a.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege('crewflow_app', a.oid, 'DELETE') OR pg_catalog.has_table_privilege('crewflow_app', a.oid, 'TRUNCATE')
        OR pg_catalog.has_table_privilege('crewflow', a.oid, 'UPDATE') OR pg_catalog.has_table_privilege('crewflow', a.oid, 'DELETE')
        OR pg_catalog.has_table_privilege('crewflow', a.oid, 'TRUNCATE')) AS activation_extra_dml,
       (SELECT pg_catalog.count(*)::int FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class x ON x.oid = t.tgrelid
         WHERE x.relnamespace = 'core'::pg_catalog.regnamespace AND t.tgname = '${HWS_CUTOVER_FENCE_TRIGGER}' AND t.tgenabled = 'O'
           AND t.tgfoid = 'core.hws_cutover_core_fence()'::pg_catalog.regprocedure) AS fences,
       (SELECT pg_catalog.count(*)::int FROM pg_catalog.pg_trigger t
         WHERE t.tgrelid = 'core.manager_workspace'::pg_catalog.regclass AND t.tgname = '${HWS_CUTOVER_NEW_WORKSPACE_TRIGGER}' AND t.tgenabled = 'O'
           AND t.tgfoid = 'core.hws_cutover_new_workspace_trg()'::pg_catalog.regprocedure) AS new_workspace_triggers
  FROM pg_catalog.pg_class c, pg_catalog.pg_class a
 WHERE c.oid = 'core.hws_cutover_state'::pg_catalog.regclass AND a.oid = 'core.hws_cutover_activation'::pg_catalog.regclass`;

export interface HwsCutoverTableFacts {
  owner: string;
  rls: boolean;
  force: boolean;
  policies: string;
  app_select: boolean;
  app_dml: boolean;
  crewflow_delete: boolean;
  activation_owner: string;
  activation_rls: boolean;
  activation_force: boolean;
  activation_policies: string;
  activation_extra_dml: boolean;
  fences: number;
  new_workspace_triggers: number;
}

export function hwsCutoverTableProblems(f: HwsCutoverTableFacts | undefined): string[] {
  if (!f) return ['core.hws_cutover_state / core.hws_cutover_activation missing'];
  const p: string[] = [];
  if (f.owner !== 'rab_secure_owner') p.push(`hws_cutover_state owner is ${f.owner}`);
  if (!f.rls || !f.force) p.push('hws_cutover_state RLS is not ENABLE + FORCE');
  const statePolicies = 'hws_cutover_state_crewflow_insert,hws_cutover_state_crewflow_read,hws_cutover_state_crewflow_update,hws_cutover_state_secure_owner_definer,hws_cutover_state_tenant_read';
  if (f.policies !== statePolicies) p.push(`hws_cutover_state policies are ${f.policies}`);
  if (!f.app_select || f.app_dml) p.push('crewflow_app must hold SELECT and no DML on hws_cutover_state');
  if (f.crewflow_delete) p.push('crewflow must hold no DELETE / TRUNCATE on hws_cutover_state');
  if (f.activation_owner !== 'rab_secure_owner') p.push(`hws_cutover_activation owner is ${f.activation_owner}`);
  if (!f.activation_rls || !f.activation_force) p.push('hws_cutover_activation RLS is not ENABLE + FORCE');
  if (f.activation_policies !== 'hws_cutover_activation_crewflow_insert,hws_cutover_activation_read') p.push(`hws_cutover_activation policies are ${f.activation_policies}`);
  if (f.activation_extra_dml) p.push('hws_cutover_activation must be insert-only for crewflow and read-only for crewflow_app');
  if (Number(f.fences) !== HWS_CUTOVER_TABLES.length) p.push(`${f.fences} fence trigger(s), expected ${HWS_CUTOVER_TABLES.length}`);
  if (Number(f.new_workspace_triggers) !== 1) p.push(`${f.new_workspace_triggers} new-workspace trigger(s), expected 1`);
  return p;
}
