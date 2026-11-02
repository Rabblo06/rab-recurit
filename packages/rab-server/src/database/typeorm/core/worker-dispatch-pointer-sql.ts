/**
 * Phase D (D1/D2/D5/D8) — the SQL of migrations 1786721300000 … 1786721340000, kept as DATA so the exact statements can be
 * shown for owner approval (docs/plans/PHASE-D-SQL-GATE.md is rendered from this file), scanned by unit tests without a
 * database (worker-dispatch-pointer-sql.spec.ts: Phase 0b body rules, constant parity with the Worker's TypeScript
 * predicates) and asserted by the migrations' own post-conditions. Precedent: deployment-identity-sql.ts.
 *
 * Owner-approved 2026-11-01 (master SQL gate; 1786721320000 after the v19 fingerprint sign-off). Executed on disposable
 * test databases only. The 1786721330000 statements are approved but application-gated: never executed.
 *
 * Shape:
 *   core.worker_dispatch_pointer        one row per OPEN subject (an email_outbox / push_delivery / realtime_event row, or
 *                                       a payroll record whose shift statement is due) — routing ids only: queue label,
 *                                       subject id, organisation, workspace, due time, claim token, claim count. Owner
 *                                       rab_secure_owner; ENABLE + FORCE RLS; one owner-only permissive policy
 *                                       (CURRENT_USER = rab_secure_owner, i.e. only inside the definers below) and a
 *                                       RESTRICTIVE deny-all for crewflow / crewflow_app / crewflow_worker; no table
 *                                       privilege for any login (precedent: core.deployment_identity, B3).
 *   core.worker_dispatch_claim_impl()   SECURITY INVOKER claim body, owned by rab_secure_owner, executable by no login.
 *   core.worker_claim_<queue>()         four SECURITY DEFINER wrappers: queue, lease and per-organisation cap fixed here;
 *                                       the caller chooses only the batch (clamped 1..200). EXECUTE crewflow_worker only.
 *   core.worker_release_dispatch_claim  SECURITY DEFINER: re-times the caller's OWN claimed pointer (claim token must
 *                                       match) by 1..300 s. Never deletes. EXECUTE crewflow_worker only.
 *   core.worker_dispatch_pointer_*_trg  SECURITY DEFINER AFTER ROW (+ AFTER TRUNCATE statement, E-4) trigger functions on
 *                                       the four source tables, each bound to its ONE table (TG_TABLE_NAME, E-2): mirror
 *                                       the dispatcher's due predicate into due_at, delete the pointer when the subject is
 *                                       no longer open (all of the queue's / workspace's pointers on TRUNCATE), refuse a
 *                                       change of the source row's scope, re-point a conflicting pointer to the row's scope
 *                                       (E-3), NOTIFY crewflow_worker_wake '<queue>' when due now AND the session enabled
 *                                       `crewflow.dispatch_notify` (E-1). No EXECUTE grant (a trigger needs none to FIRE),
 *                                       except the statement function: EXECUTE crewflow (SECURITY TRADE-OFF, docs/plans/PHASE-D-SQL-GATE.md).
 *
 * Phase 0b rules every rab_secure_owner definer body here follows (secure-owner-invariants.ts; enforced offline by the
 * unit spec and in the catalog by the migrations' self-checks): `SET search_path = pg_catalog, pg_temp`; every object
 * schema-qualified; no crewflow-owned core table named in a body (R4 is a word scan, comments and string literals count —
 * queue labels are used instead of table names) EXCEPT, by owner-reviewed decision E-2, each trigger function's own table
 * in its TG_TABLE_NAME check (exempted per exact pair, R4_PHASE_D_TRIGGER_PAIRS, N-1: email_outbox, push_delivery, realtime_event, payroll_record —
 * functions that evaluate rows of those tables as rab_secure_owner, i.e. genuinely R4-class); no dynamic SQL (the keyword
 * is a word scan too); every `core`
 * function a body calls is owned by rab_secure_owner. Trigger functions additionally refuse to run on a row whose columns
 * are not the reviewed built-in types (pg_typeof guard): the source tables are crewflow-owned, so their owner could
 * otherwise swap a column type for one whose operators / casts it controls and have them evaluated as rab_secure_owner.
 */

export const DISPATCH_QUEUES = ['email', 'push', 'realtime', 'statement'] as const;
export type DispatchQueueLabel = (typeof DISPATCH_QUEUES)[number];

/** NOTIFY channel (interface contract, D2). Payload = the queue label only. */
export const WAKE_CHANNEL = 'crewflow_worker_wake';

/** Server-fixed lease (seconds) and per-organisation cap per claim call. D4 test targets — see docs/plans/PHASE-D-SQL-GATE.md §lease. */
export const DISPATCH_QUEUE_SETTINGS: Readonly<Record<DispatchQueueLabel, { fn: string; leaseSeconds: number; perOrg: number }>> = {
  email: { fn: 'worker_claim_email_dispatch', leaseSeconds: 30, perOrg: 10 },
  push: { fn: 'worker_claim_push_dispatch', leaseSeconds: 30, perOrg: 10 },
  realtime: { fn: 'worker_claim_realtime_publish', leaseSeconds: 15, perOrg: 25 },
  statement: { fn: 'worker_claim_statement_dispatch', leaseSeconds: 60, perOrg: 10 },
};
export const CLAIM_BATCH_DEFAULT = 100;
export const CLAIM_BATCH_MAX = 200;
export const RELEASE_RETRY_DEFAULT_SECONDS = 30;
export const RELEASE_RETRY_MAX_SECONDS = 300;
/** Upper bound on index descents per claim call (one per distinct organisation that has pointers in the queue). */
export const CLAIM_MAX_ORG_STEPS = 5000;

/**
 * Due-time constants mirrored from the Worker's TypeScript predicates (R3: the parity spec imports both and compares).
 *   email     email-dispatch.job.ts     QUEUED > 2 min, PROCESSING_LEASE_MINUTES = 10, RETRY_STALE_MINUTES = 5
 *   push      push-dispatch.job.ts      PENDING_STALE_MINUTES = 2 (Agent B, D1), PROCESSING_LEASE_MINUTES = 10, RETRY_STALE_MINUTES = 5
 *   statement shift-statement.job.ts    SHIFT_STATEMENT_LEASE_MINUTES = 10, SHIFT_STATEMENT_RETRY_BACKOFF_MINUTES = 1,
 *                                       SHIFT_STATEMENT_MAX_ATTEMPTS = 5 (modules/payroll/constants/shift-statement.ts)
 */
export const DUE_CONSTANTS = {
  emailQueuedStaleMinutes: 2,
  emailProcessingLeaseMinutes: 10,
  emailRetryStaleMinutes: 5,
  pushPendingStaleMinutes: 2,
  pushProcessingLeaseMinutes: 10,
  pushRetryStaleMinutes: 5,
  statementLeaseMinutes: 10,
  statementRetryBackoffMinutes: 1,
  statementMaxAttempts: 5,
} as const;

const Q = (s: string) => `'${s}'`;
const QUEUE_LIST = DISPATCH_QUEUES.map(Q).join(', ');
const CLAIM_COLUMNS = 'subject_id uuid, organisation_id uuid, workspace_id uuid, claim_token uuid, claim_count integer';
export const IMPL_SIGNATURE = 'core.worker_dispatch_claim_impl(text, integer, integer, integer)';
export const RELEASE_SIGNATURE = 'core.worker_release_dispatch_claim(text, uuid, uuid, integer)';
export const CLAIM_SIGNATURES = DISPATCH_QUEUES.map((q) => `core.${DISPATCH_QUEUE_SETTINGS[q].fn}(integer)`);
export const WORKER_CALLABLE_SIGNATURES = [...CLAIM_SIGNATURES, RELEASE_SIGNATURE];
export const OUTBOX_TRIGGER_FUNCTIONS = ['email', 'push', 'realtime'].map((q) => `core.worker_dispatch_pointer_${q}_trg()`);
export const STATEMENT_TRIGGER_FUNCTION = 'core.worker_dispatch_pointer_statement_trg()';

// ---------------------------------------------------------------------------------------------------------------------
// crewflow_worker: operator-created, never by a migration (D2). The migrations only ASSERT its reviewed shape (fail closed).
// ---------------------------------------------------------------------------------------------------------------------

/** One row of facts about crewflow_worker (all false/0/NULL when the role does not exist). Read-only, catalog only. */
export const WORKER_ROLE_FACTS_SQL = `
SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'crewflow_worker') AS present,
       (SELECT pg_catalog.row_to_json(x)::text FROM (
          SELECT r.rolcanlogin AS login, r.rolinherit AS inherit, r.rolsuper AS super, r.rolbypassrls AS bypassrls,
                 r.rolcreaterole AS createrole, r.rolcreatedb AS createdb, r.rolreplication AS replication
            FROM pg_catalog.pg_roles r WHERE r.rolname = 'crewflow_worker') x) AS attributes,
       (SELECT pg_catalog.string_agg(pg_catalog.pg_get_userbyid(m.roleid) || ':admin=' || m.admin_option || ':inherit='
                 || m.inherit_option || ':set=' || m.set_option, ',' ORDER BY pg_catalog.pg_get_userbyid(m.roleid))
          FROM pg_catalog.pg_auth_members m
         WHERE m.member = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'crewflow_worker')) AS member_of,
       (SELECT pg_catalog.count(*)::int FROM pg_catalog.pg_auth_members m
         WHERE m.roleid = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'crewflow_worker')) AS members,
       (SELECT pg_catalog.count(*)::int FROM pg_catalog.pg_shdepend d
         WHERE d.refobjid = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'crewflow_worker') AND d.deptype = 'o') AS owns,
       COALESCE((SELECT pg_catalog.pg_has_role(r.oid, 'rab_secure_owner', 'USAGE') OR pg_catalog.pg_has_role(r.oid, 'rab_secure_owner', 'SET')
                     OR pg_catalog.pg_has_role(r.oid, 'crewflow', 'USAGE') OR pg_catalog.pg_has_role(r.oid, 'crewflow', 'SET')
                   FROM pg_catalog.pg_roles r WHERE r.rolname = 'crewflow_worker'), false) AS reaches_owner_role`;

export interface WorkerRoleFacts {
  present: boolean;
  attributes: string | null;
  member_of: string | null;
  members: number | null;
  owns: number | null;
  reaches_owner_role: boolean;
}

/** The reviewed shape (interface contract): LOGIN, INHERIT, member of crewflow_app WITH INHERIT TRUE, SET FALSE, nothing else. */
export const WORKER_ROLE_EXPECTED = {
  attributes: { login: true, inherit: true, super: false, bypassrls: false, createrole: false, createdb: false, replication: false },
  member_of: 'crewflow_app:admin=false:inherit=true:set=false',
  members: 0,
  owns: 0,
  reaches_owner_role: false,
} as const;

/** Problems with crewflow_worker's shape; empty = matches the contract. Pure (unit-tested). */
export function workerRoleProblems(f: WorkerRoleFacts | undefined): string[] {
  if (!f || !f.present) {
    return ['crewflow_worker does not exist: an operator must create it first (reviewed bootstrap step, see docs/runbooks/phase-d-worker-dispatch.md §2); a migration never creates a role'];
  }
  const problems: string[] = [];
  let attrs: Record<string, unknown> = {};
  try {
    attrs = JSON.parse(f.attributes ?? '{}') as Record<string, unknown>;
  } catch {
    problems.push('crewflow_worker attributes unreadable');
  }
  for (const [k, v] of Object.entries(WORKER_ROLE_EXPECTED.attributes)) {
    if (attrs[k] !== v) problems.push(`crewflow_worker ${k} must be ${v}, is ${String(attrs[k])}`);
  }
  if (f.member_of !== WORKER_ROLE_EXPECTED.member_of) {
    problems.push(`crewflow_worker must be a member of exactly crewflow_app (WITH INHERIT TRUE, SET FALSE, no ADMIN); found ${f.member_of ?? 'none'}`);
  }
  if (f.members !== 0) problems.push(`no role may be a member of crewflow_worker (found ${f.members}): it would inherit the claim grants`);
  if (f.owns !== 0) problems.push(`crewflow_worker must own nothing (owns ${f.owns} object(s))`);
  if (f.reaches_owner_role !== false) problems.push('crewflow_worker must not be able to use or SET ROLE to crewflow or rab_secure_owner');
  return problems;
}

