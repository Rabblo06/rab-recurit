// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, function, role and column names, the closed table list); no request or row data reaches these templates. Inside the function bodies every identifier goes through format('%I') / quote_ident / regclass output, and every value through EXECUTE ... USING. Reviewed 2026-11-14 (C3, FOR OWNER REVIEW).
/**
 * OWNER-DB-ULTIMATE Part C3 (HWS cutover), option A′ — PENDING OWNER CHOICE (A′ vs B′) AND SQL REVIEW
 * (docs/plans/phase-x3/SQL-DRAFTS.md §3 and "FOR OWNER REVIEW — C3"). Runs only on throwaway databases until approved.
 *
 * The copy path for the 21 workspace-business tables from the `core` copies into each workspace's own schema, under the one
 * runtime login (`crewflow_owner`, never superuser / BYPASSRLS, §0.1) with FORCE ROW LEVEL SECURITY kept on everything (§0.2):
 *
 *   - FORCE RLS binds the table owner too, so a SECURITY DEFINER owned by `crewflow` (the owner of both copies) still sees only
 *     what the tenant policies show it, and the workspace INSERT policies refuse historical rows (an approved payroll record,
 *     a review written by someone else). Option A′ lifts FORCE on exactly the tables one call touches, INSIDE that call's
 *     transaction, under ACCESS EXCLUSIVE (no other session can read or write them meanwhile), restores FORCE and asserts it
 *     before returning. Any error aborts the transaction, so a NO FORCE state can never be committed.
 *   - Callable only on the locked migration session (the Part B migration lock held by THIS backend), with the tenant bound
 *     to exactly the named workspace, for a READY workspace whose registry schema is its derived name. Closed table list: no
 *     caller text reaches SQL except a table name that passed the list check.
 *   - CHECK constraints (money, `<table>_workspace_bound`), FKs and triggers stay on. `payroll_record_guard` is BEFORE UPDATE
 *     only; the statement-pointer INSERT trigger fires and is reconciled by hws_cutover_reconcile_statement_pointers (Q13).
 *   - Copy = INSERT ... ON CONFLICT DO NOTHING: idempotent, resumable, never an UPDATE or DELETE of either copy
 *     (attendance_correction stays insert-only; the core copies are never written).
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
  'core.hws_cutover_reconcile_statement_pointers(uuid,boolean)',
] as const;

/**
 * (0a) Guard shared by the crewflow definers (SECURITY INVOKER: it runs as the calling definer, i.e. crewflow). Returns the
 * workspace's schema name or raises: 42501 no migration lock on this backend / tenant not this workspace; 55000 not READY or
 * not the derived name. The lock key is the single-bigint 0x637265776d696772 ("crewmigr", migration-lock.ts), which pg_locks
 * spells classid 1668441463, objid 1835624306, objsubid 1.
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
 *   - 20 tables: `core.<t> WHERE workspace_id = $1`.
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
  RETURN pg_catalog.format('SELECT c.*, pg_catalog.to_jsonb(c) AS j FROM core.%I c WHERE c.workspace_id = $1::uuid', p_table);
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
         pg_catalog.string_agg('$2[' || u.o || ']', ', ' ORDER BY u.o),
         pg_catalog.string_agg('$3[' || u.o || ']', ', ' ORDER BY u.o)
    INTO v_ckeys, v_wkeys, v_ktext, v_after_ref, v_upto_ref
    FROM pg_catalog.unnest(v_keys) WITH ORDINALITY AS u(k, o);
  v_src := core.hws_cutover_source_sql(p_table)`;

/**
 * (A) One keyset batch of one table, core → the workspace's own schema. Returns rows inserted (copied), source rows read in
 * this batch (read_rows; fewer than p_limit = the table is done) and the last key read (`k1` or `k1|k2`), to pass back as
 * p_after. Original ids and every value at full precision (jsonb_populate_record against the TARGET row type, the same
 * conversion hws:backfill uses); generated columns are recomputed by PostgreSQL.
 */
export const HWS_CUTOVER_COPY_BATCH_SQL = `
CREATE FUNCTION core.hws_cutover_copy_batch(p_workspace_id uuid, p_table text, p_after text, p_limit integer)
RETURNS TABLE (copied integer, read_rows integer, last_key text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
AS $fn$
DECLARE
  v_schema    text;
  v_keys      text[];
  v_after     uuid[];
  v_ckeys     text;
  v_wkeys     text;
  v_ktext     text;
  v_after_ref text;
  v_upto_ref  text;
  v_src       text;
  v_cols      text;
  v_sel       text;
  v_rels      pg_catalog.regclass[];
  v_rel       pg_catalog.regclass;
  v_ok        boolean;
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
       RETURNING 1)
     SELECT (SELECT pg_catalog.count(*) FROM ins)::integer,
            (SELECT pg_catalog.count(*) FROM src)::integer,
            (SELECT s.k FROM src s ORDER BY s.rn DESC LIMIT 1)',
    v_ktext, v_ckeys, v_src, v_after_ref, v_schema, p_table, v_cols, v_sel)
    INTO copied, read_rows, last_key
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
  v_schema    text;
  v_keys      text[];
  v_after     uuid[];
  v_upto      uuid[];
  v_ckeys     text;
  v_wkeys     text;
  v_ktext     text;
  v_after_ref text;
  v_upto_ref  text;
  v_src       text;
  v_n         integer;
  v_upto_text text;
  v_pence     text;
  v_minutes   text;
  v_rels      pg_catalog.regclass[];
  v_rel       pg_catalog.regclass;
  v_ok        boolean;
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
 * (C) Pre-check of one workspace, all 21 tables in one call: whether the core copy holds rows of W (core_rows) and whether
 * W's own table already holds rows (ws_rows). On the user_note row: ambiguous_notes = notes of the organisation whose subject
 * has a profile in W AND another profile (they cannot be mapped to exactly one workspace: the copy skips them, the C3 command
 * refuses W), unmapped_notes = notes of the organisation whose subject has no profile at all (they belong to no workspace;
 * reported, never copied). Lifts FORCE on all 43 relations at once (ACCESS EXCLUSIVE on each until the transaction ends).
 */
export const HWS_CUTOVER_PROBE_SQL = `
CREATE FUNCTION core.hws_cutover_probe(p_workspace_id uuid)
RETURNS TABLE (table_name text, core_rows boolean, ws_rows boolean, ambiguous_notes integer, unmapped_notes integer)
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
    END IF;
    RETURN NEXT;
  END LOOP;
  ${RESTORE_SQL};
