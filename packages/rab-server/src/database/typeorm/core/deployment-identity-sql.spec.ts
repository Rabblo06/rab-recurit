import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { QueryRunner } from 'typeorm';

import {
  BIND_FUNCTION_SIGNATURE,
  BOUND_HOST_PATTERN,
  BOUND_HOSTS_LIST_PATTERN,
  CHECK_FUNCTION_SIGNATURE,
  DEPLOYMENT_IDENTITY_DOWN_SQL,
  DEPLOYMENT_IDENTITY_EXPECTED_STATE,
  DEPLOYMENT_IDENTITY_GONE_SQL,
  DEPLOYMENT_IDENTITY_PREFLIGHT_SQL,
  DEPLOYMENT_IDENTITY_STATE_SQL,
  DEPLOYMENT_IDENTITY_UP_SQL,
} from './deployment-identity-sql';
import {
  migrationSourceViolations,
  PHASE_0B_MIGRATION_TIMESTAMP,
  PRE_PHASE_0B_MIGRATIONS,
  prePhase0bMigrationFingerprint,
} from './migration-source-rules';
import { DeploymentIdentity1786721230000 } from './migrations/1786721230000-DeploymentIdentity';
import { isApprovedForProduction, PRODUCTION_APPROVED_MIGRATIONS, PRODUCTION_APPROVED_THROUGH } from './production-migration-approval';
import {
  DYNAMIC_SQL_SECURE_DEFINERS_SQL,
  R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS,
  R4_TABLES_SQL,
  REVIEWED_DYNAMIC_SQL_SECURE_DEFINERS,
  SECURE_OWNER_INVARIANT_VIOLATIONS_SQL,
} from './secure-owner-invariants';
import { DEPLOYMENT_ENVIRONMENTS } from '../../deployment-identity/deployment-identity';

/**
 * Every crewflow-owned `core` table on a migrations-only database (242 migrations, read 2026-10-29). secure-owner-invariants
 * R4_TABLES_SQL adds any of these named as a WORD in a rab_secure_owner definer body to the frozen R4 list, which fails CI.
 */
const CREWFLOW_CORE_TABLES = (
  'admin_inspect_session ai_action_proposal ai_agent ai_agent_event ai_agent_trigger ai_conversation ai_input_request ai_message ' +
  'ai_skill ai_usage ai_usage_daily attendance attendance_correction audit_log email_outbox host_label_claim hws_backfill_checkpoint ' +
  'job_offer job_role manager_profile manager_venue migrations navigation_layout notification notification_preference ' +
  'oauth_transaction_state organisation_ai_assistant organisation_ai_instruction organisation_ai_model_policy ' +
  'organisation_ai_model_preference organisation_ai_setting organisation_member payroll_calendar payroll_calendar_period ' +
  'payroll_record payroll_run payroll_run_line payslip payslip_document permission platform_config push_delivery push_device ' +
  'realtime_event replacement_request reserved_host_label role role_field_permission role_object_permission role_permission shift ' +
  'shift_assignment shift_report shift_request_staff shift_staff_review staff_profile stored_file user_note user_permission_override ' +
  'user_preference user_role venue venue_manager_staff venue_role_rate worker_event workspace_membership workspace_schema_migration ' +
  'workspace_schema_registry'
).split(' ');

const CREATE_FUNCTIONS = DEPLOYMENT_IDENTITY_UP_SQL.filter((s) => s.startsWith('CREATE FUNCTION'));
const bodyOf = (sql: string) => /\$fn\$([\s\S]*)\$fn\$/.exec(sql)?.[1] ?? '';

const MIGRATION_FILE = '1786721230000-DeploymentIdentity.ts';

