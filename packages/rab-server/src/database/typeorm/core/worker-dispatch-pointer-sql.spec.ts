import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SHIFT_STATEMENT_MAX_ATTEMPTS } from '../../../modules/payroll/constants/shift-statement';
import { migrationSourceViolations } from './migration-source-rules';
import {
  DYNAMIC_SQL_SECURE_DEFINERS_SQL,
  R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS,
  R4_PHASE_D_MISSING_PAIRS_SQL,
  R4_PHASE_D_TRIGGER_PAIRS,
  R4_TABLES_SQL,
  REVIEWED_DYNAMIC_SQL_SECURE_DEFINERS,
  REVIEWED_SECURE_TRIGGER_ATTACHMENTS,
  secureOwnerInvariantViolations,
} from './secure-owner-invariants';
import { statementDispatchPointerSql, STATEMENT_POINTER_TRIGGER_NAMES } from '../workspace-schema/v1/statement-dispatch-pointer';
import {
  ALL_SECURE_FUNCTION_SQL,
  CLAIM_SIGNATURES,
  DISPATCH_QUEUE_SETTINGS,
  DISPATCH_QUEUES,
  DUE_CONSTANTS,
  DUE_WORK_TO_WORKER_DOWN_SQL,
  DUE_WORK_TO_WORKER_UP_SQL,
  expectedWorkerDispatchPrivilegeLines,
  CLAIM_IMPL_SQL,
  INVITE_CANDIDATES_SQL,
  INVITE_CLEANUP_UP_SQL,
  INVITE_CLEANUP_SKIP_REASONS,
  INVITE_DELETE_SQL,
  LOCK_TIMEOUT_SQL,
  NOTIFY_SETTING,
  OUTBOX_TRIGGER_FUNCTION_SQL,
  OUTBOX_TRIGGER_NAMES,
  OUTBOX_TRIGGERS_DOWN_SQL,
  OUTBOX_TRIGGERS_UP_SQL,
  POINTER_WRITERS_PRESENT_SQL,
  RELEASE_SQL,
  TRIGGER_FUNCTION_TABLE,
  STATEMENT_TRIGGER_FUNCTION_SQL,
  STATEMENT_TRIGGER_FUNCTION_UP_SQL,
  WAKE_CHANNEL,
  WORKER_DISPATCH_POINTER_UP_SQL,
  WorkerRoleFacts,
  workerRoleProblems,
} from './worker-dispatch-pointer-sql';

/**
 * Phase D SQL (owner-approved 2026-11-01): offline checks — no database. The authoritative checks are the catalog ones
 * (secureOwnerInvariantViolations in each migration's self-check and in the M2 harness); these catch a mistake at
 * unit-test time, before anyone asks for approval of a changed text.
 */

/**
 * crewflow-owned (non-rab_secure_owner) core tables, read from the catalog of a database at main 3654d0b8 (rab_c1d,
 * read-only query, 2026-10-31). Any of these named in a rab_secure_owner definer body joins Phase 0b's frozen R4 list.
 */
const CREWFLOW_OWNED_CORE_TABLES = `admin_inspect_session ai_action_proposal ai_agent ai_agent_event ai_agent_trigger ai_conversation
ai_input_request ai_message ai_skill ai_usage ai_usage_daily attendance attendance_correction audit_log email_outbox
host_label_claim hws_backfill_checkpoint job_offer job_role manager_profile manager_venue migrations navigation_layout
notification notification_preference oauth_transaction_state organisation_ai_assistant organisation_ai_instruction
organisation_ai_model_policy organisation_ai_model_preference organisation_ai_setting organisation_member payroll_calendar
payroll_calendar_period payroll_record payroll_run payroll_run_line payslip payslip_document permission platform_config
push_delivery push_device realtime_event replacement_request reserved_host_label role role_field_permission
role_object_permission role_permission shift shift_assignment shift_report shift_request_staff shift_staff_review
staff_profile stored_file user_note user_permission_override user_preference user_role venue venue_manager_staff
venue_role_rate worker_event workspace_membership workspace_schema_migration workspace_schema_registry`.split(/\s+/);

