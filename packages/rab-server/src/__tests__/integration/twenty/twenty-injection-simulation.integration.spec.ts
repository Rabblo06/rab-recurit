/**
 * T7 R5 — injection simulation as the Option A login `crewflow_owner` on a REAL chain database. Every statement runs inside
 * BEGIN … ROLLBACK (and session state is reset), and the suite re-reads the catalogue afterwards to prove nothing persisted.
 *
 *   CAN   (EXPECTED-RISK, G-02/G-04/G-09): SET ROLE, NO FORCE / DISABLE RLS, ALTER POLICY USING (true), backdoor LOGIN role,
 *         re-grant revoked audit privileges, CREATE OR REPLACE a SECURITY DEFINER body, DROP audit_log, DROP SCHEMA core CASCADE,
 *         session-level role escalation that survives COMMIT (pool poisoning).
 *   CANNOT (HARD-FLOOR, real properties): SUPERUSER / BYPASSRLS / REPLICATION, predefined pg_* roles, ALTER SYSTEM,
 *         COPY … PROGRAM, server files (pg_read_file, COPY FROM file, lo_import), session_replication_role, untrusted
 *         languages/extensions, event triggers, pg_reload_conf, signalling a superuser.
 * Gated: see twenty-kit.ts.
 */
import { Client } from 'pg';

import { ACCEPTED, ADMIN_URL, attempt, connect, describeTwenty, expectedRisk, hardFloor, OWNER_URL, rolledBack } from './twenty-kit';

jest.setTimeout(120_000);

const POSTURE_FINGERPRINT_SQL = `
SELECT md5(string_agg(line, E'\\n' ORDER BY line)) AS h FROM (
  SELECT 'rls|' || c.relname || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity AS line
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relkind = 'r'
  UNION ALL SELECT 'pol|' || polrelid::regclass || '|' || polname || '|' || coalesce(pg_get_expr(polqual, polrelid), '') FROM pg_policy
  UNION ALL SELECT 'fn|' || p.oid::regprocedure || '|' || md5(p.prosrc) || '|' || p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'core'
  UNION ALL SELECT 'trg|' || tgrelid::regclass || '|' || tgname || '|' || tgenabled::text FROM pg_trigger WHERE NOT tgisinternal
  UNION ALL SELECT 'role|' || rolname || '|' || rolcanlogin || '|' || rolsuper || '|' || rolbypassrls FROM pg_roles WHERE rolname !~ '^pg_'
  UNION ALL SELECT 'mem|' || pg_get_userbyid(roleid) || '>' || pg_get_userbyid(member) || '|' || admin_option || inherit_option || set_option FROM pg_auth_members
  UNION ALL SELECT 'acl|audit_log|' || coalesce(array_to_string(relacl, ','), '') FROM pg_class WHERE oid = 'core.audit_log'::regclass
) x`;

