import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { ownerLoginRolePostureProblems } from '../../database/boot-checks/owner-login-posture';
import { OWNER_LOGIN_BEHAVIOUR_CATALOGUE } from '../../database/boot-checks/owner-login-behaviour-catalogue';
import { integrationTestDatabase } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * The behaviour-change catalogue, REPRODUCED on a real database built with the owner-login bootstrap
 * (database/boot-checks/owner-login-behaviour-catalogue.ts). One `it` per id. Each test asserts what the owner login CAN do
 * now — the loss — so it never "passes" a weakened control: if one of these starts failing, the behaviour changed again
 * and the catalogue entry must be reviewed. Every statement that changes something runs inside a transaction that is
 * ROLLED BACK.
 *
 * Runs only when TEST_DATABASE_URL is the owner login `crewflow_owner` (the owner-login harness; Agent 5's
 * twenty-test-env / the twa-sec disposable replay). On the legacy crewflow_app harness the suite is skipped with a
 * warning — it is NOT a pass there (recorded in the report as NOT RUN until CI uses the owner-login database).
 */
// DEAD-07: the validated TEST pair (throws on an invalid pair, never a silent skip); the opt-in is the app login itself.
const env = integrationTestDatabase();
const OWNER = env.app.login === 'crewflow_owner';
const suite = OWNER ? describe : describe.skip;
if (!OWNER) console.warn('[owner-login catalogue] SKIPPED: TEST_DATABASE_URL is not the owner login crewflow_owner (NOT a pass).'); // eslint-disable-line no-console

type Q = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

