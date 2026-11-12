// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, function, role and policy names, numeric limits) or a validated identifier; no request or row data reaches these templates. Reviewed 2026-11-04 (owner-login SQL-injection lint).
/**
 * Phase 0b (E1, R6): catalog invariants that keep `rab_secure_owner` (NOLOGIN; owns the pre-auth tables and their SECURITY
 * DEFINER functions) from executing or depending on anything a LOGIN role controls. Read-only catalog queries; used by the
 * migration self-check (SecureOwnerCoreSchemaAndHelpers1786721100000) and by
 * `phase0b-secure-owner.integration.spec.ts`, so a later migration that reintroduces the pattern fails CI.
 *
 * What "reachable from rab_secure_owner" means here (every one of these runs with rab_secure_owner's privileges, or
 * decides what a NOT-FORCE secure table shows or stores):
 *   - every SECURITY DEFINER function rab_secure_owner owns;
 *   - every function a table rab_secure_owner owns depends on: trigger functions, policy expressions, column defaults and
 *     generated columns (pg_attrdef), CHECK / other constraints, index expressions and rules (pg_depend);
 *   - transitively, every `core` function named in the body of a reached function (`name(`), or recorded as a dependency
 *     of it (SQL-standard bodies).
 * Each reached `core` function must be owned by rab_secure_owner (pg_catalog built-ins and extension members excluded).
 * Function labels are `schema.name(argument types)` built from the catalog, never `regprocedure::text`, so the result does
 * not depend on the session search_path (a migration session, a pooled app session and a superuser psql must agree).
 *
 * Not covered, and therefore frozen as reviewed lists that fail on any change:
 *   - R4: `crewflow`-owned tables that rab_secure_owner definers read or write. Their owner (crewflow) can attach policies,
 *     triggers, RULEs, column DEFAULTs and CHECK constraints to them, and every one of those expressions runs as
 *     rab_secure_owner when a definer touches the table — including expressions that read any table through SPI. So R4
 *     means crewflow can still read (and write) as rab_secure_owner: E1 is PARTIALLY mitigated, not resolved. Accepted
 *     until `crewflow` stops being a runtime login (E6 / Phase B); the list may only shrink by an owner-reviewed change.
 *   - functions it owns (definers, and since Phase D wave 2 invoker helpers too) that use dynamic SQL (`EXECUTE`), whose
 *     targets a text scan cannot follow.
 * Also outside these checks (recorded as open findings H2 / H3, separate remediation): the database owner (database-level
 * settings such as search_path, and CREATE on `public`) and the owner of the extensions (`citext`, `pgcrypto`, ...) whose
 * functions and operators the definers call.
 */

/** R4 — frozen 2026-10-28 (Phase 0b). Any difference, addition or removal, fails until reviewed. */
export const R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS: readonly string[] = [
  'ai_usage_daily',
  'audit_log',
  'host_label_claim',
  'manager_profile',
  'organisation_ai_setting',
  'platform_config',
  'reserved_host_label',
  'role',
  'user_role',
  'workspace_membership',
  'workspace_schema_registry',
];

/**
 * Phase D, review findings E-2 + N-1 (owner-approved 2026-11-01): each pointer trigger function binds itself to its
 * ONE table with `TG_TABLE_NAME IS DISTINCT FROM '<table>'`, so its body names that crewflow-owned table as a string literal
 * (a comparison with TG_TABLE_NAME, which never touches the table). Exempted from R4 as EXACT (function, table) PAIRS — never
 * by table name: any other rab_secure_owner definer naming one of these tables is still `r4-table-added`, and the frozen R4
 * list itself is unchanged. Each pair is REQUIRED once its function exists with its live body (the binding must not be
 * dropped silently); before its migration, or after 1786721320000.down() made the statement function inert, it is absent.
 */