/** CF-41 / Phase 0b bootstrap identity: a superuser or a login that can act as both rab_secure_owner and crewflow. */
export const BOOTSTRAP_IDENTITY_SQL = `
SELECT current_user::text AS who, r.rolsuper AS su,
       (pg_catalog.pg_has_role(current_user, 'rab_secure_owner', 'USAGE') AND pg_catalog.pg_has_role(current_user, 'crewflow', 'USAGE')) AS can_act,
       (pg_catalog.pg_has_role(current_user, 'rab_secure_owner', 'SET')) AS can_set_secure,
       (SELECT s.rolcanlogin OR s.rolsuper OR s.rolbypassrls FROM pg_catalog.pg_roles s WHERE s.rolname = 'rab_secure_owner') AS secure_bad,
       (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'core')::text AS core_owner
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

export interface BootstrapIdentityFacts {
  who: string;
  su: boolean;
  can_act: boolean;
  can_set_secure: boolean;
  secure_bad: boolean | null;
  core_owner: string;
}

export function bootstrapIdentityProblems(f: BootstrapIdentityFacts | undefined): string[] {
  if (!f) return ['cannot read the connecting identity'];
  const problems: string[] = [];
  if (!f.su && !f.can_act) problems.push('it cannot act as rab_secure_owner and crewflow (CF-41 bootstrap identity required)');
  if (f.secure_bad !== false) problems.push('rab_secure_owner must exist and be NOLOGIN, NOSUPERUSER, NOBYPASSRLS');
  if (f.core_owner !== 'rab_secure_owner') problems.push(`schema core is owned by ${f.core_owner}, not rab_secure_owner (Phase 0b first)`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1786721300000 WorkerDispatchPointer
// ---------------------------------------------------------------------------------------------------------------------

const OWNER_ONLY = `(CURRENT_USER = 'rab_secure_owner'::name)`;

function claimWrapperSql(q: DispatchQueueLabel): string {
  const s = DISPATCH_QUEUE_SETTINGS[q];
  return `CREATE FUNCTION core.${s.fn}(p_limit integer)
RETURNS TABLE (${CLAIM_COLUMNS})
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT c.subject_id, c.organisation_id, c.workspace_id, c.claim_token, c.claim_count
    FROM core.worker_dispatch_claim_impl('${q}', p_limit, ${s.leaseSeconds}, ${s.perOrg}) AS c
$fn$`;
}

/** The claim body. SECURITY INVOKER: it only ever runs inside the rab_secure_owner wrappers above (as rab_secure_owner). */
export const CLAIM_IMPL_SQL = `CREATE FUNCTION ${IMPL_SIGNATURE.replace('(text, integer, integer, integer)', '(p_queue text, p_limit integer, p_lease_seconds integer, p_per_org integer)')}
RETURNS TABLE (${CLAIM_COLUMNS})
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict error
DECLARE
  v_limit   integer;
  v_now     timestamptz := pg_catalog.clock_timestamp();
  v_lease   timestamptz;
  v_pivot   uuid := pg_catalog.gen_random_uuid();
  v_token   uuid := pg_catalog.gen_random_uuid();
  v_orgs    uuid[] := ARRAY[]::uuid[];
  v_cursor  uuid := NULL;
  v_next    uuid;
  v_due     timestamptz;
  v_steps   integer := 0;
  v_wrapped boolean := false;
BEGIN
  IF p_queue IS NULL OR p_queue NOT IN (${QUEUE_LIST}) THEN
    RAISE EXCEPTION 'worker dispatch claim: unknown queue' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300 OR p_per_org IS NULL OR p_per_org NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'worker dispatch claim: invalid server-side lease or cap' USING ERRCODE = '22023';
  END IF;
  v_limit := LEAST(GREATEST(COALESCE(p_limit, ${CLAIM_BATCH_DEFAULT}), 1), ${CLAIM_BATCH_MAX});

  LOOP
    EXIT WHEN pg_catalog.cardinality(v_orgs) >= v_limit OR v_steps >= ${CLAIM_MAX_ORG_STEPS};
    v_steps := v_steps + 1;
    v_next := NULL;
    v_due := NULL;
    IF NOT v_wrapped THEN
      IF v_cursor IS NULL THEN
        SELECT p.organisation_id, p.due_at INTO v_next, v_due
          FROM core.worker_dispatch_pointer p
         WHERE p.queue = p_queue AND p.organisation_id >= v_pivot
         ORDER BY p.organisation_id, p.due_at
         LIMIT 1;
      ELSE
        SELECT p.organisation_id, p.due_at INTO v_next, v_due
          FROM core.worker_dispatch_pointer p
         WHERE p.queue = p_queue AND p.organisation_id > v_cursor
         ORDER BY p.organisation_id, p.due_at
         LIMIT 1;
      END IF;
      IF v_next IS NULL THEN
        v_wrapped := true;
        v_cursor := NULL;
        CONTINUE;
      END IF;
    ELSE
      IF v_cursor IS NULL THEN
        SELECT p.organisation_id, p.due_at INTO v_next, v_due
          FROM core.worker_dispatch_pointer p
         WHERE p.queue = p_queue AND p.organisation_id < v_pivot
         ORDER BY p.organisation_id, p.due_at
         LIMIT 1;
      ELSE
        SELECT p.organisation_id, p.due_at INTO v_next, v_due
          FROM core.worker_dispatch_pointer p
         WHERE p.queue = p_queue AND p.organisation_id > v_cursor AND p.organisation_id < v_pivot
         ORDER BY p.organisation_id, p.due_at
         LIMIT 1;
      END IF;
      EXIT WHEN v_next IS NULL;
    END IF;
    v_cursor := v_next;
    IF v_due <= v_now THEN
      v_orgs := v_orgs || v_next;
    END IF;
  END LOOP;

  IF pg_catalog.cardinality(v_orgs) = 0 THEN
    RETURN;
  END IF;

  v_lease := pg_catalog.clock_timestamp();
  RETURN QUERY
  WITH cand AS MATERIALIZED (
    SELECT x.sid, x.due
      FROM pg_catalog.unnest(v_orgs) AS o(org)
      CROSS JOIN LATERAL (
        SELECT p.subject_id AS sid, p.due_at AS due
          FROM core.worker_dispatch_pointer p
         WHERE p.queue = p_queue AND p.organisation_id = o.org AND p.due_at <= v_now
         ORDER BY p.due_at
         LIMIT p_per_org) x
     ORDER BY x.due
     LIMIT v_limit
  ), picked AS MATERIALIZED (
    SELECT p.subject_id AS sid
      FROM core.worker_dispatch_pointer p
     WHERE p.queue = p_queue AND p.subject_id IN (SELECT c.sid FROM cand c) AND p.due_at <= v_now
     FOR UPDATE OF p SKIP LOCKED
  )
  UPDATE core.worker_dispatch_pointer w
     SET due_at = v_lease + pg_catalog.make_interval(secs => p_lease_seconds),
         claim_token = v_token,
         claim_count = w.claim_count + 1,
         claimed_at = v_lease,
         updated_at = v_lease
    FROM picked k
   WHERE w.queue = p_queue AND w.subject_id = k.sid
  RETURNING w.subject_id, w.organisation_id, w.workspace_id, w.claim_token, w.claim_count;
END
$fn$`;

export const RELEASE_SQL = `CREATE FUNCTION core.worker_release_dispatch_claim(p_queue text, p_subject_id uuid, p_claim_token uuid, p_retry_after_seconds integer)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF p_queue IS NULL OR p_queue NOT IN (${QUEUE_LIST}) OR p_subject_id IS NULL OR p_claim_token IS NULL THEN
    RETURN false;
  END IF;
  UPDATE core.worker_dispatch_pointer w
     SET due_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_retry_after_seconds, ${RELEASE_RETRY_DEFAULT_SECONDS}), 1), ${RELEASE_RETRY_MAX_SECONDS})),
         claim_token = NULL,
         updated_at = pg_catalog.clock_timestamp()
   WHERE w.queue = p_queue AND w.subject_id = p_subject_id AND w.claim_token = p_claim_token;
  RETURN FOUND;
END
$fn$`;

export const WORKER_DISPATCH_POINTER_UP_SQL: readonly string[] = [
  `CREATE TABLE core.worker_dispatch_pointer (
  queue text NOT NULL,
  subject_id uuid NOT NULL,
  organisation_id uuid NOT NULL,
  workspace_id uuid,
  due_at timestamptz NOT NULL,
  claim_token uuid,
  claim_count integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  repoint_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT worker_dispatch_pointer_pkey PRIMARY KEY (queue, subject_id),
  CONSTRAINT worker_dispatch_pointer_queue_check CHECK (queue IN (${QUEUE_LIST})),
  CONSTRAINT worker_dispatch_pointer_scope_check CHECK (
    (queue IN ('email', 'push') AND workspace_id IS NULL)
    OR (queue = 'statement' AND workspace_id IS NOT NULL)
    OR queue = 'realtime'),
  CONSTRAINT worker_dispatch_pointer_claim_count_check CHECK (claim_count >= 0),
  CONSTRAINT worker_dispatch_pointer_claim_pair_check CHECK (claim_token IS NULL OR claimed_at IS NOT NULL),
  CONSTRAINT worker_dispatch_pointer_repoint_count_check CHECK (repoint_count >= 0),
  CONSTRAINT worker_dispatch_pointer_organisation_id_fkey FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE,
  CONSTRAINT worker_dispatch_pointer_workspace_org_fkey FOREIGN KEY (workspace_id, organisation_id)
    REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE
) WITH (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)`,
  // Fair claim: one index descent per distinct organisation (queue, organisation_id) and per-organisation due order (due_at).
  'CREATE INDEX worker_dispatch_pointer_fair_idx ON core.worker_dispatch_pointer (queue, organisation_id, due_at)',
  // FK support for ON DELETE CASCADE from manager_workspace (statement / realtime rows only).
  'CREATE INDEX worker_dispatch_pointer_workspace_idx ON core.worker_dispatch_pointer (workspace_id) WHERE workspace_id IS NOT NULL',
  'ALTER TABLE core.worker_dispatch_pointer OWNER TO rab_secure_owner',
  'REVOKE ALL ON TABLE core.worker_dispatch_pointer FROM PUBLIC, crewflow, crewflow_app, crewflow_worker',
  'ALTER TABLE core.worker_dispatch_pointer ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.worker_dispatch_pointer FORCE ROW LEVEL SECURITY',
  `CREATE POLICY worker_dispatch_pointer_definer ON core.worker_dispatch_pointer AS PERMISSIVE FOR ALL TO rab_secure_owner USING ${OWNER_ONLY} WITH CHECK ${OWNER_ONLY}`,
  'CREATE POLICY worker_dispatch_pointer_runtime_deny ON core.worker_dispatch_pointer AS RESTRICTIVE FOR ALL TO crewflow, crewflow_app, crewflow_worker USING (false) WITH CHECK (false)',
  CLAIM_IMPL_SQL,
  ...DISPATCH_QUEUES.map(claimWrapperSql),
  RELEASE_SQL,
  // Ownership after the PUBLIC revoke (the creator's ACL entry is rewritten to the new owner, so nothing names the creator).
  `REVOKE ALL ON FUNCTION ${IMPL_SIGNATURE} FROM PUBLIC`,
  ...WORKER_CALLABLE_SIGNATURES.map((f) => `REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`),
  `ALTER FUNCTION ${IMPL_SIGNATURE} OWNER TO rab_secure_owner`,
  ...WORKER_CALLABLE_SIGNATURES.map((f) => `ALTER FUNCTION ${f} OWNER TO rab_secure_owner`),
  `REVOKE ALL ON FUNCTION ${IMPL_SIGNATURE} FROM crewflow, crewflow_app, crewflow_worker`,
  ...WORKER_CALLABLE_SIGNATURES.map((f) => `REVOKE ALL ON FUNCTION ${f} FROM crewflow, crewflow_app`),
  ...WORKER_CALLABLE_SIGNATURES.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO crewflow_worker`),
];

