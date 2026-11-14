/**
 * OWNER-DB-ULTIMATE Part D: the read-only checks the workspace command runner runs inside each (workspace, command)
 * transaction and after it (D-RUNNER.md §4.1). Every statement is a constant; the only value is the target schema name,
 * always a bound parameter ($1). Nothing here writes.
 */

/**
 * Every `rab.*` setting the policies, functions and services read (grep of `'rab.` over packages/rab-server/src, 2026-11-14).
 * Checked by NAME with current_setting(name, true): custom placeholder settings may not be listed in pg_settings (review N3;
 * the integration spec records what each major does). pg_settings is still scanned for any other `rab.*` name.
 */
export const KNOWN_RAB_SETTINGS = [
  'rab.actor_type',
  'rab.admin_scope',
  'rab.ai_retention',
  'rab.ai_synthetic_marker',
  'rab.ai_usage_retention',
  'rab.organisation_id',
  'rab.role',
  'rab.team_shift_id',
  'rab.team_staff_id',
  'rab.test',
  'rab.upgrade_scope',
  'rab.user_id',
  'rab.workspace_id',
] as const;

const KNOWN_LIST = KNOWN_RAB_SETTINGS.map((n) => `('${n}')`).join(', ');

/** The non-empty rab.* settings of this session: the known names by current_setting, plus any other name pg_settings lists. */
// sql-injection-reviewed: KNOWN_LIST / RAB_SET_SQL are built only from the constant KNOWN_RAB_SETTINGS array of this file (plain rab.<snake> names); no runtime value is interpolated.
const RAB_SET_SQL = `COALESCE((SELECT pg_catalog.string_agg(x.name || '=' || x.value, ',' ORDER BY x.name) FROM (
    SELECT k.name, COALESCE(pg_catalog.current_setting(k.name, true), '') AS value FROM (VALUES ${KNOWN_LIST}) AS k(name)
    UNION
    SELECT s.name, COALESCE(s.setting, '') FROM pg_catalog.pg_settings s WHERE s.name LIKE 'rab.%') x
   WHERE x.value <> ''), '')`;

/** Layer 3: the session facts that must be unchanged by the command (same backend, transaction, role, every rab.*, path). */
// sql-injection-reviewed: KNOWN_LIST / RAB_SET_SQL are built only from the constant KNOWN_RAB_SETTINGS array of this file (plain rab.<snake> names); no runtime value is interpolated.
export const INVARIANTS_SQL = `SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.transaction_timestamp()::text AS tx,
  pg_catalog.current_setting('role') AS role, pg_catalog.current_setting('search_path') AS search_path,
  current_user::text AS who,
  COALESCE(pg_catalog.current_setting('rab.organisation_id', true), '') AS org,
  COALESCE(pg_catalog.current_setting('rab.workspace_id', true), '') AS ws,
  COALESCE(pg_catalog.current_setting('rab.upgrade_scope', true), '') AS scope,
  ${RAB_SET_SQL} AS rab`;

/**
 * Layer 4, counts: objects OUTSIDE the target schema (TOAST and temporary namespaces excluded), so a DROP elsewhere is seen
 * (a dropped row leaves no xmin). Internal (constraint) triggers are excluded: a foreign key of the target table to a core
 * table adds them on the referenced table.
 */
export const OUTSIDE_COUNTS_SQL = `WITH t AS (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname = $1),
o AS (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname <> $1 AND n.nspname !~ '^pg_(toast|temp_|toast_temp_)')
SELECT pg_catalog.concat_ws(',',
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_namespace n WHERE n.oid NOT IN (SELECT oid FROM t) AND n.nspname !~ '^pg_(temp_|toast_temp_)'),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace IN (SELECT oid FROM o)),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint k WHERE k.connamespace IN (SELECT oid FROM o)),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid WHERE c.relnamespace IN (SELECT oid FROM o)),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND c.relnamespace IN (SELECT oid FROM o)),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc f WHERE f.pronamespace IN (SELECT oid FROM o)),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_type y WHERE y.typnamespace IN (SELECT oid FROM o)),
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class WHERE c.relnamespace IN (SELECT oid FROM o))
) AS counts`;

/**
 * Layer 4, writes: catalog rows written by THIS transaction (REPEATABLE READ: `age(xmin) <= 0` is this transaction or one of
 * its subtransactions; a concurrent commit is not in the snapshot) that belong to anything outside the target schema. The
 * target's own TOAST relations and the internal RI triggers of the target's own constraints are allowed.
 */