export const R4_PHASE_D_TRIGGER_PAIRS: ReadonlyArray<{ fn: string; table: string }> = [
  { fn: 'worker_dispatch_pointer_email_trg', table: 'email_outbox' },
  { fn: 'worker_dispatch_pointer_push_trg', table: 'push_delivery' },
  { fn: 'worker_dispatch_pointer_realtime_trg', table: 'realtime_event' },
  { fn: 'worker_dispatch_pointer_statement_trg', table: 'payroll_record' },
];
const R4_PAIR_VALUES = R4_PHASE_D_TRIGGER_PAIRS.map((x) => `('${x.fn}', '${x.table}')`).join(', ');

/**
 * Phase D (reviewed and approved with migrations 1786721310000 / 1786721320000): every place a rab_secure_owner
 * function may fire as a trigger on a table rab_secure_owner does NOT own. Such a function evaluates rows of a table a LOGIN
 * role owns, as rab_secure_owner — the R4 class (their own-table literal is exempted per pair: R4_PHASE_D_TRIGGER_PAIRS). Checked
 * ONE way: an attachment missing from this list fails (e.g. crewflow attaching the statement function, on which it holds
 * EXECUTE, to a table of its own); a listed attachment that does not exist yet does not (the migrations add them one by
 * one). `table` is the exact table name; `workspaceCopies` also admits it in every `workspace_<32 hex>` schema; trigger names are
 * exact.
 */
export const REVIEWED_SECURE_TRIGGER_ATTACHMENTS: ReadonlyArray<{ fn: string; table: string; workspaceCopies: boolean; triggers: readonly string[] }> = [
  // Pre-existing (AuditLogRecordedIdentityOrganisationCheck1786719610000), found by this check on main's schema (rab_c1d,
  // read-only catalog query, 2026-10-31): the only such attachment before Phase D.
  {
    fn: 'core.audit_log_enforce_recorded_identities()',
    table: 'audit_log',
    workspaceCopies: false,
    triggers: ['audit_log_recorded_identities'],
  },
  {
    fn: 'core.worker_dispatch_pointer_email_trg()',
    table: 'email_outbox',
    workspaceCopies: false,
    triggers: ['email_outbox_dispatch_pointer_del', 'email_outbox_dispatch_pointer_ins', 'email_outbox_dispatch_pointer_trunc', 'email_outbox_dispatch_pointer_upd'],
  },
  {
    fn: 'core.worker_dispatch_pointer_push_trg()',
    table: 'push_delivery',
    workspaceCopies: false,
    triggers: ['push_delivery_dispatch_pointer_del', 'push_delivery_dispatch_pointer_ins', 'push_delivery_dispatch_pointer_trunc', 'push_delivery_dispatch_pointer_upd'],
  },
  {
    fn: 'core.worker_dispatch_pointer_realtime_trg()',
    table: 'realtime_event',
    workspaceCopies: false,
    triggers: ['realtime_event_dispatch_pointer_del', 'realtime_event_dispatch_pointer_ins', 'realtime_event_dispatch_pointer_trunc', 'realtime_event_dispatch_pointer_upd'],
  },
  {
    fn: 'core.worker_dispatch_pointer_statement_trg()',
    table: 'payroll_record',
    workspaceCopies: true,
    triggers: ['payroll_record_statement_pointer_del', 'payroll_record_statement_pointer_ins', 'payroll_record_statement_pointer_trunc', 'payroll_record_statement_pointer_upd'],
  },
];

/**
 * Every non-internal trigger whose function rab_secure_owner owns, on a table it does not own — the function in ANY schema
 * (Phase D wave 2: a rab_secure_owner function in another schema, e.g. a same-named `public.worker_dispatch_pointer_*_trg()`,
 * was not listed at all before). `fn` carries the function's real schema, so only the reviewed `core.` functions match.
 */
export const SECURE_TRIGGERS_ON_FOREIGN_TABLES_SQL = `
SELECT pg_catalog.format('%s.%s()', pn.nspname, p.proname) AS fn, n.nspname AS sch, c.relname AS tbl, t.tgname AS trg
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
  JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT t.tgisinternal AND p.proowner = 'rab_secure_owner'::regrole AND c.relowner <> 'rab_secure_owner'::regrole
 ORDER BY 1, 2, 3, 4`;