export const WORKER_DISPATCH_POINTER_DOWN_SQL: readonly string[] = [
  `DROP FUNCTION ${RELEASE_SIGNATURE}`,
  ...[...CLAIM_SIGNATURES].reverse().map((f) => `DROP FUNCTION ${f}`),
  `DROP FUNCTION ${IMPL_SIGNATURE}`,
  'DROP TABLE core.worker_dispatch_pointer',
];

/** Post-condition of 1786721300000 (one row; compared exactly with WORKER_DISPATCH_POINTER_EXPECTED_STATE). */
export const WORKER_DISPATCH_POINTER_STATE_SQL = `
WITH f AS (
  SELECT p.oid, p.proname FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'core'::regnamespace
     AND p.proname IN ('worker_dispatch_claim_impl', ${DISPATCH_QUEUES.map((q) => Q(DISPATCH_QUEUE_SETTINGS[q].fn)).join(', ')}, 'worker_release_dispatch_claim')
)
SELECT
  (SELECT pg_catalog.pg_get_userbyid(c.relowner) || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text
     FROM pg_catalog.pg_class c WHERE c.oid = 'core.worker_dispatch_pointer'::regclass) AS "table",
  (SELECT COALESCE(pg_catalog.string_agg(x.v, ',' ORDER BY x.v), '') FROM (
     SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ':' || a.privilege_type AS v
       FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
      WHERE c.oid = 'core.worker_dispatch_pointer'::regclass AND a.grantee <> c.relowner) x) AS table_acl_non_owner,
  (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
     SELECT pol.polname || ':' || pol.polcmd::text || ':' || pol.polpermissive::text || ':'
            || (SELECT pg_catalog.string_agg(CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END, '+' ORDER BY CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END)
                  FROM pg_catalog.unnest(pol.polroles) r) AS v
       FROM pg_catalog.pg_policy pol WHERE pol.polrelid = 'core.worker_dispatch_pointer'::regclass) x) AS policies,
  (SELECT pg_catalog.count(*)::int FROM pg_catalog.pg_trigger g WHERE g.tgrelid = 'core.worker_dispatch_pointer'::regclass AND NOT g.tgisinternal) AS triggers,
  (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
     SELECT pg_catalog.format('%s:%s:%s:%s', f.proname, pg_catalog.pg_get_userbyid(p.proowner), p.prosecdef::text,
                              COALESCE(pg_catalog.array_to_string(p.proconfig, ';'), '')) AS v
       FROM f JOIN pg_catalog.pg_proc p ON p.oid = f.oid) x) AS functions,
  (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
     SELECT f.proname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS v
       FROM f JOIN pg_catalog.pg_proc p ON p.oid = f.oid CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
      WHERE a.privilege_type = 'EXECUTE') x) AS function_acl`;

const claimFns = DISPATCH_QUEUES.map((q) => DISPATCH_QUEUE_SETTINGS[q].fn);
export const WORKER_DISPATCH_POINTER_EXPECTED_STATE = {
  table: 'rab_secure_owner:true:true',
  table_acl_non_owner: '',
  policies: [
    'worker_dispatch_pointer_definer:*:true:rab_secure_owner',
    'worker_dispatch_pointer_runtime_deny:*:false:crewflow+crewflow_app+crewflow_worker',
  ].join(','),
  triggers: 0,
  functions: [
    ...claimFns.map((fn) => `${fn}:rab_secure_owner:true:search_path=pg_catalog, pg_temp`),
    'worker_dispatch_claim_impl:rab_secure_owner:false:search_path=pg_catalog, pg_temp',
    'worker_release_dispatch_claim:rab_secure_owner:true:search_path=pg_catalog, pg_temp',
  ]
    .sort()
    .join(','),
  function_acl: [
    ...claimFns.flatMap((fn) => [`${fn}:crewflow_worker`, `${fn}:rab_secure_owner`]),
    'worker_dispatch_claim_impl:rab_secure_owner',
    'worker_release_dispatch_claim:crewflow_worker',
    'worker_release_dispatch_claim:rab_secure_owner',
  ]
    .sort()
    .join(','),
} as const;

/** Effective-privilege post-condition: [role, object, privilege, expected]. Read through has_*_privilege (inheritance included). */
export function workerDispatchPrivilegeChecksSql(): string {
  const rows: string[] = [];
  for (const role of ['crewflow', 'crewflow_app', 'crewflow_worker']) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      rows.push(`SELECT '${role}|table|${p}|' || pg_catalog.has_table_privilege('${role}', 'core.worker_dispatch_pointer', '${p}') AS line`);
    }
    for (const f of [IMPL_SIGNATURE, ...WORKER_CALLABLE_SIGNATURES]) {
      rows.push(`SELECT '${role}|${f}|' || pg_catalog.has_function_privilege('${role}', '${f}', 'EXECUTE')`);
    }
  }
  return rows.join('\nUNION ALL\n');
}

/** Lines workerDispatchPrivilegeChecksSql() must return (exactly). */
export function expectedWorkerDispatchPrivilegeLines(): string[] {
  const out: string[] = [];
  for (const role of ['crewflow', 'crewflow_app', 'crewflow_worker']) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) out.push(`${role}|table|${p}|false`);
    out.push(`${role}|${IMPL_SIGNATURE}|false`);
    for (const f of WORKER_CALLABLE_SIGNATURES) out.push(`${role}|${f}|${role === 'crewflow_worker'}`);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------------------------------------------------
// Trigger functions (1786721310000 for the three core outboxes; 1786721320000 for statements)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * E-8: every transaction that creates or drops a pointer trigger on a LIVE table first bounds its lock wait, so a deploy
 * that meets a long-running transaction fails fast (55P03, rolled back, nothing applied) instead of queueing every write
 * behind its SHARE ROW EXCLUSIVE / ACCESS EXCLUSIVE request. Retry = re-run the migration (each step is idempotent).
 */
export const DISPATCH_TRIGGER_LOCK_TIMEOUT = '5s';
export const LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '${DISPATCH_TRIGGER_LOCK_TIMEOUT}'`;

/**
 * E-1: the wake-up NOTIFY is sent only by a session that turned it on (`SET crewflow.dispatch_notify = on`, done by the
 * API / Worker runtime connections only when WORKER_DISPATCH_MODE=event — Agent C). Default (unset / off): no NOTIFY, so
 * poll mode never takes the commit-time NOTIFY lock nor fills the notification queue. A session can only change its OWN
 * setting: turning it off loses only its own hint (the 30 s backstop claims the row); turning it on with no listener
 * appends to a queue nobody holds back (no growth).
 */
export const NOTIFY_SETTING = 'crewflow.dispatch_notify';

const TYPE_ERROR = `RAISE EXCEPTION 'dispatch pointer trigger: a source column is not of its reviewed type' USING ERRCODE = '42804'`;
/** Refuses to evaluate anything on a row whose columns are not the reviewed built-in types (see the file comment). */
function typeGuards(rec: 'NEW' | 'OLD', cols: ReadonlyArray<readonly [string, string]>): string {
  const cond = cols
    .map(([c, t]) => `pg_catalog.pg_typeof(${rec}.${c}) IS DISTINCT FROM 'pg_catalog.${t}'::pg_catalog.regtype`)
    .join('\n       OR ');
  return `    IF ${cond} THEN
      ${TYPE_ERROR};
    END IF;`;
}

const PLACE_ERROR = `RAISE EXCEPTION 'dispatch pointer trigger attached outside its reviewed place' USING ERRCODE = '42501'`;
const SCOPE_CHANGE_ERROR = `RAISE EXCEPTION 'dispatch pointer: the subject id, organisation or workspace of an open subject cannot change' USING ERRCODE = '42501'`;
const SCOPE_MISMATCH_ERROR = `RAISE EXCEPTION 'dispatch pointer scope mismatch' USING ERRCODE = '42501'`;
function notifyBlock(q: DispatchQueueLabel): string {
  return `  IF v_due <= pg_catalog.now() AND pg_catalog.current_setting('${NOTIFY_SETTING}', true) = 'on' THEN
    PERFORM pg_catalog.pg_notify('${WAKE_CHANNEL}', '${q}');
  END IF;`;
}

/**
 * E-3: on a pointer conflict the pointer is RE-POINTED to the firing row's own scope (the row already passed its table's
 * RLS WITH CHECK, so its organisation / workspace are the authority — "rows are the truth"), never refused: a stale or
 * squatted pointer can no longer block a tenant's business write. repoint_count records that it happened (monitoring).
 * A change of the SOURCE row's id / organisation / workspace is still refused (fail closed) before this point.
 */
function upsertSql(q: DispatchQueueLabel, ws: string): string {
  return `  INSERT INTO core.worker_dispatch_pointer AS w (queue, subject_id, organisation_id, workspace_id, due_at)
  VALUES ('${q}', NEW.id, NEW.organisation_id, ${ws}, v_due)
  ON CONFLICT (queue, subject_id) DO UPDATE
     SET organisation_id = EXCLUDED.organisation_id,
         workspace_id = EXCLUDED.workspace_id,
         due_at = EXCLUDED.due_at,
         claim_token = NULL,
         claimed_at = NULL,
         repoint_count = w.repoint_count
           + CASE WHEN w.organisation_id IS DISTINCT FROM EXCLUDED.organisation_id
                    OR w.workspace_id IS DISTINCT FROM EXCLUDED.workspace_id THEN 1 ELSE 0 END,
         updated_at = pg_catalog.now();`;
}

interface OutboxTrigger {
  queue: 'email' | 'push' | 'realtime';
  /** E-2: the one table this function may fire on (checked through TG_TABLE_NAME). */
  table: 'email_outbox' | 'push_delivery' | 'realtime_event';
  /** The due-time CASE over NEW.status (NULL = no pointer: terminal, or never due by the TypeScript predicate either). */
  due: string;
  columns: ReadonlyArray<readonly [string, string]>;
  /** true: the pointer carries NEW.workspace_id (realtime); false: always NULL (email / push are organisation-scoped). */
  workspaceScoped: boolean;
}

const OUTBOX_TRIGGERS: readonly OutboxTrigger[] = [
  {
    queue: 'email',
    table: 'email_outbox',
    due: `CASE NEW.status
      WHEN 'PENDING' THEN pg_catalog.now()
      WHEN 'QUEUED' THEN NEW.queued_at + pg_catalog.make_interval(mins => ${DUE_CONSTANTS.emailQueuedStaleMinutes})
      WHEN 'PROCESSING' THEN NEW.processing_at + pg_catalog.make_interval(mins => ${DUE_CONSTANTS.emailProcessingLeaseMinutes})
      WHEN 'RETRY' THEN NEW.updated_at + pg_catalog.make_interval(mins => ${DUE_CONSTANTS.emailRetryStaleMinutes})
      ELSE NULL END`,
    columns: [['id', 'uuid'], ['organisation_id', 'uuid'], ['status', 'text'], ['queued_at', 'timestamptz'], ['processing_at', 'timestamptz'], ['updated_at', 'timestamptz']],
    workspaceScoped: false,
  },
  {
    queue: 'push',
    table: 'push_delivery',
    // Push parity (Agent B, B-report §5.2): a PENDING row is due now until its first publish stamps queued_at, then again
    // only once that publish is stale (PENDING_STALE_MINUTES = 2) — mirrors email's QUEUED rule.
    due: `CASE NEW.status
      WHEN 'PENDING' THEN COALESCE(NEW.queued_at + pg_catalog.make_interval(mins => ${DUE_CONSTANTS.pushPendingStaleMinutes}), pg_catalog.now())
      WHEN 'PROCESSING' THEN NEW.processing_at + pg_catalog.make_interval(mins => ${DUE_CONSTANTS.pushProcessingLeaseMinutes})
      WHEN 'RETRY' THEN NEW.updated_at + pg_catalog.make_interval(mins => ${DUE_CONSTANTS.pushRetryStaleMinutes})
      ELSE NULL END`,
    columns: [['id', 'uuid'], ['organisation_id', 'uuid'], ['status', 'text'], ['queued_at', 'timestamptz'], ['processing_at', 'timestamptz'], ['updated_at', 'timestamptz']],
    workspaceScoped: false,
  },
  {
    queue: 'realtime',
    table: 'realtime_event',
    due: `CASE NEW.status
      WHEN 'pending' THEN COALESCE(NEW.next_retry_at, pg_catalog.now())
      WHEN 'retry' THEN COALESCE(NEW.next_retry_at, pg_catalog.now())
      WHEN 'processing' THEN NEW.lease_expires_at
      ELSE NULL END`,
    columns: [['id', 'uuid'], ['organisation_id', 'uuid'], ['workspace_id', 'uuid'], ['status', 'text'], ['next_retry_at', 'timestamptz'], ['lease_expires_at', 'timestamptz']],
    workspaceScoped: true,
  },
];

/** E-2: the table each trigger function is bound to (the only crewflow-owned table name its body contains). */
export const TRIGGER_FUNCTION_TABLE: Readonly<Record<'email' | 'push' | 'realtime' | 'statement', string>> = {
  email: 'email_outbox',
  push: 'push_delivery',
  realtime: 'realtime_event',
  statement: 'payroll_record',
};

function outboxTriggerFunctionSql(t: OutboxTrigger): string {
  const ws = t.workspaceScoped ? 'NEW.workspace_id' : 'NULL::uuid';
  const scopeChanged = t.workspaceScoped
    ? 'OLD.id IS DISTINCT FROM NEW.id OR OLD.organisation_id IS DISTINCT FROM NEW.organisation_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id'
    : 'OLD.id IS DISTINCT FROM NEW.id OR OLD.organisation_id IS DISTINCT FROM NEW.organisation_id';
  const pairing = t.workspaceScoped
    ? `
  IF NEW.workspace_id IS NOT NULL THEN
    SELECT mw.organisation_id INTO v_ws_org FROM core.manager_workspace mw WHERE mw.id = NEW.workspace_id;
    IF v_ws_org IS DISTINCT FROM NEW.organisation_id THEN
      ${SCOPE_MISMATCH_ERROR};
    END IF;
  END IF;`
    : '';
  return `CREATE FUNCTION core.worker_dispatch_pointer_${t.queue}_trg()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_due timestamptz;${t.workspaceScoped ? '\n  v_ws_org uuid;' : ''}
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'core' OR TG_TABLE_NAME IS DISTINCT FROM '${t.table}' OR TG_WHEN IS DISTINCT FROM 'AFTER' THEN
    ${PLACE_ERROR};
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    IF TG_LEVEL IS DISTINCT FROM 'STATEMENT' THEN
      ${PLACE_ERROR};
    END IF;
    DELETE FROM core.worker_dispatch_pointer w WHERE w.queue = '${t.queue}';
    RETURN NULL;
  END IF;
  IF TG_LEVEL IS DISTINCT FROM 'ROW' THEN
    ${PLACE_ERROR};
  END IF;
  IF TG_OP = 'DELETE' THEN