describe('DeploymentIdentity1786721230000: SQL shape, without a database', () => {
  it('renumbered 1786721200000 -> 1786721230000: in core/migrations, ordered after ProvisioningHealth, no draft copy left', () => {
    const files = readdirSync(join(__dirname, 'migrations')).filter((f) => /^\d{13}-.+\.ts$/.test(f)).sort();
    expect(files).toContain(MIGRATION_FILE);
    expect(files.some((f) => f.startsWith('1786721200000'))).toBe(false);
    expect(existsSync(join(__dirname, 'migrations-draft'))).toBe(false);
    expect(files[files.indexOf(MIGRATION_FILE) - 1]).toBe('1786721220000-ProvisioningHealth.ts');
    expect(new DeploymentIdentity1786721230000().name).toBe('DeploymentIdentity1786721230000');
  });

  it('is after Phase 0b, so the frozen pre-0b chain fingerprint is unchanged and every post-0b rule applies to it', () => {
    expect(1786721230000).toBeGreaterThan(PHASE_0B_MIGRATION_TIMESTAMP);
    const names = readdirSync(join(__dirname, 'migrations')).filter((f) => /^\d{13}-.+\.ts$/.test(f)).map((f) => f.replace(/\.ts$/, ''));
    expect(prePhase0bMigrationFingerprint(names)).toEqual(PRE_PHASE_0B_MIGRATIONS);
  });

  it('is NOT approved for production: later than PRODUCTION_APPROVED_THROUGH and not named in the approved set', () => {
    expect(1786721230000).toBeGreaterThan(PRODUCTION_APPROVED_THROUGH);
    expect(PRODUCTION_APPROVED_MIGRATIONS.has('DeploymentIdentity1786721230000')).toBe(false);
    expect(isApprovedForProduction('DeploymentIdentity1786721230000')).toBe(false);
  });

  it('passes the post-0b migration source rules (migration file and its SQL module)', () => {
    for (const file of [join(__dirname, 'migrations', MIGRATION_FILE), join(__dirname, 'deployment-identity-sql.ts')]) {
      expect(migrationSourceViolations(readFileSync(file, 'utf8'))).toEqual([]);
    }
  });

  it('creates no role, grants no membership, never removes FORCE, grants runtime logins only EXECUTE on the read function', () => {
    const all = DEPLOYMENT_IDENTITY_UP_SQL.join('\n');
    expect(all).not.toMatch(/CREATE\s+ROLE|ALTER\s+ROLE|NO\s+FORCE|DISABLE\s+ROW|BYPASSRLS|SECURITY\s+INVOKER/i);
    expect(all).not.toMatch(/GRANT\s+(?!SELECT|EXECUTE)\w+\s+TO/i); // no role-membership grant
    const grants = DEPLOYMENT_IDENTITY_UP_SQL.filter((s) => /^GRANT/.test(s));
    expect(grants).toEqual([
      'GRANT SELECT, INSERT, UPDATE ON TABLE core.deployment_identity TO rab_secure_owner',
      'GRANT SELECT, INSERT ON TABLE core.deployment_identity_history TO rab_secure_owner',
      `GRANT EXECUTE ON FUNCTION ${CHECK_FUNCTION_SIGNATURE} TO crewflow_app, crewflow`,
    ]);
    expect(all).not.toMatch(new RegExp(`GRANT[^;]*${BIND_FUNCTION_SIGNATURE.replace(/[()]/g, '\\$&')}`));
  });

  it('both tables: owner rab_secure_owner, ENABLE + FORCE RLS, PUBLIC/runtime revoked, history insert-only', () => {
    for (const t of ['core.deployment_identity', 'core.deployment_identity_history']) {
      expect(DEPLOYMENT_IDENTITY_UP_SQL).toContain(`ALTER TABLE ${t} OWNER TO rab_secure_owner`);
      expect(DEPLOYMENT_IDENTITY_UP_SQL).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      expect(DEPLOYMENT_IDENTITY_UP_SQL).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    }
    expect(DEPLOYMENT_IDENTITY_UP_SQL).toContain('REVOKE ALL ON TABLE core.deployment_identity, core.deployment_identity_history FROM PUBLIC, crewflow, crewflow_app');
    expect(DEPLOYMENT_IDENTITY_EXPECTED_STATE.table_acl).not.toMatch(/deployment_identity_history:[^,]*:(UPDATE|DELETE|TRUNCATE)/);
    expect(DEPLOYMENT_IDENTITY_EXPECTED_STATE.table_acl).not.toMatch(/crewflow|PUBLIC/);
  });

  it('the environment allow-list in SQL is exactly the one the runtime enforces', () => {
    const list = DEPLOYMENT_ENVIRONMENTS.map((e) => `'${e}'`).join(', ');
    expect(DEPLOYMENT_IDENTITY_UP_SQL[0]).toContain(`environment IN (${list})`);
    expect(DEPLOYMENT_IDENTITY_UP_SQL[1]).toContain(`environment IN (${list})`);
    expect(bodyOf(CREATE_FUNCTIONS[1])).toContain(`NOT IN (${list})`);
  });

  it('definers: SECURITY DEFINER, search_path pg_catalog, pg_temp, no dynamic SQL, no crewflow-owned table named (R4)', () => {
    expect(CREATE_FUNCTIONS).toHaveLength(2);
    for (const fn of CREATE_FUNCTIONS) {
      expect(fn).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp\s+AS \$fn\$/);
      const body = bodyOf(fn);
      expect(body).not.toMatch(/\bEXECUTE\b/i);
      const words = new Set(body.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
      expect(CREWFLOW_CORE_TABLES.filter((t) => words.has(t))).toEqual([]);
      // Only the two marker tables are read or written.
      expect([...body.matchAll(/core\.([a-z_]+)/g)].map((m) => m[1]).every((t) => t === 'deployment_identity' || t === 'deployment_identity_history')).toBe(true);
    }
  });

  it('the bind definer re-checks the SESSION login, refuses the runtime logins, and compare-and-swaps the current id', () => {
    const body = bodyOf(CREATE_FUNCTIONS[1]);
    expect(body).toContain("v_login IN ('crewflow', 'crewflow_app') OR NOT pg_catalog.pg_has_role(session_user, 'rab_secure_owner', 'MEMBER')");
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain('p_expected_current_deployment_id <> v_prev_deployment_id');
    expect(body).toContain('p_deployment_id = v_prev_deployment_id');
    expect(body).toMatch(/INSERT INTO core\.deployment_identity_history/);
  });

  it('RLS reasoning made concrete: owner-only permissive policies that need CURRENT_USER = rab_secure_owner, RESTRICTIVE deny for the runtime logins', () => {
    const policies = DEPLOYMENT_IDENTITY_UP_SQL.filter((sql) => sql.startsWith('CREATE POLICY'));
    expect(policies).toHaveLength(7);
    for (const p of policies.filter((sql) => /AS PERMISSIVE/.test(sql))) {
      expect(p).toMatch(/TO rab_secure_owner (USING|WITH CHECK) \(CURRENT_USER = 'rab_secure_owner'::name\)/);
    }
    const restrictive = policies.filter((sql) => /AS RESTRICTIVE/.test(sql));
    expect(restrictive).toEqual([
      'CREATE POLICY deployment_identity_runtime_deny ON core.deployment_identity AS RESTRICTIVE FOR ALL TO crewflow, crewflow_app USING (false) WITH CHECK (false)',
      'CREATE POLICY deployment_identity_history_runtime_deny ON core.deployment_identity_history AS RESTRICTIVE FOR ALL TO crewflow, crewflow_app USING (false) WITH CHECK (false)',
    ]);
    // No DELETE policy anywhere, and no UPDATE policy on the history: even a definer bug cannot rewrite or remove history.
    expect(policies.some((sql) => /FOR DELETE/.test(sql))).toBe(false);
    expect(policies.some((sql) => /deployment_identity_history .*FOR UPDATE/.test(sql))).toBe(false);
  });

  it('history is insert-only even for the owner: everything revoked from the owner first, then only SELECT + INSERT given back', () => {
    const revokeOwner = DEPLOYMENT_IDENTITY_UP_SQL.indexOf('REVOKE ALL ON TABLE core.deployment_identity, core.deployment_identity_history FROM rab_secure_owner');
    const grantHistory = DEPLOYMENT_IDENTITY_UP_SQL.indexOf('GRANT SELECT, INSERT ON TABLE core.deployment_identity_history TO rab_secure_owner');
    expect(revokeOwner).toBeGreaterThan(0);
    expect(grantHistory).toBeGreaterThan(revokeOwner);
    expect(DEPLOYMENT_IDENTITY_EXPECTED_STATE.table_acl.split(',').filter((l) => l.startsWith('deployment_identity_history:'))).toEqual([
      'deployment_identity_history:rab_secure_owner:INSERT:false',
      'deployment_identity_history:rab_secure_owner:SELECT:false',
    ]);
    // The singleton itself: no DELETE / TRUNCATE for anyone (a rebind is an UPDATE through the definer).
    expect(DEPLOYMENT_IDENTITY_EXPECTED_STATE.table_acl).not.toMatch(/deployment_identity:[^,]*:(DELETE|TRUNCATE)/);
  });

  it('host-binding review: the location is the database (from current_database()) plus a SET of 1 to 5 confirmed hosts', () => {
    const [singleton, history] = DEPLOYMENT_IDENTITY_UP_SQL;
    for (const table of [singleton, history]) {
      expect(table).toMatch(/\n  bound_database text NOT NULL,\n/);
      expect(table).toMatch(/\n  bound_hosts text\[\] NOT NULL,\n/);
      expect(table).toMatch(/\n  bound_system_identifier bigint,\n/);
      expect(table).not.toMatch(/\bbound_host\b/);
    }
    const shape = (c: string) =>
      `pg_catalog.array_ndims(${c}) = 1 AND pg_catalog.cardinality(${c}) BETWEEN 1 AND 5\n    AND pg_catalog.strpos(pg_catalog.array_to_string(${c}, '', '*'), ',') = 0\n    AND pg_catalog.array_to_string(${c}, ',', '*') ~ '${BOUND_HOSTS_LIST_PATTERN}'\n    AND NOT (pg_catalog.array_to_string(${c}, ',', '*') ~ '[^,]{254}')`;
    expect(singleton).toContain(`CONSTRAINT deployment_identity_bound_hosts_shape CHECK (\n    ${shape('bound_hosts')}\n  ),`);
    expect(history).toContain('previous_bound_database text,');
    expect(history).toContain('previous_bound_hosts text[],');
    expect(history).toContain('(previous_environment IS NULL) = (previous_bound_hosts IS NULL)');
    const bind = CREATE_FUNCTIONS[1];
    expect(bind).toContain('p_bound_hosts text[]\n)');
    // The database is never a parameter: the function records where it is running.
    expect(bind).not.toMatch(/p_bound_database|p_database/);
    expect(bodyOf(bind)).toContain('v_database := pg_catalog.current_database();');
    expect(bodyOf(bind)).toContain(`IF p_bound_hosts IS NULL OR (${shape('p_bound_hosts')}) IS NOT TRUE THEN`);
    // Distinct (duplicates refused, not silently merged) and stored in byte order.
    expect(bodyOf(bind)).toContain('pg_catalog.array_agg(u.h ORDER BY u.h COLLATE pg_catalog."C"), pg_catalog.count(DISTINCT u.h)::integer');
    expect(bodyOf(bind)).toContain('IF v_distinct <> pg_catalog.cardinality(p_bound_hosts) OR v_lengths_ok IS NOT TRUE THEN');
    expect(bodyOf(bind)).toMatch(/SET environment = p_environment, deployment_id = p_deployment_id, bound_database = v_database,\s+bound_hosts = v_hosts, bound_system_identifier = v_sid/);
    expect(bodyOf(bind)).toMatch(/v_prev_database, v_prev_hosts, p_environment,\s+p_deployment_id, v_database, v_hosts, v_sid, v_login/);
    // check() hands the location to the runtime.
    const check = CREATE_FUNCTIONS[0];
    expect(check).toMatch(
      /RETURNS TABLE \(\n  environment text,\n  deployment_id uuid,\n  bound_database text,\n  bound_hosts text\[\],\n  bound_system_identifier bigint,\n  current_system_identifier bigint\n\)/,
    );
    expect(bodyOf(check)).toContain('SELECT d.environment, d.deployment_id, d.bound_database, d.bound_hosts, d.bound_system_identifier, v_current_sid');
  });

  it('the comments never call the history tamper-proof, and state the migration-identity boundary', () => {
    const sqlModule = readFileSync(join(__dirname, 'deployment-identity-sql.ts'), 'utf8');
    const migration = readFileSync(join(__dirname, 'migrations', MIGRATION_FILE), 'utf8');
    for (const text of [sqlModule, migration]) {
      expect(text).not.toMatch(/(?<!NOT |not )tamper-proof/i);
      expect(text).toMatch(/SET ROLE rab_secure_owner/);
    }
  });

  it('system_identifier: read only when callable (exception-guarded, no privilege probe text), never part of any constraint', () => {
    for (const fn of CREATE_FUNCTIONS) {
      expect(bodyOf(fn)).toMatch(/FROM pg_catalog\.pg_control_system\(\) s;\n  EXCEPTION WHEN insufficient_privilege OR undefined_function THEN/);
    }
    expect(DEPLOYMENT_IDENTITY_UP_SQL.slice(0, 2).join('\n')).not.toMatch(/system_identifier[^,\n]*(NOT NULL|CHECK)/);
  });

  it('the bound-host pattern accepts what the factory canonical parse produces and nothing else', () => {
    const re = new RegExp(BOUND_HOST_PATTERN);
    for (const ok of ['127.0.0.1', 'localhost', 'postgres', 'db-primary.example.internal', 'ep-round-rain-aess0njf.c-2.eu-central-1.aws.neon.tech', '::1', 'fd00::5']) {
      expect(re.test(ok)).toBe(true);
    }
    for (const bad of ['', 'DB.Example', ' db', 'db ', '[::1]', 'db_host', 'db.example.', '-db', 'db/x', "db'x", 'a,b']) {
      expect(re.test(bad)).toBe(false);
    }
  });

  it('the host-list pattern (comma-joined, NULL rendered as *) accepts 1 to 5 hosts and nothing else', () => {
    const re = new RegExp(BOUND_HOSTS_LIST_PATTERN);
    expect(re.test('db.example.internal')).toBe(true);
    expect(re.test('db.example.internal,proxy.example.internal')).toBe(true);
    expect(re.test('a,b,c,d,e')).toBe(true);
    for (const bad of ['', 'a,b,c,d,e,f', 'a,', ',a', 'a,,b', 'a,*', '*', 'A,b', 'a, b']) {
      expect(re.test(bad)).toBe(false);
    }
  });

  it('the bind command calls the 6-argument definer with the CONFIRMED host set and re-verifies the recorded location', () => {
    const src = readFileSync(join(__dirname, '../../deployment-identity/bind-deployment-identity.ts'), 'utf8');
    expect(src).toContain('SELECT core.deployment_identity_bind($1, $2::uuid, $3, $4, $5::uuid, $6::text[])');
    expect(src).toMatch(/args\.confirmCurrentDeploymentId,\n\s+args\.confirmHosts,\n\s+\]\);/);
    expect(src).toContain('after.marker.boundDatabase !== before.database');
    expect(src).toContain('JSON.stringify(after.marker.boundHosts ?? []) !== JSON.stringify(args.confirmHosts)');
  });

  it('down() drops exactly what up() creates', () => {
    expect(DEPLOYMENT_IDENTITY_DOWN_SQL).toEqual([
      `DROP FUNCTION ${BIND_FUNCTION_SIGNATURE}`,
      `DROP FUNCTION ${CHECK_FUNCTION_SIGNATURE}`,
      'DROP TABLE core.deployment_identity_history',
      'DROP TABLE core.deployment_identity',
    ]);
  });
});