/**
 * rab_secure_owner-owned functions that use dynamic SQL — reviewed 2026-10-28 (Phase 0b). Since Phase D wave 2 the scan
 * covers every function rab_secure_owner owns, not only DEFINERs: an INVOKER helper it owns runs as rab_secure_owner whenever
 * a definer calls it, so its dynamic SQL is the definer's (no new entry: the catalog had none, rab_c1d 2026-11-01).
 */
export const REVIEWED_DYNAMIC_SQL_SECURE_DEFINERS: readonly string[] = [
  // Builds `workspace_<32 hex>` from a validated uuid (format %I): CREATE SCHEMA ... AUTHORIZATION rab_secure_owner + grants.
  'core.provision_workspace_schema(pg_catalog.uuid)',
];

/**
 * `schema.name(schema.type, ...)` for pg_proc alias `p`, every part read from the catalog: identical in any session,
 * whatever its search_path (independent review N2: format_type / regprocedure omit the schema of visible names).
 */
const fnLabel = (p: string) =>
  `pg_catalog.format('%s.%s(%s)', (SELECT pn.nspname FROM pg_catalog.pg_namespace pn WHERE pn.oid = ${p}.pronamespace), ${p}.proname,
     (SELECT pg_catalog.string_agg(tn.nspname || '.' || t.typname, ', ' ORDER BY a.ord)
        FROM unnest(${p}.proargtypes::pg_catalog.oid[]) WITH ORDINALITY a(typ, ord)
        JOIN pg_catalog.pg_type t ON t.oid = a.typ JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace))`;

/**
 * Functions a secure table depends on, through any object attached to it (pg_depend `classid` of that object). M2-F4:
 * each attachment kind is joined FROM the secure tables (column defaults / generated columns, constraints, rules, the
 * table itself, its indexes), instead of scanning every function dependency in the database and looking each one up.
 * Same five kinds, same dependency direction, same output; proven equal to the Phase 0b form by
 * secure-owner-invariants-equivalence.integration.spec.ts.
 */
const attachedToSecureTable = `
  SELECT d.refobjid FROM pg_catalog.pg_attrdef ad JOIN secure_tables s ON s.oid = ad.adrelid
    JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_attrdef'::regclass AND d.objid = ad.oid
                               AND d.refclassid = 'pg_catalog.pg_proc'::regclass
  UNION
  SELECT d.refobjid FROM pg_catalog.pg_constraint co JOIN secure_tables s ON s.oid = co.conrelid
    JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_constraint'::regclass AND d.objid = co.oid
                               AND d.refclassid = 'pg_catalog.pg_proc'::regclass
  UNION
  SELECT d.refobjid FROM pg_catalog.pg_rewrite rw JOIN secure_tables s ON s.oid = rw.ev_class
    JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.objid = rw.oid
                               AND d.refclassid = 'pg_catalog.pg_proc'::regclass
  UNION
  SELECT d.refobjid FROM secure_tables s
    JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = s.oid
                               AND d.refclassid = 'pg_catalog.pg_proc'::regclass
  UNION
  SELECT d.refobjid FROM pg_catalog.pg_index ix JOIN secure_tables s ON s.oid = ix.indrelid
    JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = ix.indexrelid
                               AND d.refclassid = 'pg_catalog.pg_proc'::regclass`;