${typeGuards('OLD', [['id', 'uuid']])}
    DELETE FROM core.worker_dispatch_pointer w WHERE w.queue = '${t.queue}' AND w.subject_id = OLD.id;
    RETURN NULL;
  END IF;
${typeGuards('NEW', t.columns)}
  IF TG_OP = 'UPDATE' THEN
    IF ${scopeChanged} THEN
      ${SCOPE_CHANGE_ERROR};
    END IF;
  END IF;
  v_due := ${t.due};
  IF v_due IS NULL THEN
    DELETE FROM core.worker_dispatch_pointer w WHERE w.queue = '${t.queue}' AND w.subject_id = NEW.id;
    RETURN NULL;
  END IF;${pairing}
${upsertSql(t.queue, ws)}
${notifyBlock(t.queue)}
  RETURN NULL;
END
$fn$`;
}

export const STATEMENT_TRIGGER_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION ${STATEMENT_TRIGGER_FUNCTION}
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_due timestamptz;
  v_ws_org uuid;
  v_ws uuid;
BEGIN
  IF TG_TABLE_NAME IS DISTINCT FROM 'payroll_record' OR TG_WHEN IS DISTINCT FROM 'AFTER' THEN
    ${PLACE_ERROR};
  END IF;
  IF (SELECT n.nspowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = TG_RELID)
       IS DISTINCT FROM 'rab_secure_owner'::pg_catalog.regrole::pg_catalog.oid THEN
    ${PLACE_ERROR};
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    IF TG_LEVEL IS DISTINCT FROM 'STATEMENT' THEN
      ${PLACE_ERROR};
    END IF;
    IF TG_TABLE_SCHEMA = 'core' THEN
      DELETE FROM core.worker_dispatch_pointer w WHERE w.queue = 'statement';
    ELSIF TG_TABLE_SCHEMA ~ '^workspace_[0-9a-f]{32}$' THEN
      DELETE FROM core.worker_dispatch_pointer w
       WHERE w.queue = 'statement' AND w.workspace_id = (pg_catalog.substr(TG_TABLE_SCHEMA, 11))::uuid;
    ELSE
      ${PLACE_ERROR};
    END IF;
    RETURN NULL;
  END IF;
  IF TG_LEVEL IS DISTINCT FROM 'ROW' THEN
    ${PLACE_ERROR};
  END IF;
  IF TG_OP = 'DELETE' THEN
${typeGuards('OLD', [['id', 'uuid'], ['organisation_id', 'uuid'], ['workspace_id', 'uuid']])}
    v_ws := OLD.workspace_id;
  ELSE
${typeGuards('NEW', [
  ['id', 'uuid'],
  ['organisation_id', 'uuid'],
  ['workspace_id', 'uuid'],
  ['status', 'text'],
  ['statement_status', 'text'],
  ['statement_file_id', 'uuid'],
  ['statement_attempts', 'int4'],
  ['statement_queued_at', 'timestamptz'],
  ['statement_processing_at', 'timestamptz'],
  ['updated_at', 'timestamptz'],
])}
    v_ws := NEW.workspace_id;
  END IF;
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'core'
     AND TG_TABLE_SCHEMA IS DISTINCT FROM ('workspace_' || pg_catalog.replace(v_ws::text, '-', '')) THEN
    ${PLACE_ERROR};
  END IF;
  IF TG_OP = 'DELETE' THEN
    DELETE FROM core.worker_dispatch_pointer w WHERE w.queue = 'statement' AND w.subject_id = OLD.id;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id IS DISTINCT FROM NEW.id OR OLD.organisation_id IS DISTINCT FROM NEW.organisation_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
      ${SCOPE_CHANGE_ERROR};
    END IF;
  END IF;
  v_due := NULL;
  IF NEW.workspace_id IS NOT NULL AND NEW.status IN ('approved', 'processing', 'paid') AND NEW.statement_file_id IS NULL THEN
    v_due := CASE
      WHEN NEW.statement_status IN ('none', 'pending') THEN pg_catalog.now()
      WHEN NEW.statement_status IN ('queued', 'processing')
        THEN COALESCE(NEW.statement_processing_at, NEW.statement_queued_at, NEW.updated_at) + pg_catalog.make_interval(mins => ${DUE_CONSTANTS.statementLeaseMinutes})
      WHEN NEW.statement_status = 'failed' AND NEW.statement_attempts < ${DUE_CONSTANTS.statementMaxAttempts}
        THEN NEW.updated_at + pg_catalog.make_interval(mins => ${DUE_CONSTANTS.statementRetryBackoffMinutes} * NEW.statement_attempts)
      ELSE NULL END;
  END IF;
  IF v_due IS NULL THEN
    DELETE FROM core.worker_dispatch_pointer w WHERE w.queue = 'statement' AND w.subject_id = NEW.id;
    RETURN NULL;
  END IF;
  SELECT mw.organisation_id INTO v_ws_org FROM core.manager_workspace mw WHERE mw.id = NEW.workspace_id;
  IF v_ws_org IS DISTINCT FROM NEW.organisation_id THEN
    ${SCOPE_MISMATCH_ERROR};
  END IF;
${upsertSql('statement', 'NEW.workspace_id')}
${notifyBlock('statement')}
  RETURN NULL;
END
$fn$`;

/**
 * What 1786721320000's down() leaves behind: the same function, inert. Workspace schemas keep their module-19 triggers
 * (the ledger is append-only — VenueTeamOrgAdmin1786721090000 precedent), and those triggers must never reference the
 * pointer table once 1786721300000's down() drops it, or every payroll write in a v19 workspace would fail.
 */
export const STATEMENT_TRIGGER_FUNCTION_INERT_SQL = `CREATE OR REPLACE FUNCTION ${STATEMENT_TRIGGER_FUNCTION}
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RETURN NULL;
END
$fn$`;

/** SQL of the three core outbox trigger functions, exported for the dossier and the unit scans. */
export const OUTBOX_TRIGGER_FUNCTION_SQL: Readonly<Record<'email' | 'push' | 'realtime', string>> = {
  email: outboxTriggerFunctionSql(OUTBOX_TRIGGERS[0]!),
  push: outboxTriggerFunctionSql(OUTBOX_TRIGGERS[1]!),
  realtime: outboxTriggerFunctionSql(OUTBOX_TRIGGERS[2]!),
};