/** Built-ins a body may call (all resolve in pg_catalog), plus the one core function they may call. */
const ALLOWED_CALLS = new Set([
  'now', 'clock_timestamp', 'gen_random_uuid', 'make_interval', 'cardinality', 'unnest', 'pg_typeof', 'pg_notify', 'replace', 'least',
  'greatest', 'current_setting', 'substr', 'coalesce', 'exists', 'in', 'values', 'array', 'check', 'core.worker_dispatch_claim_impl',
  'lateral', 'limit', 'o',
]);
/** SQL keywords that precede a parenthesis without being a call. */
const KEYWORDS = new Set(['and', 'or', 'not', 'when', 'then', 'where', 'materialized', 'as', 'on', 'w', 'select', 'else', 'return', 'from', 'if', 'conflict']);
/** The only relations a body may name. */
const ALLOWED_RELATIONS = new Set([
  'core.worker_dispatch_pointer', 'core.manager_workspace', 'core."user"', 'core.account_invite', 'core.platform_admin', 'core.refresh_token',
  'core.user_session', 'core.worker_dispatch_claim_impl',
]);
/** E-2: the one crewflow-owned table each trigger function may name — only inside its TG_TABLE_NAME check. */
const OWN_TABLE: Readonly<Record<string, string>> = {
  trg_email: TRIGGER_FUNCTION_TABLE.email,
  trg_push: TRIGGER_FUNCTION_TABLE.push,
  trg_realtime: TRIGGER_FUNCTION_TABLE.realtime,
  trg_statement: TRIGGER_FUNCTION_TABLE.statement,
};

function body(sql: string): string {
  const m = /\$fn\$([\s\S]*)\$fn\$/.exec(sql);
  if (!m) throw new Error(`no $fn$ body in ${sql.slice(0, 80)}`);
  return m[1]!;
}