export const OUTSIDE_WRITES_SQL = `WITH t AS (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname = $1),
inside AS (
  SELECT c.oid FROM pg_catalog.pg_class c WHERE c.relnamespace IN (SELECT oid FROM t)
  UNION ALL SELECT c.reltoastrelid FROM pg_catalog.pg_class c WHERE c.relnamespace IN (SELECT oid FROM t) AND c.reltoastrelid <> 0
  UNION ALL SELECT i.indexrelid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.reltoastrelid = i.indrelid
             WHERE c.relnamespace IN (SELECT oid FROM t) AND c.reltoastrelid <> 0),
w AS (
  SELECT 'schema ' || n.nspname AS what FROM pg_catalog.pg_namespace n WHERE pg_catalog.age(n.xmin) <= 0 AND n.oid NOT IN (SELECT oid FROM t)
  UNION ALL SELECT 'relation ' || c.oid::pg_catalog.regclass::text FROM pg_catalog.pg_class c WHERE pg_catalog.age(c.xmin) <= 0 AND c.oid NOT IN (SELECT oid FROM inside)
  UNION ALL SELECT 'column ' || a.attrelid::pg_catalog.regclass::text || '.' || a.attname FROM pg_catalog.pg_attribute a
             WHERE pg_catalog.age(a.xmin) <= 0 AND a.attrelid NOT IN (SELECT oid FROM inside)
  UNION ALL SELECT 'constraint ' || k.conname FROM pg_catalog.pg_constraint k WHERE pg_catalog.age(k.xmin) <= 0 AND k.connamespace NOT IN (SELECT oid FROM t)
  UNION ALL SELECT 'trigger ' || g.tgname FROM pg_catalog.pg_trigger g WHERE pg_catalog.age(g.xmin) <= 0 AND g.tgrelid NOT IN (SELECT oid FROM inside)
             AND NOT (g.tgisinternal AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.oid = g.tgconstraint AND k.connamespace IN (SELECT oid FROM t)))
  UNION ALL SELECT 'policy ' || p.polname FROM pg_catalog.pg_policy p WHERE pg_catalog.age(p.xmin) <= 0 AND p.polrelid NOT IN (SELECT oid FROM inside)
  UNION ALL SELECT 'function ' || f.proname FROM pg_catalog.pg_proc f WHERE pg_catalog.age(f.xmin) <= 0 AND f.pronamespace NOT IN (SELECT oid FROM t)
  UNION ALL SELECT 'type ' || y.typname FROM pg_catalog.pg_type y WHERE pg_catalog.age(y.xmin) <= 0 AND y.typnamespace NOT IN (SELECT oid FROM t)
  UNION ALL SELECT 'index ' || x.indexrelid::pg_catalog.regclass::text FROM pg_catalog.pg_index x WHERE pg_catalog.age(x.xmin) <= 0 AND x.indrelid NOT IN (SELECT oid FROM inside)
  UNION ALL SELECT 'default ' || d.adrelid::pg_catalog.regclass::text FROM pg_catalog.pg_attrdef d WHERE pg_catalog.age(d.xmin) <= 0 AND d.adrelid NOT IN (SELECT oid FROM inside)
  UNION ALL SELECT 'rule ' || r.rulename FROM pg_catalog.pg_rewrite r WHERE pg_catalog.age(r.xmin) <= 0 AND r.ev_class NOT IN (SELECT oid FROM inside)
  UNION ALL SELECT 'default privileges' FROM pg_catalog.pg_default_acl a WHERE pg_catalog.age(a.xmin) <= 0 AND a.defaclnamespace NOT IN (SELECT oid FROM t))
SELECT what FROM w LIMIT 10`;

/**
 * Layer 4b (security review M1), counters: this backend's write counters (pg_stat_xact_*) for every table outside the target
 * schema and for the role / database / publication catalogs. They are NOT per transaction on PostgreSQL 15+: writes of
 * earlier transactions stay in them until the backend flushes its statistics, which never happens inside a transaction block.
 * So the runner reads them at the start of the step transaction and again after the command, and refuses any INCREASE (a
 * re-bind + write of another workspace's or a core table's rows + restore; RESET ROLE + GRANT / CREATE ROLE / ALTER ROLE …
 * SET + SET ROLE back; a forged core.upgrade_migration row). Proven per major by the integration spec.
 */