const OUTBOX_TRIGGER_DDL: ReadonlyArray<{ table: string; queue: 'email' | 'push' | 'realtime'; open: string; terminal: string; update: string }> = [
  {
    table: 'email_outbox',
    queue: 'email',
    open: `'PENDING', 'QUEUED', 'PROCESSING', 'RETRY'`,
    terminal: `'SENT', 'FAILED', 'CANCELLED'`,
    update: `OLD.status IS DISTINCT FROM NEW.status OR OLD.queued_at IS DISTINCT FROM NEW.queued_at
       OR OLD.processing_at IS DISTINCT FROM NEW.processing_at
       OR (NEW.status = 'RETRY' AND OLD.updated_at IS DISTINCT FROM NEW.updated_at)
       OR OLD.id IS DISTINCT FROM NEW.id OR OLD.organisation_id IS DISTINCT FROM NEW.organisation_id`,
  },
  {
    table: 'push_delivery',
    queue: 'push',
    open: `'PENDING', 'PROCESSING', 'RETRY'`,
    terminal: `'ACCEPTED', 'FAILED', 'CANCELLED'`,
    update: `OLD.status IS DISTINCT FROM NEW.status OR OLD.queued_at IS DISTINCT FROM NEW.queued_at
       OR OLD.processing_at IS DISTINCT FROM NEW.processing_at
       OR OLD.dispatch_generation IS DISTINCT FROM NEW.dispatch_generation
       OR (NEW.status = 'RETRY' AND OLD.updated_at IS DISTINCT FROM NEW.updated_at)
       OR OLD.id IS DISTINCT FROM NEW.id OR OLD.organisation_id IS DISTINCT FROM NEW.organisation_id`,
  },
  {
    table: 'realtime_event',
    queue: 'realtime',
    open: `'pending', 'retry', 'processing'`,
    terminal: `'completed', 'failed', 'cancelled'`,
    update: `OLD.status IS DISTINCT FROM NEW.status OR OLD.next_retry_at IS DISTINCT FROM NEW.next_retry_at
       OR OLD.lease_expires_at IS DISTINCT FROM NEW.lease_expires_at
       OR OLD.id IS DISTINCT FROM NEW.id OR OLD.organisation_id IS DISTINCT FROM NEW.organisation_id
       OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id`,
  },
];

const TRIGGER_SUFFIXES = ['ins', 'upd', 'del', 'trunc'] as const;

export const OUTBOX_TRIGGER_NAMES: readonly string[] = OUTBOX_TRIGGER_DDL.flatMap((t) =>
  TRIGGER_SUFFIXES.map((s) => `${t.table}.${t.table}_dispatch_pointer_${s}`),
);

export const OUTBOX_TRIGGERS_UP_SQL: readonly string[] = [
  LOCK_TIMEOUT_SQL,
  OUTBOX_TRIGGER_FUNCTION_SQL.email,
  OUTBOX_TRIGGER_FUNCTION_SQL.push,
  OUTBOX_TRIGGER_FUNCTION_SQL.realtime,
  ...OUTBOX_TRIGGER_FUNCTIONS.map((f) => `REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`),
  ...OUTBOX_TRIGGER_FUNCTIONS.map((f) => `ALTER FUNCTION ${f} OWNER TO rab_secure_owner`),
  ...OUTBOX_TRIGGER_FUNCTIONS.map((f) => `REVOKE ALL ON FUNCTION ${f} FROM crewflow, crewflow_app, crewflow_worker`),
  // CREATE TRIGGER takes SHARE ROW EXCLUSIVE on each table (bounded by LOCK_TIMEOUT_SQL above); the migrator needs TRIGGER
  // on the crewflow-owned table (member of crewflow) and EXECUTE on the function (member of rab_secure_owner).
  ...OUTBOX_TRIGGER_DDL.flatMap((t) => [
    `CREATE TRIGGER ${t.table}_dispatch_pointer_ins AFTER INSERT ON core.${t.table}
  FOR EACH ROW WHEN (NEW.status IN (${t.open}))
  EXECUTE FUNCTION core.worker_dispatch_pointer_${t.queue}_trg()`,
    `CREATE TRIGGER ${t.table}_dispatch_pointer_upd AFTER UPDATE ON core.${t.table}
  FOR EACH ROW WHEN (${t.update})
  EXECUTE FUNCTION core.worker_dispatch_pointer_${t.queue}_trg()`,
    `CREATE TRIGGER ${t.table}_dispatch_pointer_del AFTER DELETE ON core.${t.table}
  FOR EACH ROW WHEN (OLD.status NOT IN (${t.terminal}))
  EXECUTE FUNCTION core.worker_dispatch_pointer_${t.queue}_trg()`,
    // E-4: a TRUNCATE removes rows without row triggers; drop that queue's pointers with them.
    `CREATE TRIGGER ${t.table}_dispatch_pointer_trunc AFTER TRUNCATE ON core.${t.table}
  FOR EACH STATEMENT EXECUTE FUNCTION core.worker_dispatch_pointer_${t.queue}_trg()`,
  ]),
];

export const OUTBOX_TRIGGERS_DOWN_SQL: readonly string[] = [
  LOCK_TIMEOUT_SQL,
  ...OUTBOX_TRIGGER_DDL.flatMap((t) => ['trunc', 'del', 'upd', 'ins'].map((s) => `DROP TRIGGER ${t.table}_dispatch_pointer_${s} ON core.${t.table}`)),
  ...[...OUTBOX_TRIGGER_FUNCTIONS].reverse().map((f) => `DROP FUNCTION ${f}`),
];

/** Run by down() under `SET LOCAL ROLE rab_secure_owner` (the owner-only policy hides the rows from anyone else). */
export const OUTBOX_POINTERS_PURGE_SQL = `DELETE FROM core.worker_dispatch_pointer WHERE queue IN ('email', 'push', 'realtime')`;

/** Post-condition of 1786721310000 (E-5 too): the twelve triggers, exactly where reviewed, ENABLED, firing the reviewed function. */
export const OUTBOX_TRIGGERS_STATE_SQL = `
SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) AS triggers FROM (
  SELECT c.relname || '.' || g.tgname || ':' || g.tgfoid::pg_catalog.regprocedure::text || ':' || g.tgenabled::text AS v
    FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid
   WHERE NOT g.tgisinternal AND g.tgfoid IN (${OUTBOX_TRIGGER_FUNCTIONS.map((f) => `'${f}'::pg_catalog.regprocedure`).join(', ')})
) x`;

export const OUTBOX_TRIGGERS_EXPECTED = OUTBOX_TRIGGER_DDL.flatMap((t) =>
  TRIGGER_SUFFIXES.map((s) => `${t.table}.${t.table}_dispatch_pointer_${s}:core.worker_dispatch_pointer_${t.queue}_trg():O`),
)
  .sort()
  .join(',');

/** E-10: post-condition of 1786721310000 on the three functions themselves (owner, DEFINER, search_path, exact ACL). */
export const OUTBOX_FUNCTIONS_STATE_SQL = `
SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) AS functions FROM (
  SELECT p.proname || ':' || pg_catalog.pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':'
         || COALESCE(pg_catalog.array_to_string(p.proconfig, ';'), '') || ':'
         || COALESCE((SELECT pg_catalog.string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END, '+' ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END)
                        FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), '') AS v
    FROM pg_catalog.pg_proc p
   WHERE p.oid IN (${OUTBOX_TRIGGER_FUNCTIONS.map((f) => `'${f}'::pg_catalog.regprocedure`).join(', ')})
) x`;

export const OUTBOX_FUNCTIONS_EXPECTED = ['email', 'push', 'realtime']
  .map((q) => `worker_dispatch_pointer_${q}_trg:rab_secure_owner:true:search_path=pg_catalog, pg_temp:rab_secure_owner`)
  .join(',');

/**
 * E-5 (moved here from tools/check-rls-coverage.ts in Phase D wave 2, unchanged, so the integration suite runs the same
 * code): the pointer triggers are what keeps global dispatch complete. crewflow owns the source tables and could DROP or
 * DISABLE them; dispatch would then silently fall back to the slow reconciliation cycle. Once an outbox trigger function
 * exists, its four triggers (ins / upd / del / trunc) exist on its own table, are ENABLED (tgenabled 'O') and fire exactly
 * that function; once the statement function has its live body, the same for core.payroll_record, and every workspace
 * payroll table that carries any statement trigger carries all four, enabled (a v18 workspace awaiting the migrator
 * carries none and passes — the golden posture pins the v19 `ws|trigger|` lines). Empty array = all present and enabled.
 */
export const DISPATCH_TRIGGER_SETS: ReadonlyArray<{ fn: string; table: string; prefix: string }> = [
  { fn: 'core.worker_dispatch_pointer_email_trg()', table: 'email_outbox', prefix: 'email_outbox_dispatch_pointer_' },
  { fn: 'core.worker_dispatch_pointer_push_trg()', table: 'push_delivery', prefix: 'push_delivery_dispatch_pointer_' },
  { fn: 'core.worker_dispatch_pointer_realtime_trg()', table: 'realtime_event', prefix: 'realtime_event_dispatch_pointer_' },
];
const DISPATCH_TRIGGER_SUFFIXES = ['del', 'ins', 'trunc', 'upd'] as const;

type ParamQuery = (sql: string, params?: readonly unknown[]) => Promise<Array<Record<string, unknown>>>;

export async function dispatchTriggerProblems(query: ParamQuery): Promise<string[]> {
  const problems: string[] = [];
  const triggersOn = async (relation: string, prefix: string) =>
    (await query(
      `SELECT t.tgname, t.tgfoid::regprocedure::text AS fn, t.tgenabled::text AS enabled FROM pg_trigger t
        WHERE t.tgrelid = to_regclass($1) AND NOT t.tgisinternal AND starts_with(t.tgname, $2) ORDER BY t.tgname`,
      [relation, prefix],
    )) as Array<{ tgname: string; fn: string; enabled: string }>;
  const expectSet = (where: string, rows: Array<{ tgname: string; fn: string; enabled: string }>, prefix: string, fn: string) => {
    const want = DISPATCH_TRIGGER_SUFFIXES.map((s) => `${prefix}${s}:${fn}:O`).join(',');
    const got = rows.map((r) => `${r.tgname}:${r.fn}:${r.enabled}`).join(',');
    if (got !== want) problems.push(`${where}: dispatch pointer triggers are [${got || 'none'}], expected [${want}] (present, ENABLED, reviewed function)`);
  };
  for (const set of DISPATCH_TRIGGER_SETS) {
    const rows = await query(`SELECT to_regprocedure($1) IS NOT NULL AS present`, [set.fn]);
    if (rows[0]?.present) expectSet(`core.${set.table}`, await triggersOn(`core.${set.table}`, set.prefix), set.prefix, set.fn);
  }
  const live = await query(
    `SELECT coalesce((SELECT strpos(p.prosrc, 'worker_dispatch_pointer') > 0 FROM pg_proc p WHERE p.oid = to_regprocedure($1)), false) AS live`,
    [STATEMENT_TRIGGER_FUNCTION],
  );
  if (live[0]?.live) {
    const prefix = 'payroll_record_statement_pointer_';
    expectSet('core.payroll_record', await triggersOn('core.payroll_record', prefix), prefix, STATEMENT_TRIGGER_FUNCTION);
    const schemas = (await query(`SELECT nspname FROM pg_namespace WHERE nspname ~ $1 ORDER BY 1`, ['^workspace_[0-9a-f]{32}$'])) as Array<{ nspname: string }>;
    for (const ws of schemas) {
      const rows = await triggersOn(`"${ws.nspname}".payroll_record`, prefix);
      if (rows.length > 0) expectSet(`${ws.nspname}.payroll_record`, rows, prefix, STATEMENT_TRIGGER_FUNCTION);
    }
  }
  return problems;
}

/** E-9: what must be gone (or inert) before 1786721300000's down() may drop the pointer table. */
export const POINTER_WRITERS_PRESENT_SQL = `
SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'core'::regnamespace
                  AND p.proname IN ('worker_dispatch_pointer_email_trg', 'worker_dispatch_pointer_push_trg', 'worker_dispatch_pointer_realtime_trg')) AS outbox_functions,
       EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('${STATEMENT_TRIGGER_FUNCTION}')
                  AND pg_catalog.strpos(p.prosrc, 'worker_dispatch_pointer') > 0) AS statement_function_live`;

// ---------------------------------------------------------------------------------------------------------------------
// 1786721320000 StatementDispatchPointer (core part; the triggers are workspace module v1.019)
// ---------------------------------------------------------------------------------------------------------------------