suite('owner-login behaviour-change catalogue (real PostgreSQL, as crewflow_owner)', () => {
  let owner: Client;
  let admin: Client;
  const q = (c: Client): Q => async (sql, params) => (await c.query(sql, params as unknown[] | undefined)).rows;
  const orgA = '0a000000-0000-4000-8000-00000000000a';
  const orgB = '0b000000-0000-4000-8000-00000000000b';

  /** Inserts a minimal core.organisation row as the superuser, filling NOT NULL columns without a default by type. */
  async function seedOrganisation(id: string): Promise<void> {
    const cols = await q(admin)(
      `SELECT column_name AS c, udt_name AS t FROM information_schema.columns
        WHERE table_schema = 'core' AND table_name = 'organisation' AND is_nullable = 'NO' AND column_default IS NULL AND column_name <> 'id'`,
    );
    const values: unknown[] = [id];
    const names = ['id'];
    for (const { c, t } of cols) {
      names.push(String(c));
      values.push(t === 'bool' ? false : t === 'int4' || t === 'int8' ? 0 : t === 'timestamptz' ? new Date() : `cat-${String(c)}-${id.slice(0, 2)}`);
    }
    await admin.query(
      `INSERT INTO core.organisation (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (id) DO NOTHING`,
      values,
    );
  }

  async function rolledBack<T>(c: Client, fn: () => Promise<T>): Promise<T> {
    await c.query('BEGIN');
    try {
      return await fn();
    } finally {
      await c.query('ROLLBACK');
    }
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    admin = new Client({ connectionString: env!.adminUrl });
    await owner.connect();
    await admin.connect();
    await seedOrganisation(orgA);
    await seedOrganisation(orgB);
  });

  afterAll(async () => {
    await admin?.query(`DELETE FROM core.organisation WHERE id = ANY($1::uuid[])`, [[orgA, orgB]]).catch(() => undefined);
    await owner?.end();
    await admin?.end();
  });

  it('the connection is the owner login itself', async () => {
    expect((await q(owner)('SELECT current_user::text AS cu, session_user::text AS su'))[0]).toEqual({ cu: 'crewflow_owner', su: 'crewflow_owner' });
    expect(OWNER_LOGIN_BEHAVIOUR_CATALOGUE.length).toBeGreaterThan(10);
  });

  it('BC-01: the runtime login inherits the owner roles; ALTER POLICY / NO FORCE succeed for it', async () => {
    const [m] = await q(owner)(
      `SELECT pg_has_role(current_user, 'rab_secure_owner', 'USAGE') AS secure, pg_has_role(current_user, 'crewflow', 'USAGE') AS crewflow`,
    );
    expect(m).toEqual({ secure: true, crewflow: true });
    await rolledBack(owner, async () => {
      await owner.query(`ALTER TABLE core.shift NO FORCE ROW LEVEL SECURITY`);
      await owner.query(`ALTER POLICY user_select ON core."user" USING (true)`);
    });
  });

  it('BC-02: a legacy schema-role session is refused by the runtime assertion (SET ROLE crewflow_app on the superuser session)', async () => {
    const { assertRuntimeDbRole } = await import('../../engine/utils/assert-runtime-db-role');
    const shim = (c: Client) => ({ query: async (sql: string, params?: unknown[]) => (await c.query(sql, params)).rows }) as never;
    await expect(assertRuntimeDbRole(shim(owner), 'API server')).resolves.toBeUndefined();
    await rolledBack(admin, async () => {
      await admin.query('SET LOCAL ROLE crewflow_app');
      await expect(assertRuntimeDbRole(shim(admin), 'API server')).rejects.toThrow(/not "crewflow_owner"/);
    });
  });

  it('BC-03: without context the owner login sees no pre-auth rows (M-T1); one SET ROLE rab_secure_owner reads every tenant', async () => {
    const [{ n: plain }] = await q(owner)(`SELECT count(*)::int AS n FROM core.organisation WHERE id = ANY($1::uuid[])`, [[orgA, orgB]]);
    expect(plain).toBe(0);
    const viaRole = await rolledBack(owner, async () => {
      await owner.query('SET LOCAL ROLE rab_secure_owner');
      return (await q(owner)(`SELECT count(*)::int AS n FROM core.organisation WHERE id = ANY($1::uuid[])`, [[orgA, orgB]]))[0]!.n;
    });
    expect(viaRole).toBe(2);
  });

  it('BC-04: the MFA guard trigger can be disabled by the owner login (account takeover / MFA bypass path)', async () => {
    await rolledBack(owner, async () => {
      await owner.query(`ALTER TABLE core."user" DISABLE TRIGGER user_mfa_columns_guard`);
      const [{ e }] = await q(owner)(`SELECT tgenabled::text AS e FROM pg_trigger WHERE tgname = 'user_mfa_columns_guard'`);
      expect(e).toBe('D');
    });
  });

  it('BC-05: a policy rewritten to USING (true) keeps FORCE on (a FORCE-only check cannot see it)', async () => {
    await rolledBack(owner, async () => {
      await owner.query(`ALTER POLICY organisation_self ON core.organisation USING (true) WITH CHECK (true)`);
      const [f] = await q(owner)(`SELECT relforcerowsecurity AS force FROM pg_class WHERE oid = 'core.organisation'::regclass`);
      expect(f!.force).toBe(true);
      const [{ n }] = await q(owner)(`SELECT count(*)::int AS n FROM core.organisation WHERE id = ANY($1::uuid[])`, [[orgA, orgB]]);
      expect(n).toBe(2);
    });
  });

  it('BC-06: DROP SCHEMA core CASCADE succeeds for the owner login (rolled back)', async () => {
    // Shown in two exact parts instead of dropping core itself: a real `DROP SCHEMA core CASCADE` takes one lock per object
    // and exhausts max_locks_per_transaction on a full CI database ("out of shared memory"), proving nothing about privileges.
    // 1. Catalog: core and every core table belong to roles the owner login holds with USAGE (it inherits them), and DROP
    //    SCHEMA … CASCADE needs only ownership of the schema; crewflow_app holds neither.
    const [own] = await q(owner)(
      `SELECT pg_get_userbyid(n.nspowner)::text AS owner,
              pg_has_role(current_user, n.nspowner, 'USAGE') AS me,
              pg_has_role('crewflow_app', n.nspowner, 'USAGE') AS app,
              (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p')
                  AND NOT pg_has_role(current_user, c.relowner, 'USAGE')) AS tables_not_mine
         FROM pg_namespace n WHERE n.nspname = 'core'`,
    );
    expect(own).toEqual({ owner: 'rab_secure_owner', me: true, app: false, tables_not_mine: 0 });
    // 2. The same statement on a throwaway schema with the same owner as core (rab_secure_owner), holding a table owned by
    //    crewflow and one by rab_secure_owner, run AS crewflow_owner: it drops the schema and everything in it. crewflow_app
    //    is refused. Built through the superuser fixture inside one transaction that is always rolled back.
    const schema = `bc06_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const dropAs = async (role: string) =>
      rolledBack(admin, async () => {
        await admin.query(`CREATE SCHEMA ${schema} AUTHORIZATION rab_secure_owner`);
        await admin.query(`CREATE TABLE ${schema}.t_crewflow (id int)`);
        await admin.query(`ALTER TABLE ${schema}.t_crewflow OWNER TO crewflow`);
        await admin.query(`CREATE TABLE ${schema}.t_secure (id int)`);
        await admin.query(`ALTER TABLE ${schema}.t_secure OWNER TO rab_secure_owner`);
        await admin.query(`SET LOCAL ROLE ${role}`);
        expect((await q(admin)('SELECT current_user::text AS u'))[0]!.u).toBe(role);
        await admin.query('SAVEPOINT bc06'); // a refused DROP must not abort the transaction before the checks below
        const outcome = await admin.query(`DROP SCHEMA ${schema} CASCADE`).then(
          () => 'ok',
          async (e: { code?: string }) => {
            await admin.query('ROLLBACK TO SAVEPOINT bc06');
            return e.code ?? 'error';
          },
        );
        await admin.query('RESET ROLE');
        const [{ n }] = await q(admin)(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`, [schema]);
        return { outcome, remaining: n };
      });
    expect(await dropAs('crewflow_owner')).toEqual({ outcome: 'ok', remaining: 0 });
    expect(await dropAs('crewflow_app')).toEqual({ outcome: '42501', remaining: 1 });
  });

  it('BC-07: the owner login can re-grant itself UPDATE / DELETE / TRUNCATE on audit_log', async () => {
    expect((await q(owner)(`SELECT has_table_privilege('core.audit_log', 'DELETE') AS d`))[0]!.d).toBe(false);
    await rolledBack(owner, async () => {
      await owner.query('GRANT UPDATE, DELETE, TRUNCATE ON core.audit_log TO crewflow');
      expect((await q(owner)(`SELECT has_table_privilege('core.audit_log', 'DELETE') AS d`))[0]!.d).toBe(true);
    });
  });

  it('BC-08: ACCEPTED (owner, 2026-11-05) — the API login can EXECUTE the Worker-only dispatch-claim functions', async () => {
    const rows = await q(owner)(
      `SELECT p.proname::text AS f, has_function_privilege(p.oid, 'EXECUTE') AS can FROM pg_proc p
        WHERE p.pronamespace = 'core'::regnamespace AND p.proname LIKE 'worker\\_claim\\_%\\_dispatch' ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.can === true)).toBe(true);
  });

  it('BC-09: a backdoor LOGIN role inside rab_secure_owner can be created — and the inventory refuses it', async () => {
    await rolledBack(owner, async () => {
      await owner.query(`CREATE ROLE bc09_backdoor LOGIN PASSWORD NULL`);
      await owner.query(`GRANT rab_secure_owner TO bc09_backdoor`);
      const problems = await ownerLoginRolePostureProblems(q(owner));
      expect(problems.join('; ')).toMatch(/"bc09_backdoor" is a member of owner role "rab_secure_owner"/);
      expect(problems.join('; ')).toMatch(/a LOGIN role it administers/);
    });
  });

  it('BC-10: ACCEPTED (owner, 2026-11-05) — the pointer table is readable (0 rows, restrictive deny) instead of refused; SET ROLE reads it', async () => {
    expect((await q(owner)(`SELECT has_table_privilege('core.worker_dispatch_pointer', 'SELECT') AS s`))[0]!.s).toBe(true);
    await expect(q(owner)(`SELECT count(*)::int AS n FROM core.worker_dispatch_pointer`)).resolves.toEqual([{ n: 0 }]);
    await rolledBack(owner, async () => {
      await owner.query('SET LOCAL ROLE rab_secure_owner');
      await expect(q(owner)(`SELECT count(*) FROM core.worker_dispatch_pointer`)).resolves.toHaveLength(1);
      await expect(q(owner)(`SELECT count(*) FROM core.worker_due_work`)).resolves.toHaveLength(1);
    });
  });

  it('BC-11: ACCEPTED (owner, 2026-11-05) — the runtime login passes the deployment-identity bind gate', async () => {
    // core.deployment_identity_bind refuses a login that is not a member of rab_secure_owner with 42501 BEFORE validating
    // its arguments. As the owner login the call gets past that gate and fails only on the deliberately invalid
    // environment (22023): the runtime could rebind the marker with valid arguments.
    const outcome = await rolledBack(owner, () =>
      owner
        .query(`SELECT core.deployment_identity_bind('not-an-environment', gen_random_uuid(), 'catalogue BC-11 probe', 'bc11', NULL, ARRAY['localhost'])`)
        .then(() => 'ok', (e: { code?: string }) => e.code ?? 'error'),
    );
    expect(outcome).toBe('22023');
  });

  it('BC-12: ACCEPTED (owner, 2026-11-05) — no logical backup — row_security = off (what pg_dump sets) is refused for the NOBYPASSRLS owner', async () => {
    await rolledBack(owner, async () => {
      await owner.query('SET LOCAL row_security = off');
      await expect(owner.query('SELECT count(*) FROM core.shift')).rejects.toThrow(/row-level security/);
    });
  });

  it('BC-13: ACCEPTED (owner, 2026-11-05) — the secret columns crewflow_app could not read are readable by the owner login', async () => {
    const [r] = await q(owner)(
      `SELECT has_column_privilege('crewflow_app', 'core."user"', 'password_hash', 'SELECT') AS app,
              has_column_privilege('core."user"', 'password_hash', 'SELECT') AS me,
              has_column_privilege('core."user"', 'totp_secret_encrypted', 'SELECT') AS totp`,
    );
    expect(r).toEqual({ app: false, me: true, totp: true });
    await expect(owner.query(`SELECT password_hash FROM core."user" LIMIT 0`)).resolves.toBeDefined();
  });

  it('BC-14: a session-level SET ROLE survives COMMIT on a raw connection (the pool-safety reset is what clears it)', async () => {
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('role', 'rab_secure_owner', false)`);
    await owner.query('COMMIT');
    try {
      expect((await q(owner)('SELECT current_user::text AS u'))[0]!.u).toBe('rab_secure_owner');
    } finally {
      await owner.query('RESET ROLE');
    }
    expect((await q(owner)('SELECT current_user::text AS u'))[0]!.u).toBe('crewflow_owner');
  });

  it('BC-15: M-T2 allow-list: the owner login itself is refused on the versioning columns; SET LOCAL ROLE crewflow is allowed', async () => {
    const [g] = await q(owner)(
      `SELECT strpos(prosrc, 'current_user IN (''crewflow''::name, ''rab_secure_owner''::name)') > 0 AS allow
         FROM pg_proc WHERE oid = 'core.workspace_schema_registry_versioning_guard()'::regprocedure`,
    );
    expect(g!.allow).toBe(true);
    await rolledBack(owner, async () => {
      await owner.query('SET LOCAL ROLE crewflow');
      expect((await q(owner)('SELECT current_user::text AS u'))[0]!.u).toBe('crewflow');
    });
  });

  it('BC-16: the one URL is the schema owner with CREATEROLE', async () => {
    const [r] = await q(owner)(`SELECT rolcreaterole AS cr, rolbypassrls AS b, rolsuper AS s FROM pg_roles WHERE rolname = current_user`);
    expect(r).toEqual({ cr: true, b: false, s: false });
  });

  it('BC-17: MITIGATED (owner decision 2026-11-05, Agent 1) — crewflow / crewflow_app are NOLOGIN without a password; crewflow_worker stays LOGIN without a password (residual)', async () => {
    const rows = await q(owner)(`SELECT rolname::text AS r, rolcanlogin AS l FROM pg_roles WHERE rolname IN ('crewflow', 'crewflow_app', 'crewflow_worker') ORDER BY 1`);
    expect(rows).toEqual([
      { r: 'crewflow', l: false },
      { r: 'crewflow_app', l: false },
      { r: 'crewflow_worker', l: true }, // residual: migrations 1786721300000 / 1786721340000 assert its LOGIN
    ]);
    // No password on any of the three (pg_authid is superuser-only, so read through the fixture; the owner login cannot).
    const pw = await q(admin)(`SELECT rolname::text AS r, rolpassword IS NULL AS none FROM pg_authid WHERE rolname IN ('crewflow', 'crewflow_app', 'crewflow_worker') ORDER BY 1`);
    expect(pw).toEqual([
      { r: 'crewflow', none: true },
      { r: 'crewflow_app', none: true },
      { r: 'crewflow_worker', none: true },
    ]);
    await expect(owner.query(`SELECT rolpassword FROM pg_authid LIMIT 1`)).rejects.toThrow(/permission denied/);
  });

  it('BC-18: ACCEPTED (owner, 2026-11-04) — direct writes to the 7 pre-auth tables crewflow_app could not write are not refused', async () => {
    // Expected difference, documented — not a passing security control: the database no longer refuses these writes for
    // the owner login; RLS still confines them to the bound tenant, and the app-level check
    // (tools/check-protected-table-writes.cjs) keeps every write in its owning service.
    const lost: Array<[string, string]> = [
      ['login_handoff', 'DELETE'],
      ['organisation_invitation', 'DELETE'],
      ['released_host_label', 'DELETE'],
      ['user_auth_identity', 'DELETE'],
      ['user_session', 'DELETE'],
      ['member_invitation', 'DELETE'],
      ['email_change_request', 'DELETE'],
      ['login_handoff', 'INSERT'],
      ['organisation_invitation', 'UPDATE'],
      ['released_host_label', 'UPDATE'],
    ];
    for (const [table, op] of lost) {
      const [r] = await q(owner)(
        `SELECT has_table_privilege('crewflow_app', $1::regclass, $2) AS app, has_table_privilege($1::regclass, $2) AS me`,
        [`core."${table}"`, op],
      );
      expect({ table, op, ...r }).toEqual({ table, op, app: false, me: true });
    }
    // The X2 statement: refused (42501) for crewflow_app, accepted for the owner login; without tenant context RLS leaves 0 rows.
    const result = await rolledBack(owner, () => owner.query(`DELETE FROM core.member_invitation`));
    expect(result.rowCount).toBe(0);
  });

  // ── Agent 5's differential findings (PR #74). Each reproduces the difference; none is a passing control. ──

  const colPriv = async (table: string, column: string, op: string) =>
    (await q(owner)(
      `SELECT has_column_privilege('crewflow_app', $1::regclass, $2, $3) AS app, has_column_privilege($1::regclass, $2, $3) AS me`,
      [table, column, op],
    ))[0];
  const tablePriv = async (table: string, op: string) =>
    (await q(owner)(`SELECT has_table_privilege('crewflow_app', $1::regclass, $2) AS app, has_table_privilege($1::regclass, $2) AS me`, [table, op]))[0];

  it('COLGRANT-1: ACCEPTED (owner, 2026-11-05) — server-owned columns crewflow_app could not INSERT are insertable by the owner login', async () => {
    for (const [table, column] of [['core.ai_usage', 'id'], ['core.ai_usage', 'created_at'], ['core.ai_skill', 'id'], ['core.ai_action_proposal', 'expires_at']] as const) {
      expect({ table, column, ...(await colPriv(table, column, 'INSERT')) }).toEqual({ table, column, app: false, me: true });
    }
  });

  it('REF-1: ACCEPTED (owner, 2026-11-04) — the owner login can rewrite core.permission and core.migrations rows (every tenant)', async () => {
    for (const [table, op] of [['core.permission', 'UPDATE'], ['core.permission', 'DELETE'], ['core.migrations', 'UPDATE'], ['core.migrations', 'DELETE']] as const) {
      expect({ table, op, ...(await tablePriv(table, op)) }).toEqual({ table, op, app: false, me: true });
    }
    // Non-vacuous: one real row each, rolled back.
    const perm = await rolledBack(owner, () => owner.query(`UPDATE core.permission SET key = key WHERE key = (SELECT min(key) FROM core.permission)`));
    expect(perm.rowCount).toBe(1);
    const ledger = await rolledBack(owner, () => owner.query(`UPDATE core.migrations SET name = name WHERE id = (SELECT max(id) FROM core.migrations)`));
    expect(ledger.rowCount).toBe(1);
  });

  it('HL-1: ACCEPTED (owner, 2026-11-05) — the owner login holds table privileges on the host-label namespace tables; no claim row without context', async () => {
    for (const table of ['core.host_label_claim', 'core.released_host_label', 'core.reserved_host_label']) {
      expect({ table, ...(await tablePriv(table, 'SELECT')) }).toEqual({ table, app: false, me: true });
    }
    expect((await q(owner)(`SELECT count(*)::int AS n FROM core.host_label_claim`))[0]).toEqual({ n: 0 });
  });

  it('AI-1: ACCEPTED (owner, 2026-11-05) — TRUNCATE on the AI tables and EXECUTE on the synthetic-data marker reach the owner login', async () => {
    for (const table of ['core.ai_skill', 'core.ai_usage', 'core.ai_conversation', 'core.ai_action_proposal', 'core.organisation_ai_model_preference']) {
      expect({ table, ...(await tablePriv(table, 'TRUNCATE')) }).toEqual({ table, app: false, me: true });
    }
    const [fn] = await q(owner)(
      `SELECT bool_or(has_function_privilege('crewflow_app', p.oid, 'EXECUTE')) AS app, bool_or(has_function_privilege(p.oid, 'EXECUTE')) AS me
         FROM pg_proc p WHERE p.pronamespace = 'core'::regnamespace AND p.proname = 'ai_dev_mark_organisation_synthetic'`,
    );
    expect(fn).toEqual({ app: false, me: true });
  });

  it('MFA-SESS-1: MITIGATED (4caaef2a) — mfa_verified_at cannot be stamped by an UPDATE, by the owner login or any role', async () => {
    expect(await colPriv('core.user_session', 'mfa_verified_at', 'UPDATE')).toEqual({ app: false, me: true }); // the privilege is there…
    const refused = await rolledBack(owner, () =>
      owner.query(`UPDATE core.user_session SET mfa_verified_at = now() WHERE false`).then(
        () => 'ok',
        (e: { code?: string }) => e.code,
      ),
    );
    expect(refused).toBe('42501'); // …the statement-level trigger refuses it anyway (SQLSTATE only, never the message text)
  });

  it('PROV-1: ACCEPTED (owner, 2026-11-05) — the workspace migrator identity check accepts the owner login; crewflow_app is still refused', async () => {
    const { WorkspaceSchemaMigrator } = await import('../../database/typeorm/workspace-schema/workspace-schema-migrator');
    const runner = { query: async (sql: string, params?: unknown[]) => (await owner.query(sql, params as unknown[] | undefined)).rows };
    const migrator = new WorkspaceSchemaMigrator(runner as never);
    await expect(migrator.assertMigrationIdentity()).resolves.toBeUndefined();
    // The schema role crewflow_app, reached through the superuser fixture (the owner login is not a member of it).
    const asApp = new WorkspaceSchemaMigrator({ query: async (sql: string, params?: unknown[]) => (await admin.query(sql, params as unknown[] | undefined)).rows } as never);
    await rolledBack(admin, async () => {
      await admin.query('SET LOCAL ROLE crewflow_app');
      await expect(asApp.assertMigrationIdentity()).rejects.toThrow(/refuses to run as "crewflow_app"/);
    });
  });
});