describe('Phase D dispatch pointer SQL — Phase 0b rules for every rab_secure_owner function (offline)', () => {
  const entries = Object.entries(ALL_SECURE_FUNCTION_SQL);

  it('covers all 15 functions', () => {
    expect(entries.map(([k]) => k).sort()).toEqual(
      ['claim_email', 'claim_impl', 'claim_push', 'claim_realtime', 'claim_statement', 'invite_candidates', 'invite_delete', 'invite_expire',
        'release', 'trg_email', 'trg_push', 'trg_realtime', 'trg_statement', 'trg_statement_inert'].sort(),
    );
  });

  it.each(entries)('%s: search_path pinned to pg_catalog, pg_temp; explicit SECURITY clause', (_k, sql) => {
    expect(sql).toMatch(/\nSET search_path = pg_catalog, pg_temp\n/);
    expect(sql).toMatch(/SECURITY (DEFINER|INVOKER)/);
  });

  it.each(entries)('%s: no dynamic SQL keyword anywhere in the body (the Phase 0b scan counts comments too)', (_k, sql) => {
    expect(body(sql)).not.toMatch(/\bEXECUTE\b/i);
  });

  it.each(entries)('%s: names no crewflow-owned core table except its own in the TG_TABLE_NAME binding (E-2; R4 otherwise frozen)', (k, sql) => {
    let b = body(sql);
    const own = OWN_TABLE[k];
    if (own) {
      const binding = `TG_TABLE_NAME IS DISTINCT FROM '${own}'`;
      expect(b.split(binding)).toHaveLength(2); // bound exactly once
      b = b.split(binding).join('');
      expect(R4_PHASE_D_TRIGGER_PAIRS).toContainEqual({ fn: k.replace('trg_', 'worker_dispatch_pointer_') + '_trg', table: own });
    }
    const hits = CREWFLOW_OWNED_CORE_TABLES.filter((t) => new RegExp(`\\b(core\\.)?"?${t}"?\\b`, 'i').test(b));
    expect(hits).toEqual([]);
  });

  it.each(entries)('%s: calls only pg_catalog built-ins or the claim body; names only reviewed relations', (_k, sql) => {
    const b = body(sql).replace(/'[^']*'/g, "''");
    const calls = [...b.matchAll(/((?:core\.)?[a-z_][a-z0-9_]*)\s*\(/gi)].map((m) => m[1]!.toLowerCase().replace(/^pg_catalog\./, ''));
    expect(calls.filter((c) => !ALLOWED_CALLS.has(c) && !KEYWORDS.has(c) && !/^p_|^v_/.test(c))).toEqual([]);
    const relations = [...b.matchAll(/\bcore\.("?[a-z_]+"?)/gi)].map((m) => `core.${m[1]}`);
    expect(relations.filter((r) => !ALLOWED_RELATIONS.has(r))).toEqual([]);
    // Every pg_catalog function called by name is schema-qualified (only SQL keywords / constructs are bare).
    const bare = [...b.matchAll(/(?<![.\w])([a-z_][a-z0-9_]*)\s*\(/gi)].map((m) => m[1]!.toLowerCase());
    expect(bare.filter((c) => !['coalesce', 'least', 'greatest', 'exists', 'in', 'values', 'array', 'lateral', 'o'].includes(c) && !KEYWORDS.has(c) && !/^p_|^v_/.test(c))).toEqual([]);
  });
});

describe('Phase D dispatch pointer SQL — privilege shape (offline)', () => {
  const up = WORKER_DISPATCH_POINTER_UP_SQL.join(';\n');

  it('the interface contract: four claim functions, one release, fixed queue labels, server-fixed lease and cap', () => {
    expect(CLAIM_SIGNATURES).toEqual([
      'core.worker_claim_email_dispatch(integer)',
      'core.worker_claim_push_dispatch(integer)',
      'core.worker_claim_realtime_publish(integer)',
      'core.worker_claim_statement_dispatch(integer)',
    ]);
    expect(DISPATCH_QUEUES).toEqual(['email', 'push', 'realtime', 'statement']);
    expect(Object.values(DISPATCH_QUEUE_SETTINGS).map((s) => s.leaseSeconds)).toEqual([30, 30, 15, 60]);
    for (const q of DISPATCH_QUEUES) {
      expect(up).toContain(`RETURNS TABLE (subject_id uuid, organisation_id uuid, workspace_id uuid, claim_token uuid, claim_count integer)`);
      expect(up).toContain(`core.worker_dispatch_claim_impl('${q}', p_limit, ${DISPATCH_QUEUE_SETTINGS[q].leaseSeconds}, ${DISPATCH_QUEUE_SETTINGS[q].perOrg})`);
    }
    expect(up).toContain('core.worker_release_dispatch_claim(p_queue text, p_subject_id uuid, p_claim_token uuid, p_retry_after_seconds integer)');
    expect(up).toContain('LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200)');
    expect(up).toContain('LEAST(GREATEST(COALESCE(p_retry_after_seconds, 30), 1), 300)');
  });

  it('ENABLE + FORCE RLS and both policies are in the same migration as the table; no table grant to any login', () => {
    expect(up).toContain('ALTER TABLE core.worker_dispatch_pointer ENABLE ROW LEVEL SECURITY');
    expect(up).toContain('ALTER TABLE core.worker_dispatch_pointer FORCE ROW LEVEL SECURITY');
    expect(up).toMatch(/CREATE POLICY worker_dispatch_pointer_definer ON core\.worker_dispatch_pointer AS PERMISSIVE FOR ALL TO rab_secure_owner USING \(CURRENT_USER = 'rab_secure_owner'::name\) WITH CHECK/);
    expect(up).toContain('AS RESTRICTIVE FOR ALL TO crewflow, crewflow_app, crewflow_worker USING (false) WITH CHECK (false)');
    expect(up).not.toMatch(/GRANT [^;]* ON TABLE/i);
  });

  it('EXECUTE goes to crewflow_worker only (claims, release, invite cleanup); the statement trigger function to crewflow only', () => {
    const grants = [...WORKER_DISPATCH_POINTER_UP_SQL, ...OUTBOX_TRIGGERS_UP_SQL, ...STATEMENT_TRIGGER_FUNCTION_UP_SQL, ...INVITE_CLEANUP_UP_SQL]
      .filter((s) => /^GRANT /.test(s));
    for (const g of grants) {
      if (g.includes('worker_dispatch_pointer_statement_trg')) expect(g).toMatch(/ TO crewflow$/);
      else expect(g).toMatch(/ TO crewflow_worker$/);
    }
    expect(grants.some((g) => /crewflow_app/.test(g))).toBe(false);
    expect(grants.some((g) => /worker_dispatch_claim_impl/.test(g))).toBe(false);
    expect(OUTBOX_TRIGGERS_UP_SQL.filter((s) => /^GRANT /.test(s))).toEqual([]);
  });

  it('REVOKE FROM PUBLIC precedes the hand-over to rab_secure_owner for every function (no creator ACL survives)', () => {
    for (const list of [WORKER_DISPATCH_POINTER_UP_SQL, OUTBOX_TRIGGERS_UP_SQL, STATEMENT_TRIGGER_FUNCTION_UP_SQL, INVITE_CLEANUP_UP_SQL]) {
      const owners = list.filter((s) => /^ALTER FUNCTION .* OWNER TO rab_secure_owner$/.test(s));
      for (const o of owners) {
        const fn = /^ALTER FUNCTION (.*) OWNER TO/.exec(o)![1]!;
        const revoke = list.indexOf(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
        expect(revoke).toBeGreaterThanOrEqual(0);
        expect(revoke).toBeLessThan(list.indexOf(o));
      }
    }
  });

  it('the expected effective-privilege lines: nothing for crewflow / crewflow_app; crewflow_worker exactly the five callables', () => {
    const lines = expectedWorkerDispatchPrivilegeLines();
    expect(lines.filter((l) => l.endsWith('|true'))).toEqual(
      [...CLAIM_SIGNATURES, 'core.worker_release_dispatch_claim(text, uuid, uuid, integer)'].map((f) => `crewflow_worker|${f}|true`).sort(),
    );
  });

  it('the gated D5 migration moves exactly three EXECUTE grants and its down() is the exact reverse', () => {
    expect(DUE_WORK_TO_WORKER_UP_SQL).toHaveLength(6);
    expect(DUE_WORK_TO_WORKER_UP_SQL.filter((s) => s.startsWith('REVOKE')).every((s) => s.endsWith('FROM crewflow, crewflow_app'))).toBe(true);
    expect(DUE_WORK_TO_WORKER_UP_SQL.filter((s) => s.startsWith('GRANT')).every((s) => s.endsWith('TO crewflow_worker'))).toBe(true);
    expect(DUE_WORK_TO_WORKER_DOWN_SQL.filter((s) => s.startsWith('GRANT')).every((s) => s.endsWith('TO crewflow, crewflow_app'))).toBe(true);
  });

  it('the gated D5 migration is NOT loadable by TypeORM or the M2 harness (outside core/migrations)', () => {
    expect(existsSync(join(__dirname, 'gated-migrations', '1786721330000-WorkerDueWorkClaimsToWorkerRole.ts'))).toBe(true);
    expect(readdirSync(join(__dirname, 'migrations')).filter((f) => f.startsWith('1786721330000'))).toEqual([]);
  });

  it('the Phase D migration files pass the post-0b source rules (no role created, no membership granted)', () => {
    const files = readdirSync(join(__dirname, 'migrations')).filter((f) => /^17867213\d{5}-/.test(f));
    expect(files.sort()).toEqual([
      '1786721300000-WorkerDispatchPointer.ts',
      '1786721310000-WorkerDispatchPointerOutboxTriggers.ts',
      '1786721320000-StatementDispatchPointer.ts',
      '1786721340000-AccountInviteCleanupDefiner.ts',
    ]);
    const sources = [...files.map((f) => readFileSync(join(__dirname, 'migrations', f), 'utf8')), readFileSync(join(__dirname, 'worker-dispatch-pointer-sql.ts'), 'utf8')];
    for (const s of sources) expect(migrationSourceViolations(s)).toEqual([]);
    expect(migrationSourceViolations('`GRANT crewflow_app TO crewflow_worker WITH INHERIT TRUE, SET FALSE`')).toContainEqual(expect.stringContaining('role membership to crewflow_worker'));
    expect(migrationSourceViolations('`CREATE ROLE crewflow_worker LOGIN`')).toContainEqual(expect.stringContaining('creates, drops or alters a login role'));
    expect(migrationSourceViolations('`GRANT EXECUTE ON FUNCTION core.f() TO crewflow_worker`')).toEqual([]);
    expect(migrationSourceViolations('`ALTER ROLE crewflow_worker BYPASSRLS`')).toContainEqual(expect.stringContaining('BYPASSRLS'));
  });
});

describe('Phase D dispatch pointer SQL — triggers (offline)', () => {
  const triggerFns = { ...OUTBOX_TRIGGER_FUNCTION_SQL, statement: STATEMENT_TRIGGER_FUNCTION_SQL } as const;

  it('E-1: NOTIFY only on the reviewed channel, payload = the queue label, only when due now AND the session enabled it', () => {
    const all = Object.values(triggerFns);
    const notifies = all.flatMap((s) => [...s.matchAll(/pg_catalog\.pg_notify\('([^']+)', '([^']+)'\)/g)].map((m) => `${m[1]}:${m[2]}`));
    expect(notifies).toEqual([`${WAKE_CHANNEL}:email`, `${WAKE_CHANNEL}:push`, `${WAKE_CHANNEL}:realtime`, `${WAKE_CHANNEL}:statement`]);
    expect(NOTIFY_SETTING).toBe('crewflow.dispatch_notify');
    for (const s of all) {
      expect(s).toContain(
        `IF v_due <= pg_catalog.now() AND pg_catalog.current_setting('${NOTIFY_SETTING}', true) = 'on' THEN\n    PERFORM pg_catalog.pg_notify`,
      );
    }
  });

  it('E-2: every trigger function is bound to its own table (TG_TABLE_NAME) before anything else, and refuses a foreign place', () => {
    for (const [q, s] of Object.entries(triggerFns)) {
      const b = body(s);
      const binding = `TG_TABLE_NAME IS DISTINCT FROM '${TRIGGER_FUNCTION_TABLE[q as keyof typeof TRIGGER_FUNCTION_TABLE]}'`;
      expect(b.indexOf(binding)).toBeGreaterThan(0);
      expect(b.indexOf(binding)).toBeLessThan(b.indexOf('pg_typeof'));
      expect(b).toContain("TG_WHEN IS DISTINCT FROM 'AFTER'");
      expect(b).toContain("TG_LEVEL IS DISTINCT FROM 'ROW'");
      expect(b).toContain("IS DISTINCT FROM 'pg_catalog.uuid'::pg_catalog.regtype");
      expect(b).toContain('cannot change');
    }
    expect(STATEMENT_TRIGGER_FUNCTION_SQL).toContain("('workspace_' || pg_catalog.replace(v_ws::text, '-', ''))");
    expect(STATEMENT_TRIGGER_FUNCTION_SQL).toContain('FROM core.manager_workspace mw WHERE mw.id = NEW.workspace_id');
    expect(OUTBOX_TRIGGER_FUNCTION_SQL.realtime).toContain('FROM core.manager_workspace mw WHERE mw.id = NEW.workspace_id');
  });

  it('E-3: a conflicting pointer is re-pointed to the firing row\'s scope (never a refusal); the claim is cleared', () => {
    for (const s of Object.values(triggerFns)) {
      const b = body(s);
      expect(b).toContain('SET organisation_id = EXCLUDED.organisation_id,\n         workspace_id = EXCLUDED.workspace_id,');
      expect(b).toContain('claim_token = NULL,\n         claimed_at = NULL,');
      expect(b).toContain('repoint_count = w.repoint_count');
      expect(b).not.toContain('IF NOT FOUND');
    }
    expect(WORKER_DISPATCH_POINTER_UP_SQL[0]).toContain('repoint_count integer NOT NULL DEFAULT 0');
    // E-10: declarative workspace↔organisation pairing.
    expect(WORKER_DISPATCH_POINTER_UP_SQL[0]).toContain('FOREIGN KEY (workspace_id, organisation_id)\n    REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE');
  });

  it('E-4: TRUNCATE on any source table removes that queue\'s pointers (statement-level triggers, core and workspace)', () => {
    expect(OUTBOX_TRIGGER_NAMES.filter((n) => n.endsWith('_trunc'))).toHaveLength(3);
    for (const t of ['email_outbox', 'push_delivery', 'realtime_event']) {
      expect(OUTBOX_TRIGGERS_UP_SQL.join('\n')).toContain(`CREATE TRIGGER ${t}_dispatch_pointer_trunc AFTER TRUNCATE ON core.${t}\n  FOR EACH STATEMENT`);
      expect(OUTBOX_TRIGGERS_DOWN_SQL).toContain(`DROP TRIGGER ${t}_dispatch_pointer_trunc ON core.${t}`);
    }
    for (const s of Object.values(triggerFns)) expect(body(s)).toContain("IF TG_OP = 'TRUNCATE' THEN");
    expect(statementDispatchPointerSql('workspace_0123456789abcdef0123456789abcdef')).toContain(
      'CREATE TRIGGER payroll_record_statement_pointer_trunc AFTER TRUNCATE ON "workspace_0123456789abcdef0123456789abcdef".payroll_record\n  FOR EACH STATEMENT',
    );
    expect(STATEMENT_TRIGGER_FUNCTION_SQL).toContain('w.workspace_id = (pg_catalog.substr(TG_TABLE_SCHEMA, 11))::uuid');
    const attached = REVIEWED_SECURE_TRIGGER_ATTACHMENTS.flatMap((a) => a.triggers);
    for (const n of [...OUTBOX_TRIGGER_NAMES.map((x) => x.split('.')[1]!), ...STATEMENT_POINTER_TRIGGER_NAMES]) expect(attached).toContain(n);
  });

  it('E-7: leases and release timestamps come from clock_timestamp(), not the transaction start', () => {
    expect(CLAIM_IMPL_SQL).toContain('v_now     timestamptz := pg_catalog.clock_timestamp();');
    expect(CLAIM_IMPL_SQL).toContain('v_lease := pg_catalog.clock_timestamp();');
    expect(CLAIM_IMPL_SQL).toContain('SET due_at = v_lease + pg_catalog.make_interval(secs => p_lease_seconds)');
    expect(RELEASE_SQL).toContain('SET due_at = pg_catalog.clock_timestamp() + ');
    expect(body(RELEASE_SQL)).not.toContain('pg_catalog.now()');
  });

  it('E-8: every transaction that creates or drops a live-table trigger starts by bounding its lock wait', () => {
    expect(LOCK_TIMEOUT_SQL).toBe("SET LOCAL lock_timeout = '5s'");
    expect(OUTBOX_TRIGGERS_UP_SQL[0]).toBe(LOCK_TIMEOUT_SQL);
    expect(OUTBOX_TRIGGERS_DOWN_SQL[0]).toBe(LOCK_TIMEOUT_SQL);
    const m1320 = readFileSync(join(__dirname, 'migrations', '1786721320000-StatementDispatchPointer.ts'), 'utf8');
    expect(m1320.indexOf('await queryRunner.query(LOCK_TIMEOUT_SQL)')).toBeLessThan(m1320.indexOf("statementDispatchPointerSql('core')"));
    expect(m1320).toContain('lockTimeoutMs: Number.parseInt(DISPATCH_TRIGGER_LOCK_TIMEOUT, 10) * 1000');
  });

  it('E-9: 1786721300000.down() checks for live pointer writers before dropping the table', () => {
    expect(POINTER_WRITERS_PRESENT_SQL).toContain("'worker_dispatch_pointer_email_trg', 'worker_dispatch_pointer_push_trg', 'worker_dispatch_pointer_realtime_trg'");
    const m1300 = readFileSync(join(__dirname, 'migrations', '1786721300000-WorkerDispatchPointer.ts'), 'utf8');
    expect(m1300.indexOf('POINTER_WRITERS_PRESENT_SQL)')).toBeLessThan(m1300.indexOf('for (const sql of WORKER_DISPATCH_POINTER_DOWN_SQL)'));
  });

  it('E-6 / N-4: excluded users are REPORTED with a skip reason; the delete itself is still guarded by the never-activated predicate', () => {
    for (const s of [INVITE_CANDIDATES_SQL, INVITE_DELETE_SQL]) {
      expect(s).toContain("WHEN u.last_login_at IS NOT NULL THEN 'signed_in'");
      expect(s).toContain("WHEN EXISTS (SELECT 1 FROM core.refresh_token rt WHERE rt.user_id = u.id)\n             OR EXISTS (SELECT 1 FROM core.user_session us WHERE us.user_id = u.id) THEN 'had_session'");
    }
    expect(INVITE_CANDIDATES_SQL).toContain('RETURNS TABLE (user_id uuid, organisation_id uuid, cleanup_at timestamptz, blocking_reason text)');
    expect(INVITE_CANDIDATES_SQL).not.toContain('AND u.last_login_at IS NULL');
    // The DELETE statement repeats the structural guard (belt and braces after the reason check).
    expect(INVITE_DELETE_SQL).toContain("DELETE FROM core.\"user\" u WHERE u.id = v_uid AND u.status = 'invite_expired'\n       AND u.last_login_at IS NULL");
    expect(INVITE_DELETE_SQL).toContain('IF v_reason IS NOT NULL THEN\n    RETURN v_reason;');
    expect(INVITE_CLEANUP_SKIP_REASONS).toEqual(['manager_workspace', 'platform_admin', 'signed_in', 'had_session']);
  });

  it('N-2: the statement function refuses a firing table whose schema is not owned by rab_secure_owner (crewflow-created schemas)', () => {
    const b = body(STATEMENT_TRIGGER_FUNCTION_SQL);
    expect(b).toContain(
      "IF (SELECT n.nspowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = TG_RELID)\n       IS DISTINCT FROM 'rab_secure_owner'::pg_catalog.regrole::pg_catalog.oid THEN",
    );
    expect(b.indexOf('TG_RELID')).toBeLessThan(b.indexOf("IF TG_OP = 'TRUNCATE'"));
  });

  it('R3 parity: the due-time constants equal the Worker dispatchers (read as text: rab-server never imports rab-worker)', () => {
    const worker = join(__dirname, '..', '..', '..', '..', '..', 'rab-worker', 'src', 'queues');
    const constant = (file: string, name: string) => {
      const m = new RegExp(`const ${name}\\s*=\\s*(\\d+)`).exec(readFileSync(join(worker, file), 'utf8'));
      if (!m) throw new Error(`${name} not found in ${file}`);
      return Number(m[1]);
    };
    expect(constant('rab-email/email-dispatch.job.ts', 'PROCESSING_LEASE_MINUTES')).toBe(DUE_CONSTANTS.emailProcessingLeaseMinutes);
    expect(constant('rab-email/email-dispatch.job.ts', 'RETRY_STALE_MINUTES')).toBe(DUE_CONSTANTS.emailRetryStaleMinutes);
    expect(readFileSync(join(worker, 'rab-email/email-dispatch.job.ts'), 'utf8')).toContain(
      `status = 'QUEUED' AND queued_at < now() - interval '${DUE_CONSTANTS.emailQueuedStaleMinutes} minutes'`,
    );
    expect(constant('rab-push/push-dispatch.job.ts', 'PENDING_STALE_MINUTES')).toBe(DUE_CONSTANTS.pushPendingStaleMinutes);
    expect(OUTBOX_TRIGGER_FUNCTION_SQL.push).toContain(
      `WHEN 'PENDING' THEN COALESCE(NEW.queued_at + pg_catalog.make_interval(mins => ${DUE_CONSTANTS.pushPendingStaleMinutes}), pg_catalog.now())`,
    );
    expect(OUTBOX_TRIGGER_FUNCTION_SQL.push).toContain("pg_catalog.pg_typeof(NEW.queued_at) IS DISTINCT FROM 'pg_catalog.timestamptz'");
    expect(OUTBOX_TRIGGERS_UP_SQL.find((s) => s.startsWith('CREATE TRIGGER push_delivery_dispatch_pointer_upd'))).toContain(
      'OLD.queued_at IS DISTINCT FROM NEW.queued_at',
    );
    expect(constant('rab-push/push-dispatch.job.ts', 'PROCESSING_LEASE_MINUTES')).toBe(DUE_CONSTANTS.pushProcessingLeaseMinutes);
    expect(constant('rab-push/push-dispatch.job.ts', 'RETRY_STALE_MINUTES')).toBe(DUE_CONSTANTS.pushRetryStaleMinutes);
    expect(constant('rab-reports/shift-statement.job.ts', 'SHIFT_STATEMENT_LEASE_MINUTES')).toBe(DUE_CONSTANTS.statementLeaseMinutes);
    expect(constant('rab-reports/shift-statement.job.ts', 'SHIFT_STATEMENT_RETRY_BACKOFF_MINUTES')).toBe(DUE_CONSTANTS.statementRetryBackoffMinutes);
    expect(SHIFT_STATEMENT_MAX_ATTEMPTS).toBe(DUE_CONSTANTS.statementMaxAttempts);
  });
});

describe('crewflow_worker shape (the migrations refuse anything else)', () => {
  const good: WorkerRoleFacts = {
    present: true,
    attributes: JSON.stringify({ login: true, inherit: true, super: false, bypassrls: false, createrole: false, createdb: false, replication: false }),
    member_of: 'crewflow_app:admin=false:inherit=true:set=false',
    members: 0,
    owns: 0,
    reaches_owner_role: false,
  };
  it('accepts the reviewed shape', () => expect(workerRoleProblems(good)).toEqual([]));
  it('refuses a missing role (operator step first; a migration never creates it)', () =>
    expect(workerRoleProblems({ ...good, present: false })[0]).toMatch(/does not exist/));
  it.each([
    [{ attributes: JSON.stringify({ ...JSON.parse(good.attributes!), bypassrls: true }) }, /bypassrls must be false/],
    [{ attributes: JSON.stringify({ ...JSON.parse(good.attributes!), super: true }) }, /super must be false/],
    [{ member_of: 'crewflow_app:admin=false:inherit=true:set=true' }, /exactly crewflow_app/],
    [{ member_of: 'crewflow:admin=false:inherit=true:set=false,crewflow_app:admin=false:inherit=true:set=false' }, /exactly crewflow_app/],
    [{ members: 1 }, /no role may be a member of crewflow_worker/],
    [{ owns: 2 }, /must own nothing/],
    [{ reaches_owner_role: true }, /must not be able to use or SET ROLE/],
  ])('refuses %j', (patch, reason) => expect(workerRoleProblems({ ...good, ...patch }).join('; ')).toMatch(reason));
});

describe('N-1: the Phase D R4 exemption is per (function, own table) pair, never per table', () => {
  const reviewed = (extra: { r4?: string[]; missing?: Array<{ fn: string; tbl: string }> } = {}) =>
    secureOwnerInvariantViolations(async (sql: string) => {
      if (sql === R4_TABLES_SQL) return [...R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS, ...(extra.r4 ?? [])].map((relname) => ({ relname }));
      if (sql === DYNAMIC_SQL_SECURE_DEFINERS_SQL) return REVIEWED_DYNAMIC_SQL_SECURE_DEFINERS.map((fn) => ({ fn }));
      if (sql === R4_PHASE_D_MISSING_PAIRS_SQL) return extra.missing ?? [];
      return [];
    });

  it('the catalog query ignores ONLY the binding literal, and only for exactly the four pairs (function AND table)', () => {
    expect(R4_PHASE_D_TRIGGER_PAIRS).toEqual([
      { fn: 'worker_dispatch_pointer_email_trg', table: 'email_outbox' },
      { fn: 'worker_dispatch_pointer_push_trg', table: 'push_delivery' },
      { fn: 'worker_dispatch_pointer_realtime_trg', table: 'realtime_event' },
      { fn: 'worker_dispatch_pointer_statement_trg', table: 'payroll_record' },
    ]);
    expect(R4_TABLES_SQL).toContain(
      "AND CASE WHEN p.pronamespace = 'core'::regnamespace AND p.pronargs = 0 AND (p.proname::text, c.relname::text) IN (VALUES ('worker_dispatch_pointer_email_trg', 'email_outbox'), ('worker_dispatch_pointer_push_trg', 'push_delivery'), ('worker_dispatch_pointer_realtime_trg', 'realtime_event'), ('worker_dispatch_pointer_statement_trg', 'payroll_record'))\n" +
        "            THEN pg_catalog.replace(p.prosrc, 'TG_TABLE_NAME IS DISTINCT FROM ''' || c.relname || '''', '')\n" +
        '            ELSE p.prosrc\n' +
        "       END ~* ('\\m(core\\.)?\"?' || c.relname || '\"?\\M')",
    );
    // Wave 2: no definer-only filter (invoker helpers run as rab_secure_owner inside a definer) and no table-wide exclusion.
    expect(R4_TABLES_SQL).not.toContain('p.prosecdef');
    expect(R4_TABLES_SQL).not.toMatch(/relname\s+NOT IN|AND NOT \(/);
  });

  it('a hypothetical OTHER rab_secure_owner definer naming core.payroll_record is still reported as r4-table-added', async () => {
    // What R4_TABLES_SQL returns when any non-pair definer names payroll_record (the pair exclusion does not apply to it).
    expect(await reviewed({ r4: ['payroll_record'] })).toContain('r4-table-added|payroll_record|not in the reviewed list');
  });

  it('a pair whose live function lost its own-table binding fails (required once the function exists)', async () => {
    expect(await reviewed()).toEqual([]);
    expect(await reviewed({ missing: [{ fn: 'worker_dispatch_pointer_statement_trg', tbl: 'payroll_record' }] })).toContain(
      'r4-phase-d-pair-missing|core.worker_dispatch_pointer_statement_trg()|its live body no longer binds itself to payroll_record (TG_TABLE_NAME)',
    );
  });

  it('the required-pair query only considers live bodies (an inert body after 1786721320000.down() is not "missing")', () => {
    expect(R4_PHASE_D_MISSING_PAIRS_SQL).toContain("pg_catalog.strpos(p.prosrc, 'worker_dispatch_pointer') > 0");
    expect(R4_PHASE_D_MISSING_PAIRS_SQL).toContain("pg_catalog.strpos(p.prosrc, 'TG_TABLE_NAME IS DISTINCT FROM ''' || v.tbl || '''') = 0");
  });
});