export const STATEMENT_TRIGGER_FUNCTION_UP_SQL: readonly string[] = [
  STATEMENT_TRIGGER_FUNCTION_SQL,
  `REVOKE ALL ON FUNCTION ${STATEMENT_TRIGGER_FUNCTION} FROM PUBLIC`,
  `ALTER FUNCTION ${STATEMENT_TRIGGER_FUNCTION} OWNER TO rab_secure_owner`,
  `REVOKE ALL ON FUNCTION ${STATEMENT_TRIGGER_FUNCTION} FROM crewflow_app, crewflow_worker`,
  // SECURITY TRADE-OFF (docs/plans/PHASE-D-SQL-GATE.md §1786721320000 (2)): CREATE TRIGGER checks EXECUTE on the function for the role creating
  // the trigger. New workspace schemas are built by crewflow (core.provision_workspace, crewflow-owned DEFINER, and the
  // TypeScript provisioner child), so crewflow needs it. A trigger function cannot be called directly; the grant only
  // lets crewflow ATTACH it, which the function itself confines (table name `payroll_record` — E-2 — schema owned by
  // rab_secure_owner — N-2: crewflow can create schemas but not ones it does not own — schema binding to
  // core or the row's own workspace, scope pairing, type guards) and which secure-owner-invariants.ts
  // (REVIEWED_SECURE_TRIGGER_ATTACHMENTS) reports anywhere else.
  `GRANT EXECUTE ON FUNCTION ${STATEMENT_TRIGGER_FUNCTION} TO crewflow`,
];

export const STATEMENT_FUNCTION_STATE_SQL = `
SELECT pg_catalog.pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':' || COALESCE(pg_catalog.array_to_string(p.proconfig, ';'), '') AS fn,
       (SELECT pg_catalog.string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END, ',' ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END)
          FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') AS executors
  FROM pg_catalog.pg_proc p WHERE p.oid = '${STATEMENT_TRIGGER_FUNCTION}'::pg_catalog.regprocedure`;

export const STATEMENT_FUNCTION_EXPECTED = {
  fn: 'rab_secure_owner:true:search_path=pg_catalog, pg_temp',
  executors: 'crewflow,rab_secure_owner',
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// 1786721330000 WorkerDueWorkClaimsToWorkerRole (D5: written, NOT applied — gated, see the migration's own comment)
// ---------------------------------------------------------------------------------------------------------------------

export const DUE_WORK_SIGNATURES = [
  'core.worker_claim_due_work(text, integer, integer)',
  'core.worker_complete_due_work(uuid, uuid)',
  'core.worker_reschedule_due_work(uuid, uuid, timestamp with time zone)',
] as const;

export const DUE_WORK_TO_WORKER_UP_SQL: readonly string[] = [
  ...DUE_WORK_SIGNATURES.map((f) => `REVOKE EXECUTE ON FUNCTION ${f} FROM crewflow, crewflow_app`),
  ...DUE_WORK_SIGNATURES.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO crewflow_worker`),
];

/** Exact reversal: the 1786682000000-era grants (crewflow, crewflow_app) back, crewflow_worker's removed. */
export const DUE_WORK_TO_WORKER_DOWN_SQL: readonly string[] = [
  ...DUE_WORK_SIGNATURES.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO crewflow, crewflow_app`),
  ...DUE_WORK_SIGNATURES.map((f) => `REVOKE EXECUTE ON FUNCTION ${f} FROM crewflow_worker`),
];

export const DUE_WORK_EXECUTORS_SQL = `
SELECT p.proname || ':' || COALESCE((SELECT pg_catalog.string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END, '+' ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END)
                                       FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), '') AS line
  FROM pg_catalog.pg_proc p
 WHERE p.oid IN (${DUE_WORK_SIGNATURES.map((f) => `'${f}'::pg_catalog.regprocedure`).join(', ')})
 ORDER BY 1`;

export const DUE_WORK_EXECUTORS_BEFORE = [
  'worker_claim_due_work:crewflow+crewflow_app+rab_secure_owner',
  'worker_complete_due_work:crewflow+crewflow_app+rab_secure_owner',
  'worker_reschedule_due_work:crewflow+crewflow_app+rab_secure_owner',
];
export const DUE_WORK_EXECUTORS_AFTER = [
  'worker_claim_due_work:crewflow_worker+rab_secure_owner',
  'worker_complete_due_work:crewflow_worker+rab_secure_owner',
  'worker_reschedule_due_work:crewflow_worker+rab_secure_owner',
];

// ---------------------------------------------------------------------------------------------------------------------
// 1786721340000 AccountInviteCleanupDefiner (F-1)
// ---------------------------------------------------------------------------------------------------------------------

export const INVITE_EXPIRE_SIGNATURE = 'core.worker_expire_account_invites(integer)';
export const INVITE_CANDIDATES_SIGNATURE = 'core.worker_account_invite_cleanup_candidates(integer, timestamp with time zone, uuid)';
export const INVITE_DELETE_SIGNATURE = 'core.worker_delete_expired_invited_user(uuid)';
export const INVITE_CLEANUP_SIGNATURES = [INVITE_EXPIRE_SIGNATURE, INVITE_CANDIDATES_SIGNATURE, INVITE_DELETE_SIGNATURE] as const;
export const INVITE_EXPIRE_BATCH_MAX = 500;
export const INVITE_CLEANUP_BATCH_MAX = 50;

/** Phase 1 of runAccountInviteCleanupCycle: the final (3rd) attempt expired unaccepted → user 'invited' → 'invite_expired'. */
export const INVITE_EXPIRE_SQL = `CREATE FUNCTION core.worker_expire_account_invites(p_limit integer)
RETURNS TABLE (user_id uuid, organisation_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict error
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, ${INVITE_EXPIRE_BATCH_MAX}), 1), ${INVITE_EXPIRE_BATCH_MAX});
BEGIN
  RETURN QUERY
  WITH due AS MATERIALIZED (
    SELECT u.id AS uid
      FROM core."user" u
      JOIN core.account_invite ai ON ai.user_id = u.id
     WHERE u.status = 'invited'
       AND ai.send_number = 3
       AND ai.accepted_at IS NULL
       AND ai.revoked_at IS NULL
       AND ai.expires_at < pg_catalog.now()
     ORDER BY ai.expires_at, u.id
     LIMIT v_limit
     FOR UPDATE OF u SKIP LOCKED
  )
  UPDATE core."user" x
     SET status = 'invite_expired'
    FROM due d
   WHERE x.id = d.uid AND x.status = 'invited'
  RETURNING x.id, x.organisation_id;
END
$fn$`;

/**
 * E-6: "never activated", enforced structurally in both phase-2 functions (all rab_secure_owner tables, no R4 growth): the
 * account has never signed in (`last_login_at IS NULL`) and has never had a refresh token or a web session (any row,
 * live or revoked). Such an account can never have created business history, so even a caller that skipped the Worker's
 * business checks cannot reach the SET NULL links (inventory in docs/plans/PHASE-D-SQL-GATE.md §1786721340000).
 */
const NEVER_ACTIVATED = (u: string) => `${u}.last_login_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM core.refresh_token rt WHERE rt.user_id = ${u}.id)
     AND NOT EXISTS (SELECT 1 FROM core.user_session us WHERE us.user_id = ${u}.id)`;

/**
 * The skip reasons both phase-2 functions report, in this precedence (N-4: a user excluded by the E-6 guard is RETURNED
 * with its reason so the Worker writes a `user.invite_cleanup_skipped` audit row, never silently left out):
 *   'manager_workspace' owns a workspace · 'platform_admin' has a platform-admin row · 'signed_in' last_login_at is set ·
 *   'had_session' any refresh_token or user_session row exists (live or revoked) · NULL = eligible for deletion.
 */
export const INVITE_CLEANUP_SKIP_REASONS = ['manager_workspace', 'platform_admin', 'signed_in', 'had_session'] as const;
const SKIP_REASON = (u: string) => `CASE
           WHEN EXISTS (SELECT 1 FROM core.manager_workspace mw WHERE mw.owner_user_id = ${u}.id) THEN 'manager_workspace'
           WHEN EXISTS (SELECT 1 FROM core.platform_admin pa WHERE pa.user_id = ${u}.id) THEN 'platform_admin'
           WHEN ${u}.last_login_at IS NOT NULL THEN 'signed_in'
           WHEN EXISTS (SELECT 1 FROM core.refresh_token rt WHERE rt.user_id = ${u}.id)
             OR EXISTS (SELECT 1 FROM core.user_session us WHERE us.user_id = ${u}.id) THEN 'had_session'
           ELSE NULL
         END`;

/**
 * Phase 2 candidates (keyset page): 'invite_expired', final attempt, grace period over — every such user, with
 * blocking_reason = the first skip reason above or NULL (eligible). The business history checks (crewflow-owned tables,
 * core and workspace schemas) stay in the Worker, under tenant context, for the NULL rows only.
 * Return shape (unchanged columns): TABLE(user_id uuid, organisation_id uuid, cleanup_at timestamptz, blocking_reason text).
 */
export const INVITE_CANDIDATES_SQL = `CREATE FUNCTION core.worker_account_invite_cleanup_candidates(p_limit integer, p_after_cleanup_at timestamptz, p_after_user_id uuid)
RETURNS TABLE (user_id uuid, organisation_id uuid, cleanup_at timestamptz, blocking_reason text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT u.id, u.organisation_id, ai.cleanup_at,
         ${SKIP_REASON('u')}
    FROM core."user" u
    JOIN core.account_invite ai ON ai.user_id = u.id
   WHERE u.status = 'invite_expired'
     AND ai.send_number = 3
     AND ai.cleanup_at IS NOT NULL
     AND ai.cleanup_at < pg_catalog.now()
     AND (p_after_cleanup_at IS NULL OR ai.cleanup_at > p_after_cleanup_at
          OR (ai.cleanup_at = p_after_cleanup_at AND p_after_user_id IS NOT NULL AND u.id > p_after_user_id))
   ORDER BY ai.cleanup_at, u.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, ${INVITE_CLEANUP_BATCH_MAX}), 1), ${INVITE_CLEANUP_BATCH_MAX})
$fn$`;

/**
 * Phase 2 delete, one user: re-verifies every secure-table condition under the user's row lock and deletes; a remaining
 * business reference (NO ACTION / RESTRICT foreign key) retains the user ('referenced') instead of failing the tick.
 * Returns 'deleted' | 'not_eligible' (not invite_expired / not the final attempt / grace not over / unknown) |
 * 'manager_workspace' | 'platform_admin' | 'signed_in' | 'had_session' (E-6 / N-4) | 'referenced'.
 */
export const INVITE_DELETE_SQL = `CREATE FUNCTION core.worker_delete_expired_invited_user(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_uid uuid;
  v_reason text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 'not_eligible';
  END IF;
  SELECT u.id, ${SKIP_REASON('u')} INTO v_uid, v_reason
    FROM core."user" u
    JOIN core.account_invite ai ON ai.user_id = u.id
   WHERE u.id = p_user_id
     AND u.status = 'invite_expired'
     AND ai.send_number = 3
     AND ai.cleanup_at IS NOT NULL
     AND ai.cleanup_at < pg_catalog.now()
   FOR UPDATE OF u;
  IF v_uid IS NULL THEN
    RETURN 'not_eligible';
  END IF;
  IF v_reason IS NOT NULL THEN
    RETURN v_reason;
  END IF;
  BEGIN
    DELETE FROM core."user" u WHERE u.id = v_uid AND u.status = 'invite_expired'
       AND ${NEVER_ACTIVATED('u')};
  EXCEPTION WHEN foreign_key_violation THEN
    RETURN 'referenced';
  END;
  RETURN 'deleted';
END
$fn$`;