export const OUTSIDE_WRITE_COUNTERS_SQL = `SELECT s.relid::text AS relid, s.schemaname || '.' || s.relname AS what,
       (s.n_tup_ins + s.n_tup_upd + s.n_tup_del)::text AS n
  FROM pg_catalog.pg_stat_xact_user_tables s WHERE s.schemaname <> $1 AND (s.n_tup_ins + s.n_tup_upd + s.n_tup_del) > 0
UNION ALL
SELECT s.relid::text, 'pg_catalog.' || s.relname, (s.n_tup_ins + s.n_tup_upd + s.n_tup_del)::text
  FROM pg_catalog.pg_stat_xact_sys_tables s
 WHERE s.relname IN ('pg_authid', 'pg_auth_members', 'pg_db_role_setting', 'pg_database', 'pg_largeobject_metadata', 'pg_publication', 'pg_publication_rel')
   AND (s.n_tup_ins + s.n_tup_upd + s.n_tup_del) > 0`;

/**
 * Layer 4b, xmin: the readable shared catalogs written by THIS transaction (age <= 0 under REPEATABLE READ); pg_authid is not
 * readable by the runtime login, so it is covered by the counters only. Plus pg_sequence of a sequence outside the target.
 */
export const OUTSIDE_DATA_WRITES_SQL = `WITH t AS (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname = $1),
w AS (
  SELECT 'catalog pg_auth_members' AS what FROM pg_catalog.pg_auth_members m WHERE pg_catalog.age(m.xmin) <= 0
  UNION ALL SELECT 'catalog pg_db_role_setting' FROM pg_catalog.pg_db_role_setting d WHERE pg_catalog.age(d.xmin) <= 0
  UNION ALL SELECT 'catalog pg_database' FROM pg_catalog.pg_database d WHERE pg_catalog.age(d.xmin) <= 0
  UNION ALL SELECT 'catalog pg_largeobject_metadata' FROM pg_catalog.pg_largeobject_metadata l WHERE pg_catalog.age(l.xmin) <= 0
  UNION ALL SELECT 'catalog pg_publication' FROM pg_catalog.pg_publication p WHERE pg_catalog.age(p.xmin) <= 0
  UNION ALL SELECT 'catalog pg_publication_rel' FROM pg_catalog.pg_publication_rel p WHERE pg_catalog.age(p.xmin) <= 0
  UNION ALL SELECT 'sequence ' || q.seqrelid::pg_catalog.regclass::text FROM pg_catalog.pg_sequence q JOIN pg_catalog.pg_class c ON c.oid = q.seqrelid
   WHERE pg_catalog.age(q.xmin) <= 0 AND c.relnamespace NOT IN (SELECT oid FROM t))
SELECT what FROM w LIMIT 10`;

/**
 * Layer 5a (security review M2): what the structural fingerprint (v1) does not hash, checked on the target: no rewrite rule
 * on any of its relations (the template has none), every relation permanent (relpersistence 'p'), no inheritance either way,
 * no relation kind beyond tables / indexes / sequences, no type other than the row types (and their arrays) of its own
 * tables and sequences, no operator.
 */
export const TARGET_EXTRA_STRUCTURE_SQL = `WITH t AS (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname = $1),
r AS (SELECT c.oid, c.relname, c.relkind, c.relpersistence FROM pg_catalog.pg_class c WHERE c.relnamespace IN (SELECT oid FROM t)),
w AS (
  SELECT 'rule ' || x.rulename AS what FROM pg_catalog.pg_rewrite x JOIN r ON r.oid = x.ev_class
  UNION ALL SELECT 'persistence ' || r.relname || '=' || r.relpersistence::text FROM r WHERE r.relpersistence <> 'p'
  UNION ALL SELECT 'relkind ' || r.relname || '=' || r.relkind::text FROM r WHERE r.relkind NOT IN ('r', 'i', 'S')
  UNION ALL SELECT 'inherits ' || i.inhrelid::pg_catalog.regclass::text FROM pg_catalog.pg_inherits i
   WHERE i.inhrelid IN (SELECT oid FROM r) OR i.inhparent IN (SELECT oid FROM r)
  UNION ALL SELECT 'type ' || y.typname FROM pg_catalog.pg_type y WHERE y.typnamespace IN (SELECT oid FROM t)
     AND NOT (y.typtype = 'c' AND EXISTS (SELECT 1 FROM r WHERE r.oid = y.typrelid AND r.relkind IN ('r', 'S')))
     AND NOT (y.typcategory = 'A' AND EXISTS (SELECT 1 FROM pg_catalog.pg_type e JOIN r ON r.oid = e.typrelid
                                               WHERE e.oid = y.typelem AND e.typtype = 'c' AND r.relkind IN ('r', 'S')))
  UNION ALL SELECT 'operator ' || o.oprname FROM pg_catalog.pg_operator o WHERE o.oprnamespace IN (SELECT oid FROM t))
SELECT what FROM w LIMIT 10`;