describeTwenty('Twenty Option A injection simulation (crewflow_owner; everything rolled back)', () => {
  let admin: Client;
  let owner: Client;
  let before: string;

  beforeAll(async () => {
    admin = await connect(ADMIN_URL!, 'twenty-t7-admin');
    owner = await connect(OWNER_URL!, 'twenty-t7-injection');
    const who = (await owner.query(`SELECT session_user AS s, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = session_user`)).rows[0];
    if (who.s !== 'crewflow_owner' || who.rolsuper || who.rolbypassrls) throw new Error('not the crewflow_owner login. Refusing.');
    before = (await admin.query(POSTURE_FINGERPRINT_SQL)).rows[0].h;
  });

  afterAll(async () => {
    await owner?.end();
    await admin?.end();
  });

  // ---------------------------------------------------------------------------------------------------------------- CAN
  const can: Array<{ id: string; sev: 'CRITICAL' | 'HIGH' | 'MEDIUM'; what: string; sql: string[]; probe?: string; accept: string }> = [
    { id: 'G-02a', sev: 'CRITICAL', what: 'ALTER TABLE … NO FORCE ROW LEVEL SECURITY on a tenant table', sql: ['ALTER TABLE core.audit_log NO FORCE ROW LEVEL SECURITY'], accept: ACCEPTED.policyModification },
    { id: 'G-02b', sev: 'CRITICAL', what: 'DISABLE ROW LEVEL SECURITY on a tenant table', sql: ['ALTER TABLE core.audit_log DISABLE ROW LEVEL SECURITY'], accept: ACCEPTED.policyModification },
    {
      id: 'G-02c', sev: 'CRITICAL', what: 'ALTER POLICY … USING (true): FORCE stays on, so a FORCE-only posture gate cannot see it',
      sql: [`DO $$ DECLARE p record; BEGIN SELECT polname INTO p FROM pg_policy WHERE polrelid = 'core.audit_log'::regclass LIMIT 1; EXECUTE format('ALTER POLICY %I ON core.audit_log USING (true)', p.polname); END $$`],
      accept: `${ACCEPTED.policyModification}; mandatory control: semantic posture hash (M0 §6.4 #4)`,
    },
    { id: 'G-04a', sev: 'CRITICAL', what: 'CREATE ROLE … LOGIN and GRANT rab_secure_owner to it (backdoor surviving password rotation)', sql: [`CREATE ROLE twa_t7_backdoor LOGIN PASSWORD 'x-rolled-back'`, 'GRANT rab_secure_owner TO twa_t7_backdoor'], accept: `${ACCEPTED.persistence}; runbook: rotation is not remediation` },
    { id: 'G-04b', sev: 'CRITICAL', what: 'CREATE OR REPLACE the body of a SECURITY DEFINER function (core.current_org())', sql: [`CREATE OR REPLACE FUNCTION core.current_org() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULL::uuid $f$`], accept: ACCEPTED.persistence },
    { id: 'G-05b', sev: 'HIGH', what: 'GRANT UPDATE, DELETE ON core.audit_log TO crewflow_app (re-grant the revoked append-only privileges)', sql: ['GRANT UPDATE, DELETE ON core.audit_log TO crewflow_app'], accept: ACCEPTED.auditTampering },
    { id: 'G-02d', sev: 'CRITICAL', what: 'DROP TABLE core.audit_log CASCADE', sql: ['DROP TABLE core.audit_log CASCADE'], accept: ACCEPTED.objectDeletion },
    { id: 'G-02e', sev: 'CRITICAL', what: 'DROP SCHEMA core CASCADE (one statement destroys everything)', sql: ['DROP SCHEMA core CASCADE'], accept: `${ACCEPTED.objectDeletion}; recovery is PITR only (G-11)` },
    { id: 'F-E2', sev: 'MEDIUM', what: 'ALTER ROLE crewflow_app PASSWORD (reset another login\'s password via implicit ADMIN)', sql: [`ALTER ROLE crewflow_app PASSWORD 'x-rolled-back'`], accept: `${ACCEPTED.persistence}; optional hardening ALTER ROLE crewflow_owner NOCREATEROLE after install` },
  ];

  it.each(can)('CAN (EXPECTED-RISK $id): $what', async ({ id, sev, what, sql, accept }) => {
    const states = await rolledBack(owner, async () => {
      const out: string[] = [];
      for (const s of sql) out.push((await attempt(owner, s)).state);
      return out;
    });
    expect(states).toEqual(sql.map(() => 'OK'));
    expectedRisk(id, sev, `SQL injection as the owner login → ${what}`, `statements: ${states.join(',')} (rolled back)`, accept);
  });

  it('CAN (EXPECTED-RISK G-02f): after NO FORCE inside the injected transaction, the owner reads every tenant\'s audit rows', async () => {
    const counts = await rolledBack(owner, async () => {
      const bound = Number((await owner.query(`SELECT count(*)::int AS n FROM core.audit_log`)).rows[0].n);
      await owner.query('ALTER TABLE core.audit_log NO FORCE ROW LEVEL SECURITY');
      const all = Number((await owner.query(`SELECT count(*)::int AS n FROM core.audit_log`)).rows[0].n);
      return { bound, all };
    });
    const real = Number((await admin.query(`SELECT count(*)::int AS n FROM core.audit_log`)).rows[0].n);
    expect(counts.bound).toBe(0);
    expect(counts.all).toBe(real);
    expectedRisk('G-02f', 'CRITICAL', 'injection → NO FORCE → reads every tenant\'s rows', `no context: ${counts.bound} rows before, ${counts.all}/${real} after (rolled back)`, ACCEPTED.injection);
  });

  it('CAN (EXPECTED-RISK G-09): a session-level set_config(\'role\', …, false) inside a SELECT survives COMMIT (pool poisoning)', async () => {
    const victim = await connect(OWNER_URL!, 'twenty-t7-pool');
    try {
      await victim.query('BEGIN');
      await victim.query(`SELECT set_config('role', 'rab_secure_owner', false)`);
      await victim.query('COMMIT');
      const after = (await victim.query('SELECT current_user AS u')).rows[0].u;
      expect(after).toBe('rab_secure_owner');
      expectedRisk(
        'G-09', 'MEDIUM',
        'one injected SELECT on a pooled owner connection → session role becomes rab_secure_owner → every later request on that pooled connection runs as the schema owner',
        `current_user after COMMIT: ${after}`,
        `${ACCEPTED.injection}; mandatory control M0 §6.4 #3: RESET ROLE/DISCARD ALL on checkout + current_user = session_user assertion in runInTenantContext (Agent 3 security, PR 8) — wire the TenantContextService test when it lands`,
      );
    } finally {
      await victim.end();
    }
  });

  // ------------------------------------------------------------------------------------------------------------- CANNOT
  const cannot: Array<{ id: string; what: string; sql: string; states: string[]; noTx?: boolean }> = [
    { id: 'HF-1', what: 'ALTER ROLE crewflow_owner SUPERUSER', sql: 'ALTER ROLE crewflow_owner SUPERUSER', states: ['42501'] },
    { id: 'HF-2', what: 'ALTER ROLE crewflow_owner BYPASSRLS', sql: 'ALTER ROLE crewflow_owner BYPASSRLS', states: ['42501'] },
    { id: 'HF-3', what: 'CREATE ROLE … BYPASSRLS', sql: 'CREATE ROLE twa_t7_bypass BYPASSRLS', states: ['42501'] },
    { id: 'HF-4', what: 'ALTER ROLE crewflow_owner REPLICATION', sql: 'ALTER ROLE crewflow_owner REPLICATION', states: ['42501'] },
    { id: 'HF-5', what: 'GRANT pg_execute_server_program to itself (PG ≥ 16; D10 refuses < 16)', sql: 'GRANT pg_execute_server_program TO crewflow_owner', states: ['42501'] },
    { id: 'HF-6', what: 'GRANT pg_read_server_files to itself', sql: 'GRANT pg_read_server_files TO crewflow_owner', states: ['42501'] },
    { id: 'HF-7', what: 'GRANT pg_read_all_data to itself', sql: 'GRANT pg_read_all_data TO crewflow_owner', states: ['42501'] },
    { id: 'HF-8', what: 'ALTER SYSTEM (outside a transaction: it refuses transaction blocks)', sql: `ALTER SYSTEM SET log_statement = 'none'`, states: ['42501'], noTx: true },
    { id: 'HF-9', what: 'COPY … TO PROGRAM', sql: `COPY (SELECT 1) TO PROGRAM 'id'`, states: ['42501'] },
    { id: 'HF-10', what: 'COPY … FROM a server file', sql: `COPY core.audit_log (action) FROM '/etc/passwd'`, states: ['42501'] },
    { id: 'HF-11', what: 'pg_read_file', sql: `SELECT pg_read_file('/etc/passwd')`, states: ['42501'] },
    { id: 'HF-12', what: 'server-side lo_import', sql: `SELECT lo_import('/etc/passwd')`, states: ['42501'] },
    { id: 'HF-13', what: 'SET session_replication_role = replica (skips triggers incl. guards)', sql: `SET session_replication_role = replica`, states: ['42501'] },
    { id: 'HF-14', what: 'CREATE EXTENSION file_fdw (untrusted)', sql: 'CREATE EXTENSION file_fdw', states: ['42501'] },
    { id: 'HF-15', what: 'CREATE LANGUAGE plpython3u / untrusted language', sql: 'CREATE LANGUAGE plpython3u', states: ['42501', '58P01', '0A000', '42704'] },
    { id: 'HF-16', what: 'CREATE EVENT TRIGGER', sql: `CREATE EVENT TRIGGER twa_t7_evt ON ddl_command_start EXECUTE FUNCTION pg_catalog.pg_event_trigger_ddl_commands()`, states: ['42501'] },
    { id: 'HF-17', what: 'pg_reload_conf()', sql: 'SELECT pg_reload_conf()', states: ['42501'] },
    { id: 'HF-18', what: 'ALTER DATABASE … SET session_replication_role (superuser-only setting)', sql: `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET session_replication_role = replica', current_database()); END $$`, states: ['42501'] },
  ];

  it.each(cannot)('CANNOT (HARD-FLOOR $id): $what', async ({ id, what, sql, states, noTx }) => {
    const r = noTx ? await attempt(owner, sql) : await rolledBack(owner, () => attempt(owner, sql));
    if (noTx && r.state === 'OK') await admin.query('ALTER SYSTEM RESET log_statement'); // never leave a changed cluster behind
    expect(states).toContain(r.state);
    hardFloor(id, `the owner login cannot: ${what}`, `SQLSTATE ${r.state}`);
  });

  it('nothing the simulation did persisted (semantic catalogue fingerprint unchanged)', async () => {
    const after = (await admin.query(POSTURE_FINGERPRINT_SQL)).rows[0].h;
    expect(after).toBe(before);
    const backdoor = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname IN ('twa_t7_backdoor', 'twa_t7_bypass')`);
    expect(backdoor.rowCount).toBe(0);
  });
});