export const INVITE_CLEANUP_UP_SQL: readonly string[] = [
  INVITE_EXPIRE_SQL,
  INVITE_CANDIDATES_SQL,
  INVITE_DELETE_SQL,
  ...INVITE_CLEANUP_SIGNATURES.map((f) => `REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`),
  ...INVITE_CLEANUP_SIGNATURES.map((f) => `ALTER FUNCTION ${f} OWNER TO rab_secure_owner`),
  ...INVITE_CLEANUP_SIGNATURES.map((f) => `REVOKE ALL ON FUNCTION ${f} FROM crewflow, crewflow_app`),
  ...INVITE_CLEANUP_SIGNATURES.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO crewflow_worker`),
];

export const INVITE_CLEANUP_DOWN_SQL: readonly string[] = [...INVITE_CLEANUP_SIGNATURES].reverse().map((f) => `DROP FUNCTION ${f}`);

export const INVITE_CLEANUP_STATE_SQL = `
SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) AS functions FROM (
  SELECT p.proname || ':' || pg_catalog.pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':'
         || COALESCE(pg_catalog.array_to_string(p.proconfig, ';'), '') || ':'
         || COALESCE((SELECT pg_catalog.string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END, '+' ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END)
                        FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), '') AS v
    FROM pg_catalog.pg_proc p
   WHERE p.oid IN (${INVITE_CLEANUP_SIGNATURES.map((f) => `'${f}'::pg_catalog.regprocedure`).join(', ')})
) x`;

export const INVITE_CLEANUP_EXPECTED = [
  'worker_account_invite_cleanup_candidates:rab_secure_owner:true:search_path=pg_catalog, pg_temp:crewflow_worker+rab_secure_owner',
  'worker_delete_expired_invited_user:rab_secure_owner:true:search_path=pg_catalog, pg_temp:crewflow_worker+rab_secure_owner',
  'worker_expire_account_invites:rab_secure_owner:true:search_path=pg_catalog, pg_temp:crewflow_worker+rab_secure_owner',
].join(',');

/** Every rab_secure_owner function body this file creates (for the offline Phase 0b scans). */
export const ALL_SECURE_FUNCTION_SQL: Readonly<Record<string, string>> = {
  claim_impl: CLAIM_IMPL_SQL,
  ...Object.fromEntries(DISPATCH_QUEUES.map((q) => [`claim_${q}`, claimWrapperSql(q)])),
  release: RELEASE_SQL,
  trg_email: OUTBOX_TRIGGER_FUNCTION_SQL.email,
  trg_push: OUTBOX_TRIGGER_FUNCTION_SQL.push,
  trg_realtime: OUTBOX_TRIGGER_FUNCTION_SQL.realtime,
  trg_statement: STATEMENT_TRIGGER_FUNCTION_SQL,
  trg_statement_inert: STATEMENT_TRIGGER_FUNCTION_INERT_SQL,
  invite_expire: INVITE_EXPIRE_SQL,
  invite_candidates: INVITE_CANDIDATES_SQL,
  invite_delete: INVITE_DELETE_SQL,
};


// =====================================================================================================================
// F2 (PROPOSED, NOT APPROVED, NOT RUN): migration 1786721350000-StatementPointerPhysicalIdentity. The approved constants
// above stay byte-identical (1786721300000 / 1310000 / 1320000 import them); 1350000 uses only the F2_* builders below.
// Pointer identity = the physical source row: (queue, subject_id, source_schema), where source_schema is 'core' or the
// row's own 'workspace_<hex>' (checked by the statement trigger's place guard and by worker_dispatch_pointer_source_check).
// A write to one copy of a payroll_record therefore only ever touches that copy's own pointer. Sibling retirement: when a
// copy's statement_file_id is set, the same record's other copies in the SAME workspace lose their pointers, because
// generation is fenced per record id across copies (core.worker_event.event_key 'shift-statement:<id>' is UNIQUE). These
// notes live here, not in the SQL bodies: Phase 0b R4 scans function bodies word by word, comments included.
// The claim gives every claimed row its own token, so a release can only ever re-time the row it was handed.
// =====================================================================================================================
function f2UpsertSql(q: DispatchQueueLabel, ws: string, src: string): string {
  return `  INSERT INTO core.worker_dispatch_pointer AS w (queue, subject_id, source_schema, organisation_id, workspace_id, due_at)
  VALUES ('${q}', NEW.id, ${src}, NEW.organisation_id, ${ws}, v_due)
  ON CONFLICT (queue, subject_id, source_schema) DO UPDATE
     SET organisation_id = EXCLUDED.organisation_id,
         workspace_id = EXCLUDED.workspace_id,
         due_at = EXCLUDED.due_at,
         claim_token = NULL,
         claimed_at = NULL,
         repoint_count = w.repoint_count
           + CASE WHEN w.organisation_id IS DISTINCT FROM EXCLUDED.organisation_id
                    OR w.workspace_id IS DISTINCT FROM EXCLUDED.workspace_id THEN 1 ELSE 0 END,
         updated_at = pg_catalog.now();`;
}

function f2OutboxTriggerFunctionSql(t: OutboxTrigger): string {
  const ws = t.workspaceScoped ? 'NEW.workspace_id' : 'NULL::uuid';
  const scopeChanged = t.workspaceScoped
    ? 'OLD.id IS DISTINCT FROM NEW.id OR OLD.organisation_id IS DISTINCT FROM NEW.organisation_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id'
    : 'OLD.id IS DISTINCT FROM NEW.id OR OLD.organisation_id IS DISTINCT FROM NEW.organisation_id';
  const pairing = t.workspaceScoped
    ? `
  IF NEW.workspace_id IS NOT NULL THEN
    SELECT mw.organisation_id INTO v_ws_org FROM core.manager_workspace mw WHERE mw.id = NEW.workspace_id;
    IF v_ws_org IS DISTINCT FROM NEW.organisation_id THEN
      ${SCOPE_MISMATCH_ERROR};
    END IF;
  END IF;`
    : '';
  return `CREATE OR REPLACE FUNCTION core.worker_dispatch_pointer_${t.queue}_trg()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_due timestamptz;${t.workspaceScoped ? '\n  v_ws_org uuid;' : ''}
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'core' OR TG_TABLE_NAME IS DISTINCT FROM '${t.table}' OR TG_WHEN IS DISTINCT FROM 'AFTER' THEN
    ${PLACE_ERROR};
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    IF TG_LEVEL IS DISTINCT FROM 'STATEMENT' THEN
      ${PLACE_ERROR};
    END IF;
    DELETE FROM core.worker_dispatch_pointer w WHERE w.queue = '${t.queue}';
    RETURN NULL;
  END IF;
  IF TG_LEVEL IS DISTINCT FROM 'ROW' THEN
    ${PLACE_ERROR};
  END IF;
  IF TG_OP = 'DELETE' THEN
${typeGuards('OLD', [['id', 'uuid']])}
    DELETE FROM core.worker_dispatch_pointer w WHERE w.queue = '${t.queue}' AND w.subject_id = OLD.id;
    RETURN NULL;
  END IF;
${typeGuards('NEW', t.columns)}
  IF TG_OP = 'UPDATE' THEN
    IF ${scopeChanged} THEN
      ${SCOPE_CHANGE_ERROR};
    END IF;
  END IF;
  v_due := ${t.due};
  IF v_due IS NULL THEN
    DELETE FROM core.worker_dispatch_pointer w WHERE w.queue = '${t.queue}' AND w.subject_id = NEW.id;
    RETURN NULL;
  END IF;${pairing}
${f2UpsertSql(t.queue, ws, "'core'")}
${notifyBlock(t.queue)}
  RETURN NULL;
END
$fn$`;
}

export const F2_CLAIM_IMPL_SQL = `CREATE OR REPLACE FUNCTION ${IMPL_SIGNATURE.replace('(text, integer, integer, integer)', '(p_queue text, p_limit integer, p_lease_seconds integer, p_per_org integer)')}
RETURNS TABLE (${CLAIM_COLUMNS})
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict error
DECLARE
  v_limit   integer;
  v_now     timestamptz := pg_catalog.clock_timestamp();
  v_lease   timestamptz;
  v_pivot   uuid := pg_catalog.gen_random_uuid();
  v_orgs    uuid[] := ARRAY[]::uuid[];
  v_cursor  uuid := NULL;
  v_next    uuid;
  v_due     timestamptz;
  v_steps   integer := 0;
  v_wrapped boolean := false;
BEGIN
  IF p_queue IS NULL OR p_queue NOT IN (${QUEUE_LIST}) THEN
    RAISE EXCEPTION 'worker dispatch claim: unknown queue' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300 OR p_per_org IS NULL OR p_per_org NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'worker dispatch claim: invalid server-side lease or cap' USING ERRCODE = '22023';
  END IF;
  v_limit := LEAST(GREATEST(COALESCE(p_limit, ${CLAIM_BATCH_DEFAULT}), 1), ${CLAIM_BATCH_MAX});

  LOOP
    EXIT WHEN pg_catalog.cardinality(v_orgs) >= v_limit OR v_steps >= ${CLAIM_MAX_ORG_STEPS};
    v_steps := v_steps + 1;
    v_next := NULL;
    v_due := NULL;
    IF NOT v_wrapped THEN
      IF v_cursor IS NULL THEN
        SELECT p.organisation_id, p.due_at INTO v_next, v_due
          FROM core.worker_dispatch_pointer p
         WHERE p.queue = p_queue AND p.organisation_id >= v_pivot
         ORDER BY p.organisation_id, p.due_at
         LIMIT 1;
      ELSE
        SELECT p.organisation_id, p.due_at INTO v_next, v_due
          FROM core.worker_dispatch_pointer p
         WHERE p.queue = p_queue AND p.organisation_id > v_cursor
         ORDER BY p.organisation_id, p.due_at
         LIMIT 1;
      END IF;
      IF v_next IS NULL THEN
        v_wrapped := true;
        v_cursor := NULL;
        CONTINUE;
      END IF;
    ELSE
      IF v_cursor IS NULL THEN
        SELECT p.organisation_id, p.due_at INTO v_next, v_due
          FROM core.worker_dispatch_pointer p
         WHERE p.queue = p_queue AND p.organisation_id < v_pivot
         ORDER BY p.organisation_id, p.due_at
         LIMIT 1;
      ELSE
        SELECT p.organisation_id, p.due_at INTO v_next, v_due
          FROM core.worker_dispatch_pointer p
         WHERE p.queue = p_queue AND p.organisation_id > v_cursor AND p.organisation_id < v_pivot
         ORDER BY p.organisation_id, p.due_at
         LIMIT 1;
      END IF;
      EXIT WHEN v_next IS NULL;
    END IF;
    v_cursor := v_next;
    IF v_due <= v_now THEN
      v_orgs := v_orgs || v_next;
    END IF;
  END LOOP;

  IF pg_catalog.cardinality(v_orgs) = 0 THEN
    RETURN;
  END IF;

  v_lease := pg_catalog.clock_timestamp();
  RETURN QUERY
  WITH cand AS MATERIALIZED (
    SELECT x.sid, x.src, x.due
      FROM pg_catalog.unnest(v_orgs) AS o(org)
      CROSS JOIN LATERAL (
        SELECT p.subject_id AS sid, p.source_schema AS src, p.due_at AS due
          FROM core.worker_dispatch_pointer p
         WHERE p.queue = p_queue AND p.organisation_id = o.org AND p.due_at <= v_now
         ORDER BY p.due_at
         LIMIT p_per_org) x
     ORDER BY x.due
     LIMIT v_limit
  ), picked AS MATERIALIZED (
    SELECT p.subject_id AS sid, p.source_schema AS src
      FROM core.worker_dispatch_pointer p
      JOIN cand c ON c.sid = p.subject_id AND c.src = p.source_schema
     WHERE p.queue = p_queue AND p.due_at <= v_now
     FOR UPDATE OF p SKIP LOCKED
  )
  UPDATE core.worker_dispatch_pointer w
     SET due_at = v_lease + pg_catalog.make_interval(secs => p_lease_seconds),
         claim_token = pg_catalog.gen_random_uuid(),
         claim_count = w.claim_count + 1,
         claimed_at = v_lease,
         updated_at = v_lease
    FROM picked k
   WHERE w.queue = p_queue AND w.subject_id = k.sid AND w.source_schema = k.src
  RETURNING w.subject_id, w.organisation_id, w.workspace_id, w.claim_token, w.claim_count;