/** L2: after COMMIT / ROLLBACK the session must carry nothing: no role, current_user = session_user, every rab.* empty. */
// sql-injection-reviewed: KNOWN_LIST / RAB_SET_SQL are built only from the constant KNOWN_RAB_SETTINGS array of this file (plain rab.<snake> names); no runtime value is interpolated.
export const SESSION_CLEAN_SQL = `SELECT pg_catalog.current_setting('role') AS role, (current_user = session_user) AS same_user,
  pg_catalog.current_setting('search_path') AS search_path,
  ${RAB_SET_SQL} AS rab,
  COALESCE((SELECT pg_catalog.string_agg(l.classid::text || '/' || l.objid::text || '/' || l.objsubid::text || '/' || l.mode, ',' ORDER BY 1)
              FROM pg_catalog.pg_locks l WHERE l.locktype = 'advisory' AND l.pid = pg_catalog.pg_backend_pid() AND l.granted), '') AS advisory`;

/** L2 recovery: clear what a command left at session level (role, every rab.*), after the step was refused. */
// sql-injection-reviewed: KNOWN_LIST / RAB_SET_SQL are built only from the constant KNOWN_RAB_SETTINGS array of this file (plain rab.<snake> names); no runtime value is interpolated.
export const SESSION_RESET_SQL = `SELECT pg_catalog.set_config('role', 'none', false),
  (SELECT pg_catalog.count(pg_catalog.set_config(x.name, '', false)) FROM (
     SELECT k.name FROM (VALUES ${KNOWN_LIST}) AS k(name) UNION SELECT s.name FROM pg_catalog.pg_settings s WHERE s.name LIKE 'rab.%') x)`;

/**
 * N4: release ONE hold of every session-level advisory lock this backend holds that is not in the baseline (the comma list of
 * classid/objid/objsubid/mode taken at the start of the run, $1). Run repeatedly by the runner until none is left (a lock taken
 * twice needs two releases). objsubid 1 = a bigint key, 2 = an int4 pair.
 */
export const RELEASE_EXTRA_ADVISORY_SQL = `SELECT pg_catalog.count(CASE
    WHEN l.objsubid = 1 AND l.mode = 'ShareLock' THEN pg_catalog.pg_advisory_unlock_shared((l.classid::bigint << 32) | l.objid::bigint)
    WHEN l.objsubid = 1 THEN pg_catalog.pg_advisory_unlock((l.classid::bigint << 32) | l.objid::bigint)
    WHEN l.mode = 'ShareLock' THEN pg_catalog.pg_advisory_unlock_shared(((l.classid::bigint + 2147483648) % 4294967296 - 2147483648)::int,
                                                                       ((l.objid::bigint + 2147483648) % 4294967296 - 2147483648)::int)
    ELSE pg_catalog.pg_advisory_unlock(((l.classid::bigint + 2147483648) % 4294967296 - 2147483648)::int,
                                       ((l.objid::bigint + 2147483648) % 4294967296 - 2147483648)::int) END) AS released
  FROM pg_catalog.pg_locks l
 WHERE l.locktype = 'advisory' AND l.pid = pg_catalog.pg_backend_pid() AND l.granted
   AND NOT (l.classid::text || '/' || l.objid::text || '/' || l.objsubid::text || '/' || l.mode) = ANY(pg_catalog.string_to_array($1, ','))`;

/** N1: the M1 write counters exist only while statistics are collected. */
export const TRACK_COUNTS_SQL = `SELECT pg_catalog.current_setting('track_counts') AS track_counts`;