/** One violation per row: `kind|object|detail`. Zero rows = every reachability / ownership / search_path invariant holds. */
export const SECURE_OWNER_INVARIANT_VIOLATIONS_SQL = `
WITH RECURSIVE
core_fn AS MATERIALIZED (
  SELECT p.oid, p.proname FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'core'::regnamespace
),
secure_tables AS (
  SELECT c.oid FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'core'::regnamespace AND c.relkind IN ('r', 'p') AND c.relowner = 'rab_secure_owner'::regrole
),
seed AS (
  SELECT p.oid FROM pg_catalog.pg_proc p WHERE p.proowner = 'rab_secure_owner'::regrole AND p.prosecdef
  UNION
  SELECT t.tgfoid FROM pg_catalog.pg_trigger t JOIN secure_tables s ON s.oid = t.tgrelid WHERE NOT t.tgisinternal
  UNION
  SELECT d.refobjid FROM pg_catalog.pg_policy pol JOIN secure_tables s ON s.oid = pol.polrelid
    JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_policy'::regclass AND d.objid = pol.oid
                               AND d.refclassid = 'pg_catalog.pg_proc'::regclass
  UNION
  -- column defaults and generated columns, constraints, rules and index expressions on secure tables (review M1)
  ${attachedToSecureTable}
),
reach(oid) AS (
  -- M2-F4: driven from the worktable through LATERAL, so only REACHED callers are examined. The Phase 0b form joined every
  -- pg_proc row to every core function under the regex first, and the planner flipped to that plan (~30 s) on any
  -- database with a few workspace schemas. Same two edge kinds (name( in the body, or a proc -> proc pg_depend edge), same
  -- self-exclusion.
  SELECT oid FROM seed
  UNION
  SELECT callee.oid
    FROM reach r JOIN pg_catalog.pg_proc caller ON caller.oid = r.oid
    CROSS JOIN LATERAL (
      SELECT cf.oid FROM core_fn cf
       WHERE cf.oid <> caller.oid AND caller.prosrc ~ ('\\m' || cf.proname || '\\s*\\(')
      UNION
      SELECT d.refobjid FROM pg_catalog.pg_depend d JOIN core_fn cf ON cf.oid = d.refobjid
       WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = caller.oid
         AND d.refclassid = 'pg_catalog.pg_proc'::regclass AND d.refobjid <> caller.oid
    ) callee
),
violations AS (
  -- 1. Reachability: every reached core function is owned by rab_secure_owner.
  SELECT 'reachable-function-owner' AS kind, ${fnLabel('p')} AS object, pg_catalog.pg_get_userbyid(p.proowner) AS detail
    FROM reach r JOIN pg_catalog.pg_proc p ON p.oid = r.oid
   WHERE p.pronamespace = 'core'::regnamespace AND p.proowner <> 'rab_secure_owner'::regrole
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend e
                      WHERE e.classid = 'pg_catalog.pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e')
  UNION ALL
  -- 2. Schema core: owned by a NOLOGIN, non-superuser role.
  SELECT 'core-schema-owner', 'core', r.rolname
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
   WHERE n.nspname = 'core' AND (r.rolcanlogin OR r.rolsuper)
  UNION ALL
  -- 3. No runtime LOGIN role may create objects in core. Superusers and the migration identity (a member of
  --    rab_secure_owner by design: CF-41 bootstrap / crewflow_migrator) are excluded here; check 7 forbids the runtime
  --    logins from ever being such a member.
  SELECT 'core-create', 'core', r.rolname
    FROM pg_catalog.pg_roles r
   WHERE r.rolcanlogin AND NOT r.rolsuper AND NOT pg_catalog.pg_has_role(r.oid, 'rab_secure_owner', 'USAGE')
     AND pg_catalog.has_schema_privilege(r.oid, 'core'::regnamespace, 'CREATE')
  UNION ALL
  -- 4. Definer search_path: set, pg_catalog first, pg_temp last.
  SELECT 'definer-search-path', ${fnLabel('p')}, coalesce(sp.cfg, '<unset>')
    FROM pg_catalog.pg_proc p
    LEFT JOIN LATERAL (SELECT c AS cfg FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') sp ON true
   WHERE p.prosecdef AND p.pronamespace = 'core'::regnamespace
     AND (sp.cfg IS NULL OR sp.cfg !~ '^search_path=pg_catalog(,|$)' OR sp.cfg !~ '(^|, )pg_temp$')
  UNION ALL
  -- 5. No schema named in a definer search_path is writable by a non-superuser LOGIN role.
  SELECT 'definer-search-path-writable', ${fnLabel('p')}, s.elem || ' by ' || r.rolname
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL (SELECT c FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') sp(cfg)
    CROSS JOIN LATERAL (SELECT pg_catalog.btrim(e, '"') FROM unnest(pg_catalog.string_to_array(substring(sp.cfg FROM 13), ', ')) e) s(elem)
    JOIN pg_catalog.pg_namespace n ON n.nspname = s.elem
    JOIN pg_catalog.pg_roles r ON r.rolcanlogin AND NOT r.rolsuper AND NOT pg_catalog.pg_has_role(r.oid, 'rab_secure_owner', 'USAGE')
   WHERE p.prosecdef AND p.pronamespace = 'core'::regnamespace AND s.elem NOT IN ('pg_catalog', 'pg_temp')
     AND pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE')
  UNION ALL
  -- 6. No LOGIN role owns a rab_secure_owner-reachable object: secure tables' and definers' owner is NOLOGIN.
  SELECT 'secure-owner-login', 'rab_secure_owner', 'LOGIN or SUPERUSER or BYPASSRLS'
    FROM pg_catalog.pg_roles r WHERE r.rolname = 'rab_secure_owner' AND (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls)
  UNION ALL
  -- 7. The runtime logins never act as rab_secure_owner (CF-41 / assert-runtime-db-role.ts, re-asserted in the catalog).
  --    Phase D: crewflow_worker (the Worker's login) is a runtime login too.
  SELECT 'runtime-member-of-secure-owner', r.rolname, 'member of rab_secure_owner'
    FROM pg_catalog.pg_roles r
   WHERE r.rolname IN ('crewflow', 'crewflow_app', 'crewflow_worker')
     AND (pg_catalog.pg_has_role(r.oid, 'rab_secure_owner', 'USAGE') OR pg_catalog.pg_has_role(r.oid, 'rab_secure_owner', 'SET'))
  UNION ALL
  -- 8. Phase D: nothing but superusers may act as crewflow_worker (a member would inherit the Worker-only claim grants —
  --    the API login above all), and crewflow_worker itself never reaches crewflow (an owner of the source tables).
  SELECT 'member-of-worker', m.rolname, 'member of crewflow_worker'
    FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles m ON m.oid = a.member
   WHERE a.roleid = (SELECT w.oid FROM pg_catalog.pg_roles w WHERE w.rolname = 'crewflow_worker')
  UNION ALL
  SELECT 'worker-reaches-owner', r.rolname, 'can use or SET ROLE to crewflow'
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = 'crewflow_worker'
     AND (pg_catalog.pg_has_role(r.oid, 'crewflow', 'USAGE') OR pg_catalog.pg_has_role(r.oid, 'crewflow', 'SET'))
)
SELECT kind || '|' || object || '|' || detail AS line FROM violations ORDER BY 1`;