describe('DeploymentIdentity1786721230000: migration control flow, fake query runner', () => {
  const okPreflight = { who: 'rab_ci_migrator', su: false, can_act: true, secure_bad: false, core_owner: 'rab_secure_owner', exists_already: false };

  function runner(opts: { preflight?: Partial<typeof okPreflight>; state?: Record<string, unknown>; violations?: string[]; gone?: boolean } = {}) {
    const executed: string[] = [];
    const query = jest.fn(async (sql: string) => {
      executed.push(sql);
      if (sql === DEPLOYMENT_IDENTITY_PREFLIGHT_SQL) return [{ ...okPreflight, ...opts.preflight }];
      if (sql === DEPLOYMENT_IDENTITY_STATE_SQL) return [opts.state ?? { ...DEPLOYMENT_IDENTITY_EXPECTED_STATE }];
      if (sql === SECURE_OWNER_INVARIANT_VIOLATIONS_SQL) return (opts.violations ?? []).map((line) => ({ line }));
      if (sql === R4_TABLES_SQL) return R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS.map((relname) => ({ relname }));
      if (sql === DYNAMIC_SQL_SECURE_DEFINERS_SQL) return REVIEWED_DYNAMIC_SQL_SECURE_DEFINERS.map((fn) => ({ fn }));
      if (sql === DEPLOYMENT_IDENTITY_GONE_SQL) return [{ gone: opts.gone ?? true }];
      return [];
    });
    return { qr: { query } as unknown as QueryRunner, executed };
  }

  it('up(): pins search_path, preflights, runs every statement in order, then verifies state and invariants', async () => {
    const { qr, executed } = runner();
    await new DeploymentIdentity1786721230000().up(qr);
    expect(executed[0]).toContain(`set_config('search_path', 'pg_catalog, pg_temp', true)`);
    expect(executed[1]).toBe(DEPLOYMENT_IDENTITY_PREFLIGHT_SQL);
    expect(executed.slice(2, 2 + DEPLOYMENT_IDENTITY_UP_SQL.length)).toEqual([...DEPLOYMENT_IDENTITY_UP_SQL]);
    expect(executed[2 + DEPLOYMENT_IDENTITY_UP_SQL.length]).toBe(DEPLOYMENT_IDENTITY_STATE_SQL);
    expect(executed).toContain(SECURE_OWNER_INVARIANT_VIOLATIONS_SQL);
  });

  it('up(): refuses a non-bootstrap identity, a pre-0b database, or an existing marker, before any DDL', async () => {
    for (const [preflight, pattern] of [
      [{ can_act: false }, /cannot act as rab_secure_owner/],
      [{ core_owner: 'crewflow' }, /Phase 0b first/],
      [{ secure_bad: true }, /NOLOGIN, NOSUPERUSER, NOBYPASSRLS/],
      [{ exists_already: true }, /already exists/],
    ] as const) {
      const { qr, executed } = runner({ preflight });
      await expect(new DeploymentIdentity1786721230000().up(qr)).rejects.toThrow(pattern);
      expect(executed).toHaveLength(2);
    }
  });

  it('up(): any difference from the exact expected state, or an invariant violation, raises (the transaction rolls back)', async () => {
    const drifted = runner({ state: { ...DEPLOYMENT_IDENTITY_EXPECTED_STATE, function_acl: `${DEPLOYMENT_IDENTITY_EXPECTED_STATE.function_acl},deployment_identity_bind:crewflow_app:EXECUTE:false` } });
    await expect(new DeploymentIdentity1786721230000().up(drifted.qr)).rejects.toThrow(/function_acl: expected/);
    const violated = runner({ violations: ['definer-search-path|core.deployment_identity_check()|<unset>'] });
    await expect(new DeploymentIdentity1786721230000().up(violated.qr)).rejects.toThrow(/secure-owner invariants violated/);
  });

  it('down(): drops everything and verifies nothing remains', async () => {
    const { qr, executed } = runner();
    await new DeploymentIdentity1786721230000().down(qr);
    expect(executed.slice(2, 2 + DEPLOYMENT_IDENTITY_DOWN_SQL.length)).toEqual([...DEPLOYMENT_IDENTITY_DOWN_SQL]);
    const left = runner({ gone: false });
    await expect(new DeploymentIdentity1786721230000().down(left.qr)).rejects.toThrow(/remain after down/);
  });
});