END
$fn$`;

/**
 * (D) Q13 / Q6: statement dispatch pointers. Since StatementPointerPhysicalIdentity1786721350000 a pointer's key is
 * (queue, subject_id, source_schema), so a copied approved payroll_record with no statement gets a NEW workspace-source
 * pointer, due now, from its INSERT trigger (worker-dispatch-pointer-sql.ts F2_STATEMENT_TRIGGER_FUNCTION_SQL). The copy must
 * create no new due work: a workspace-source pointer is kept only when its core twin had one. p_purge_core (only once the
 * whole cutover has verified, HWS on from then): the core-source pointers of W are dead (R2) and removed, the same rows
 * F2_CUTOVER_SWEEP_SQL names. Owned by rab_secure_owner (only it may touch the pointer table: owner-only definer policy); its
 * body names no crewflow-owned table and calls no crewflow-owned function (R4, secure-owner-invariants.ts), hence the inline
 * lock check and no registry read: the schema name is derived and must exist.
 */
export const HWS_CUTOVER_RECONCILE_SQL = `
CREATE FUNCTION core.hws_cutover_reconcile_statement_pointers(p_workspace_id uuid, p_purge_core boolean)
RETURNS TABLE (dropped_new integer, purged_core integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_schema text := 'workspace_' || pg_catalog.replace(p_workspace_id::text, '-', '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks l
                  WHERE l.locktype = 'advisory' AND l.pid = pg_catalog.pg_backend_pid() AND l.granted
                    AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
                    AND l.classid = 1668441463::oid AND l.objid = 1835624306::oid AND l.objsubid = 1) THEN
    RAISE EXCEPTION 'hws cutover pointers: the migration lock is not held by this session' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NULL OR p_purge_core IS NULL OR core.current_workspace() IS DISTINCT FROM p_workspace_id
     OR pg_catalog.to_regnamespace(v_schema) IS NULL THEN
    RAISE EXCEPTION 'hws cutover pointers: tenant context is not this workspace, or no such schema' USING ERRCODE = '42501';
  END IF;
  WITH d AS (
    DELETE FROM core.worker_dispatch_pointer w
     WHERE w.queue = 'statement' AND w.workspace_id = p_workspace_id AND w.source_schema = v_schema
       AND NOT EXISTS (SELECT 1 FROM core.worker_dispatch_pointer c
                        WHERE c.queue = 'statement' AND c.subject_id = w.subject_id AND c.source_schema = 'core')
    RETURNING 1)
  SELECT pg_catalog.count(*)::integer INTO dropped_new FROM d;
  purged_core := 0;
  IF p_purge_core THEN
    WITH p AS (
      DELETE FROM core.worker_dispatch_pointer c
       WHERE c.queue = 'statement' AND c.workspace_id = p_workspace_id AND c.source_schema = 'core'
      RETURNING 1)
    SELECT pg_catalog.count(*)::integer INTO purged_core FROM p;
  END IF;
  RETURN NEXT;
END
$fn$`;

/** Creation order (the helpers before the definers that call them). */
export const HWS_CUTOVER_CREWFLOW_FUNCTIONS_SQL: readonly string[] = [
  HWS_CUTOVER_SCHEMA_SQL,
  HWS_CUTOVER_SOURCE_SQL,
  HWS_CUTOVER_PROBE_SQL,
  HWS_CUTOVER_COPY_BATCH_SQL,
  HWS_CUTOVER_VERIFY_RANGE_SQL,
];

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

/** search_path as PostgreSQL prints it when the function is outside search_path (it is pinned to pg_catalog, pg_temp). */
export const HWS_CUTOVER_EXPECTED_STATE: Readonly<Record<string, string>> = Object.freeze({
  'core.hws_cutover_copy_batch(uuid,text,text,integer)': 'crewflow|true|search_path=pg_catalog, pg_temp;lock_timeout=10s|',
  'core.hws_cutover_probe(uuid)': 'crewflow|true|search_path=pg_catalog, pg_temp;lock_timeout=10s|',
  'core.hws_cutover_reconcile_statement_pointers(uuid,boolean)': 'rab_secure_owner|true|search_path=pg_catalog, pg_temp|crewflow',
  'core.hws_cutover_schema(uuid)': 'crewflow|false|search_path=pg_catalog, pg_temp|',
  'core.hws_cutover_source_sql(text)': 'crewflow|false|search_path=pg_catalog, pg_temp|',
  'core.hws_cutover_verify_range(uuid,text,text,integer)': 'crewflow|true|search_path=pg_catalog, pg_temp;lock_timeout=10s|',
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