/**
 * R4 set as it stands: crewflow-owned (non-rab_secure_owner) core tables named in the body of a function rab_secure_owner
 * owns — a DEFINER, or (Phase D wave 2) an INVOKER helper, which runs as rab_secure_owner whenever a definer calls it (no
 * change to the frozen list: the only such helper naming one, current_role_name(), names `role`, already listed).
 * Phase D pairs (N-1, tightened in wave 2): for a reviewed pair — the core, no-argument function of that exact name and its
 * own table — ONLY the exact binding literal `TG_TABLE_NAME IS DISTINCT FROM '<table>'` is ignored; any other mention of
 * that table in the same body (a read, a write, another literal) is still `r4-table-added`. The name alone exempts nothing.
 */
export const R4_TABLES_SQL = `
SELECT DISTINCT c.relname
  FROM pg_catalog.pg_proc p, pg_catalog.pg_class c
 WHERE p.proowner = 'rab_secure_owner'::regrole
   AND c.relnamespace = 'core'::regnamespace AND c.relkind = 'r' AND c.relowner <> 'rab_secure_owner'::regrole
   AND CASE WHEN p.pronamespace = 'core'::regnamespace AND p.pronargs = 0 AND (p.proname::text, c.relname::text) IN (VALUES ${R4_PAIR_VALUES})
            THEN pg_catalog.replace(p.prosrc, 'TG_TABLE_NAME IS DISTINCT FROM ''' || c.relname || '''', '')
            ELSE p.prosrc
       END ~* ('\\m(core\\.)?"?' || c.relname || '"?\\M')
 ORDER BY 1`;