END
$fn$`;

export const F2_STATEMENT_TRIGGER_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION ${STATEMENT_TRIGGER_FUNCTION}
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_due timestamptz;
  v_ws_org uuid;
  v_ws uuid;
  v_src text;
BEGIN
  IF TG_TABLE_NAME IS DISTINCT FROM 'payroll_record' OR TG_WHEN IS DISTINCT FROM 'AFTER' THEN
    ${PLACE_ERROR};
  END IF;
  IF (SELECT n.nspowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = TG_RELID)
       IS DISTINCT FROM 'rab_secure_owner'::pg_catalog.regrole::pg_catalog.oid THEN
    ${PLACE_ERROR};
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    IF TG_LEVEL IS DISTINCT FROM 'STATEMENT' THEN
      ${PLACE_ERROR};
    END IF;
    IF TG_TABLE_SCHEMA = 'core' THEN
      DELETE FROM core.worker_dispatch_pointer w WHERE w.queue = 'statement' AND w.source_schema = 'core';
    ELSIF TG_TABLE_SCHEMA ~ '^workspace_[0-9a-f]{32}$' THEN
      DELETE FROM core.worker_dispatch_pointer w
       WHERE w.queue = 'statement' AND w.source_schema = TG_TABLE_SCHEMA
         AND w.workspace_id = (pg_catalog.substr(TG_TABLE_SCHEMA, 11))::uuid;
    ELSE
      ${PLACE_ERROR};
    END IF;
    RETURN NULL;
  END IF;
  IF TG_LEVEL IS DISTINCT FROM 'ROW' THEN
    ${PLACE_ERROR};
  END IF;
  IF TG_OP = 'DELETE' THEN
${typeGuards('OLD', [['id', 'uuid'], ['organisation_id', 'uuid'], ['workspace_id', 'uuid']])}
    v_ws := OLD.workspace_id;
  ELSE
${typeGuards('NEW', [
  ['id', 'uuid'],
  ['organisation_id', 'uuid'],
  ['workspace_id', 'uuid'],
  ['status', 'text'],
  ['statement_status', 'text'],
  ['statement_file_id', 'uuid'],
  ['statement_attempts', 'int4'],
  ['statement_queued_at', 'timestamptz'],
  ['statement_processing_at', 'timestamptz'],
  ['updated_at', 'timestamptz'],
])}
    v_ws := NEW.workspace_id;
  END IF;
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'core'
     AND TG_TABLE_SCHEMA IS DISTINCT FROM ('workspace_' || pg_catalog.replace(v_ws::text, '-', '')) THEN
    ${PLACE_ERROR};
  END IF;
  v_src := TG_TABLE_SCHEMA;
  IF TG_OP = 'DELETE' THEN
    DELETE FROM core.worker_dispatch_pointer w
     WHERE w.queue = 'statement' AND w.subject_id = OLD.id AND w.source_schema = v_src;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id IS DISTINCT FROM NEW.id OR OLD.organisation_id IS DISTINCT FROM NEW.organisation_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
      ${SCOPE_CHANGE_ERROR};
    END IF;
    IF OLD.statement_file_id IS NULL AND NEW.statement_file_id IS NOT NULL THEN
      DELETE FROM core.worker_dispatch_pointer w
       WHERE w.queue = 'statement' AND w.subject_id = NEW.id AND w.workspace_id = NEW.workspace_id
         AND w.source_schema <> v_src;
    END IF;
  END IF;
  v_due := NULL;
  IF NEW.workspace_id IS NOT NULL AND NEW.status IN ('approved', 'processing', 'paid') AND NEW.statement_file_id IS NULL THEN
    v_due := CASE
      WHEN NEW.statement_status IN ('none', 'pending') THEN pg_catalog.now()
      WHEN NEW.statement_status IN ('queued', 'processing')
        THEN COALESCE(NEW.statement_processing_at, NEW.statement_queued_at, NEW.updated_at) + pg_catalog.make_interval(mins => ${DUE_CONSTANTS.statementLeaseMinutes})
      WHEN NEW.statement_status = 'failed' AND NEW.statement_attempts < ${DUE_CONSTANTS.statementMaxAttempts}
        THEN NEW.updated_at + pg_catalog.make_interval(mins => ${DUE_CONSTANTS.statementRetryBackoffMinutes} * NEW.statement_attempts)
      ELSE NULL END;
  END IF;
  IF v_due IS NULL THEN
    DELETE FROM core.worker_dispatch_pointer w
     WHERE w.queue = 'statement' AND w.subject_id = NEW.id AND w.source_schema = v_src;
    RETURN NULL;
  END IF;
  SELECT mw.organisation_id INTO v_ws_org FROM core.manager_workspace mw WHERE mw.id = NEW.workspace_id;
  IF v_ws_org IS DISTINCT FROM NEW.organisation_id THEN
    ${SCOPE_MISMATCH_ERROR};
  END IF;
${f2UpsertSql('statement', 'NEW.workspace_id', 'v_src')}
${notifyBlock('statement')}
  RETURN NULL;
END
$fn$`;

export const F2_OUTBOX_TRIGGER_FUNCTION_SQL: Readonly<Record<'email' | 'push' | 'realtime', string>> = {
  email: f2OutboxTriggerFunctionSql(OUTBOX_TRIGGERS[0]!),
  push: f2OutboxTriggerFunctionSql(OUTBOX_TRIGGERS[1]!),
  realtime: f2OutboxTriggerFunctionSql(OUTBOX_TRIGGERS[2]!),
};

/** Runs as rab_secure_owner inside the migration transaction (F2_ROLE_ASSERT_SQL first). */
export const F2_ROLE_ASSERT_SQL = `DO $assert$
BEGIN
  IF CURRENT_USER IS DISTINCT FROM 'rab_secure_owner'::name THEN
    RAISE EXCEPTION 'StatementPointerPhysicalIdentity must run as rab_secure_owner inside its migration transaction' USING ERRCODE = '42501';
  END IF;
END
$assert$`;
export const F2_TABLE_UP_SQL: readonly string[] = [
  `ALTER TABLE core.worker_dispatch_pointer ADD COLUMN source_schema text NOT NULL DEFAULT 'core'`,
  `ALTER TABLE core.worker_dispatch_pointer ADD CONSTRAINT worker_dispatch_pointer_source_check CHECK (
    source_schema = 'core'
    OR (queue = 'statement' AND workspace_id IS NOT NULL
        AND source_schema = 'workspace_' || pg_catalog.replace(workspace_id::text, '-', '')))`,
  // Existing statement pointers have no known source. They are routing hints: removing them delays nothing in per_scope
  // mode; in global mode each is re-created by the record's next write, and until then the per-workspace legacy sweep
  // (at most WORKER_DISPATCH_RECONCILE_SECONDS) still finds the work. Global mode is not active before this release.
  `DELETE FROM core.worker_dispatch_pointer WHERE queue = 'statement'`,
  `ALTER TABLE core.worker_dispatch_pointer DROP CONSTRAINT worker_dispatch_pointer_pkey`,
  `ALTER TABLE core.worker_dispatch_pointer ADD CONSTRAINT worker_dispatch_pointer_pkey PRIMARY KEY (queue, subject_id, source_schema)`,
];
export const F2_TABLE_DOWN_SQL: readonly string[] = [
  `DELETE FROM core.worker_dispatch_pointer WHERE queue = 'statement'`,
  `ALTER TABLE core.worker_dispatch_pointer DROP CONSTRAINT worker_dispatch_pointer_pkey`,
  `ALTER TABLE core.worker_dispatch_pointer ADD CONSTRAINT worker_dispatch_pointer_pkey PRIMARY KEY (queue, subject_id)`,
  `ALTER TABLE core.worker_dispatch_pointer DROP CONSTRAINT worker_dispatch_pointer_source_check`,
  `ALTER TABLE core.worker_dispatch_pointer DROP COLUMN source_schema`,
];
/** HWS cutover sweep (operator, as rab_secure_owner, per workspace W after routing switched to its schema). */
export const F2_CUTOVER_SWEEP_SQL = `DELETE FROM core.worker_dispatch_pointer
 WHERE queue = 'statement' AND workspace_id = $1::uuid
   AND source_schema IS DISTINCT FROM 'workspace_' || pg_catalog.replace($1::text, '-', '')`;

/** F2 post-condition: the pointer key, the source check and the column (after up() / after down()). */
export const F2_TABLE_STATE_SQL = `
SELECT
  (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'core.worker_dispatch_pointer'::regclass AND c.conname = 'worker_dispatch_pointer_pkey') AS pkey,
  (SELECT pg_catalog.count(*)::int FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'core.worker_dispatch_pointer'::regclass AND c.conname = 'worker_dispatch_pointer_source_check') AS source_check,
  (SELECT pg_catalog.count(*)::int FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'core.worker_dispatch_pointer'::regclass AND a.attname = 'source_schema' AND NOT a.attisdropped) AS source_column`;
export const F2_TABLE_EXPECTED_UP = { pkey: 'PRIMARY KEY (queue, subject_id, source_schema)', source_check: 1, source_column: 1 } as const;
export const F2_TABLE_EXPECTED_DOWN = { pkey: 'PRIMARY KEY (queue, subject_id)', source_check: 0, source_column: 0 } as const;

/** The five functions whose bodies 1786721350000 replaces, with the SQL each must carry after up() and after down(). */
export const F2_FUNCTIONS: ReadonlyArray<{ signature: string; up: string; down: string }> = [
  { signature: IMPL_SIGNATURE, up: F2_CLAIM_IMPL_SQL, down: CLAIM_IMPL_SQL },
  ...(['email', 'push', 'realtime'] as const).map((q) => ({
    signature: `core.worker_dispatch_pointer_${q}_trg()`,
    up: F2_OUTBOX_TRIGGER_FUNCTION_SQL[q],
    down: OUTBOX_TRIGGER_FUNCTION_SQL[q],
  })),
  { signature: STATEMENT_TRIGGER_FUNCTION, up: F2_STATEMENT_TRIGGER_FUNCTION_SQL, down: STATEMENT_TRIGGER_FUNCTION_SQL },
];

/** `pg_proc.prosrc` of a CREATE [OR REPLACE] FUNCTION ... AS $fn$<body>$fn$ statement: the text between the quotes. */
export function functionBody(sql: string): string {
  const open = sql.indexOf('$fn$');
  const close = sql.lastIndexOf('$fn$');
  if (open < 0 || close <= open) throw new Error('functionBody: no $fn$ body');
  return sql.slice(open + 4, close);
}

/** CREATE FUNCTION → CREATE OR REPLACE FUNCTION (down() re-creates the approved bodies over the F2 ones). */
export function orReplace(sql: string): string {
  return sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION ');
}