/**
 * N-1: reviewed pairs whose function exists (rab_secure_owner, core, no arguments) with its LIVE body (it writes the pointer
 * table) but no longer names its own table — the TG_TABLE_NAME binding was lost. Zero rows = every live pair is bound.
 */
export const R4_PHASE_D_MISSING_PAIRS_SQL = `
SELECT v.fn, v.tbl
  FROM (VALUES ${R4_PAIR_VALUES}) AS v(fn, tbl)
  JOIN pg_catalog.pg_proc p ON p.proname = v.fn AND p.pronamespace = 'core'::regnamespace AND p.pronargs = 0
 WHERE p.proowner = 'rab_secure_owner'::regrole
   AND pg_catalog.strpos(p.prosrc, 'worker_dispatch_pointer') > 0
   AND pg_catalog.strpos(p.prosrc, 'TG_TABLE_NAME IS DISTINCT FROM ''' || v.tbl || '''') = 0
 ORDER BY 1`;

/** rab_secure_owner functions (definers and invoker helpers, any schema) whose body runs dynamic SQL. */
export const DYNAMIC_SQL_SECURE_DEFINERS_SQL = `
SELECT ${fnLabel('p')} AS fn
  FROM pg_catalog.pg_proc p
 WHERE p.proowner = 'rab_secure_owner'::regrole AND p.prosrc ~* '\\mEXECUTE\\M'
 ORDER BY 1`;

type Query = (sql: string) => Promise<Array<Record<string, unknown>>>;

/** All violations, including drift of the two frozen lists. Empty array = all invariants hold. */
export async function secureOwnerInvariantViolations(query: Query): Promise<string[]> {
  const out = (await query(SECURE_OWNER_INVARIANT_VIOLATIONS_SQL)).map((r) => String(r.line));
  const diff = (label: string, actual: string[], frozen: readonly string[]) => {
    for (const a of actual) if (!frozen.includes(a)) out.push(`${label}-added|${a}|not in the reviewed list`);
    for (const f of frozen) if (!actual.includes(f)) out.push(`${label}-removed|${f}|reviewed list is stale`);
  };
  diff('r4-table', (await query(R4_TABLES_SQL)).map((r) => String(r.relname)), R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS);
  for (const r of await query(R4_PHASE_D_MISSING_PAIRS_SQL)) {
    out.push(`r4-phase-d-pair-missing|core.${String(r.fn)}()|its live body no longer binds itself to ${String(r.tbl)} (TG_TABLE_NAME)`);
  }
  diff('dynamic-sql-definer', (await query(DYNAMIC_SQL_SECURE_DEFINERS_SQL)).map((r) => String(r.fn)), REVIEWED_DYNAMIC_SQL_SECURE_DEFINERS);
  for (const r of await query(SECURE_TRIGGERS_ON_FOREIGN_TABLES_SQL)) {
    const [fn, sch, tbl, trg] = [String(r.fn), String(r.sch), String(r.tbl), String(r.trg)];
    const schemaOk = (a: { workspaceCopies: boolean }) => sch === 'core' || (a.workspaceCopies && /^workspace_[0-9a-f]{32}$/.test(sch));
    const ok = REVIEWED_SECURE_TRIGGER_ATTACHMENTS.some((a) => a.fn === fn && a.table === tbl && schemaOk(a) && a.triggers.includes(trg));
    if (!ok) out.push(`secure-trigger-attachment-added|${sch}.${tbl}.${trg}|${fn} fires as rab_secure_owner on a table it does not own; not in the reviewed list`);
  }
  return out;
}
