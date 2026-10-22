import 'reflect-metadata';
import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { provisionWorkspaceSchema, WORKSPACE_TABLES } from '../../database/typeorm/workspace-schema/provision-workspace-schema';

/**
 * Server-path workspace provisioning — DATABASE layer (migration ServerPathWorkspaceProvisioning1786719500000).
 *
 * Every assertion that matters runs over the REAL restricted runtime login (`crewflow_app`, TEST_DATABASE_URL), never only
 * a superuser. The admin connection (TEST_DATABASE_URL_UNPOOLED, the bootstrap superuser of a disposable database) is used
 * for fixtures, catalog reads, failure injection and — via `SET ROLE crewflow` — to run the legacy TypeScript provisioner
 * so the two paths can be compared object by object.
 *
 * Covers the owner's brief §12 (1–16) plus the abuse cases the trade-off depends on: crewflow_app gained EXECUTE on ONE
 * fixed function and nothing else (no DDL, no RLS toggling, no role switching, no lifecycle mutators, no template control).
 */
// Needs core.provision_workspace (migration 1786719500000), which every database migrated from the chain now has.
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

interface Ws {
  id: string;
  org: string;
  owner: string;
  schema: string;
}

const schemaOf = (id: string) => `workspace_${id.replace(/-/g, '')}`;

describeIfDb('server-path workspace provisioning — database layer (crewflow_app)', () => {
  const { adminUrl, appUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  let admin: Client;
  const suffix = Math.random().toString(36).slice(2, 8);
  const created: Ws[] = [];
  const roles: string[] = [];

  const app = async (): Promise<Client> => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    return c;
  };

  /** One crewflow_app transaction with the server-bound GUCs (what TenantContextService sets from the verified session). */
  const asApp = async <T>(ctx: { org?: string; uid?: string; ws?: string }, fn: (c: Client) => Promise<T>, client?: Client): Promise<T> => {
    const c = client ?? (await app());
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true), set_config('rab.workspace_id', $3, true)`,
        [ctx.org ?? '', ctx.uid ?? '', ctx.ws ?? ''],
      );
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      if (!client) await c.end();
    }
  };

  const provision = (ws: Ws, ctx?: { org?: string; uid?: string }, client?: Client) =>
    asApp({ org: ctx?.org ?? ws.org, uid: ctx?.uid ?? ws.owner }, async (c) => (await c.query('SELECT core.provision_workspace($1) AS o', [ws.id])).rows[0].o as string, client);

  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ACCEPTED';
    } catch (e) {
      return (e as { code?: string }).code ?? 'NO-CODE';
    }
  };

  const seed = async (label: string, opts: { org?: string; schemaStatus?: string | null; status?: string } = {}): Promise<Ws> => {
    const r = await admin.query(
      `WITH o AS (
         INSERT INTO core.organisation(name, slug) SELECT $1::text, $1::text WHERE $2::uuid IS NULL RETURNING id
       ), org AS (SELECT id FROM o UNION ALL SELECT $2::uuid WHERE $2::uuid IS NOT NULL),
       u AS (
         INSERT INTO core."user"(organisation_id, email, first_name, last_name, status)
         SELECT id, $1::text || '@spp.invalid', 'SPP', 'Owner', 'active' FROM org RETURNING id, organisation_id
       )
       INSERT INTO core.manager_workspace(organisation_id, owner_user_id, name, subdomain, status, schema_status)
       SELECT organisation_id, id, $1::text, $1::text, $3::text, $4::text FROM u
       RETURNING id, organisation_id, owner_user_id`,
      [`spp-${label}-${suffix}`, opts.org ?? null, opts.status ?? 'active', opts.schemaStatus === undefined ? 'CREATING' : opts.schemaStatus],
    );
    const row = r.rows[0];
    const ws = { id: row.id, org: row.organisation_id, owner: row.owner_user_id, schema: schemaOf(row.id) };
    created.push(ws);
    return ws;
  };

  const state = async (ws: Ws) =>
    (
      await admin.query(
        `SELECT mw.schema_status, mw.schema_last_error, r.status AS registry, r.ready_at, r.last_migrated_at,
                (SELECT count(*)::int FROM pg_namespace WHERE nspname = $2) AS schemas,
                (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $2) AS relations
           FROM core.manager_workspace mw LEFT JOIN core.workspace_schema_registry r ON r.workspace_id = mw.id WHERE mw.id = $1`,
        [ws.id, ws.schema],
      )
    ).rows[0];

  /** Every structural/privilege fact of a workspace schema, with its name and uuid normalised, sorted. */
  const catalog = async (ws: Ws): Promise<string[]> => {
    const r = await admin.query(
      `SELECT x FROM (
         SELECT 'nsp|' || pg_get_userbyid(n.nspowner) || '|' || coalesce(n.nspacl::text, '') AS x FROM pg_namespace n WHERE n.nspname = $1
         UNION ALL
         SELECT 'rel|' || c.relname || '|' || c.relkind::text || '|' || pg_get_userbyid(c.relowner) || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' || coalesce(c.relacl::text, '')
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1
         UNION ALL
         SELECT 'col|' || c.relname || '|' || a.attnum || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull || '|' ||
                coalesce(pg_get_expr(d.adbin, d.adrelid), '') || '|' || coalesce(a.attacl::text, '')
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
         UNION ALL
         SELECT 'con|' || cl.relname || '|' || k.conname || '|' || pg_get_constraintdef(k.oid)
           FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = $1
         UNION ALL
         SELECT 'idx|' || indexname || '|' || indexdef FROM pg_indexes WHERE schemaname = $1
         UNION ALL
         SELECT 'pol|' || tablename || '|' || policyname || '|' || permissive || '|' || roles::text || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
           FROM pg_policies WHERE schemaname = $1
         UNION ALL
         SELECT 'trg|' || pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND NOT t.tgisinternal
       ) s ORDER BY x`,
      [ws.schema],
    );
    return r.rows.map((row: { x: string }) => row.x.split(ws.schema).join('<WS>').split(ws.id).join('<WSID>'));
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    const [{ rolsuper }] = (await admin.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows;
    if (!rolsuper) throw new Error('this suite needs the disposable database bootstrap superuser as TEST_DATABASE_URL_UNPOOLED');
  });

  afterAll(async () => {
    await admin.query(`DROP EVENT TRIGGER IF EXISTS spp_inject_failure`).catch(() => undefined);
    await admin.query(`DROP EVENT TRIGGER IF EXISTS spp_tamper`).catch(() => undefined);
    await admin.query(`DROP FUNCTION IF EXISTS public.spp_inject_failure()`).catch(() => undefined);
    for (const role of roles) {
      await admin.query(`REVOKE ALL ON SCHEMA core FROM ${role}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    await admin.end();
  });

  // ---------------------------------------------------------------------------------------------- identity and grants

  it('connects as the real restricted runtime login (crewflow_app, NOSUPERUSER, NOBYPASSRLS, owns nothing)', async () => {
    const c = await app();
    try {
      const { rows } = await c.query(
        `SELECT session_user AS s, current_user AS u, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
                (SELECT count(*)::int FROM pg_class WHERE relowner = r.oid) AS owned
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      expect(rows[0]).toEqual({ s: 'crewflow_app', u: 'crewflow_app', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, owned: 0 });
    } finally {
      await c.end();
    }
  });

  it('§12.7 the function is a crewflow-owned SECURITY DEFINER with a pinned search_path; PUBLIC has no EXECUTE; only crewflow_app is granted', async () => {
    const { rows } = await admin.query(
      `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
              (SELECT array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END ORDER BY 1)::text[]
                 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.privilege_type = 'EXECUTE') AS executors
         FROM pg_proc p WHERE p.oid = 'core.provision_workspace(uuid)'::regprocedure`,
    );
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].owner).toBe('crewflow');
    expect(rows[0].proconfig).toContain('search_path=pg_catalog, pg_temp');
    expect(rows[0].executors).toEqual(['crewflow', 'crewflow_app']);
  });

  it('§12.7 a role holding only PUBLIC privileges (plus USAGE on core) cannot execute it (42501)', async () => {
    const role = `spp_public_probe_${suffix}`;
    roles.push(role);
    await admin.query(`CREATE ROLE ${role} NOLOGIN`);
    await admin.query(`GRANT USAGE ON SCHEMA core TO ${role}`);
    await admin.query('BEGIN');
    try {
      await admin.query(`SET LOCAL ROLE ${role}`);
      await expect(admin.query(`SELECT core.provision_workspace(gen_random_uuid())`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  it('crewflow_app still cannot EXECUTE the provisioner-only functions or the verification helper (42501)', async () => {
    const c = await app();
    try {
      for (const sql of [
        `SELECT core.provision_workspace_schema(gen_random_uuid())`,
        `SELECT core.register_workspace_schema(gen_random_uuid())`,
        `SELECT core.begin_workspace_schema_attempt(gen_random_uuid())`,
        `SELECT core.mark_workspace_schema_ready(gen_random_uuid(), 1)`,
        `SELECT core.mark_workspace_schema_failed(gen_random_uuid(), 'x')`,
        `SELECT core.verify_workspace_schema_v1(gen_random_uuid())`,
        `SELECT * FROM core.worker_list_pending_workspace_schemas(10)`,
        `SELECT core.worker_resolve_workspace_organisation(gen_random_uuid())`,
      ]) {
        expect([sql, await codeOf(c.query(sql))]).toEqual([sql, '42501']);
      }
    } finally {
      await c.end();
    }
  });

  // ---------------------------------------------------------------------------------------------- happy path + RLS

  let ready: Ws;
  let legacy: Ws;

  it('§12.1 crewflow_app provisions its own CREATING workspace: READY, schema built, registry READY v1', async () => {
    ready = await seed('ready');
    expect(await provision(ready)).toBe('READY');
    const s = await state(ready);
    expect(s).toMatchObject({ schema_status: 'READY', schema_last_error: null, registry: 'READY', schemas: 1 });
    expect(s.ready_at).not.toBeNull();
  });

  it('§12.14 every created table has ENABLE + FORCE RLS, crewflow ownership, at least one policy; the schema is rab_secure_owner-owned', async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner,
              (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1`,
      [ready.schema],
    );
    expect(rows.map((r: { relname: string }) => r.relname).sort()).toEqual([...WORKSPACE_TABLES].sort());
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity, r.owner, r.policies > 0]).toEqual([r.relname, true, true, 'crewflow', true]);
    const [{ o }] = (await admin.query(`SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = $1`, [ready.schema])).rows;
    expect(o).toBe('rab_secure_owner');
    // No object in the workspace schema depends on anything in a temporary schema.
    const { rows: tempDeps } = await admin.query(
      `SELECT count(*)::int AS n FROM pg_depend d JOIN pg_class c ON c.oid = d.objid JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = d.refobjid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE n.nspname = $1 AND rn.nspname LIKE 'pg_temp%'`,
      [ready.schema],
    );
    expect(tempDeps[0].n).toBe(0);
  });

  it('RLS on the provisioned tables: zero rows with no context and with another workspace bound (crewflow_app)', async () => {
    const other = await seed('rls-other');
    for (const t of ['staff_profile', 'shift', 'venue', 'payroll_record']) {
      expect(await asApp({}, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${ready.schema}.${t}`)).rows[0].n)).toBe(0);
      expect(await asApp({ org: other.org, uid: other.owner, ws: other.id }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${ready.schema}.${t}`)).rows[0].n)).toBe(0);
    }
  });

  // ---------------------------------------------------------------------------------------------- no new DDL authority

  it('§12.2–§12.6 crewflow_app still cannot CREATE schemas/tables, ALTER/DROP workspace tables, disable RLS or SET ROLE', async () => {
    const c = await app();
    try {
      const attempts: Array<[string, string]> = [
        ['create schema', `CREATE SCHEMA spp_${suffix}`],
        ['create table in core', `CREATE TABLE core.spp_${suffix}(i int)`],
        ['create table in public', `CREATE TABLE public.spp_${suffix}(i int)`],
        ['create table in workspace', `CREATE TABLE ${ready.schema}.spp_${suffix}(i int)`],
        ['alter workspace table', `ALTER TABLE ${ready.schema}.shift ADD COLUMN spp int`],
        ['drop workspace table', `DROP TABLE ${ready.schema}.shift`],
        ['disable RLS', `ALTER TABLE ${ready.schema}.staff_profile DISABLE ROW LEVEL SECURITY`],
        ['no force RLS', `ALTER TABLE ${ready.schema}.staff_profile NO FORCE ROW LEVEL SECURITY`],
        ['drop policy', `DROP POLICY IF EXISTS staff_profile_shift_team_select ON ${ready.schema}.staff_profile`],
        ['create policy', `CREATE POLICY spp_open ON ${ready.schema}.staff_profile USING (true)`],
        ['drop schema', `DROP SCHEMA ${ready.schema} CASCADE`],
        ['create trigger', `CREATE TRIGGER spp BEFORE UPDATE ON ${ready.schema}.shift FOR EACH ROW EXECUTE FUNCTION core.reset_attendance_post_shift()`],
        ['replace the function', `CREATE OR REPLACE FUNCTION core.provision_workspace(p_workspace_id uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$`],
        ['alter the function', `ALTER FUNCTION core.provision_workspace(uuid) SECURITY INVOKER`],
        ['grant the function onward', `GRANT EXECUTE ON FUNCTION core.provision_workspace(uuid) TO PUBLIC`],
        ['set role crewflow', `SET ROLE crewflow`],
        ['set role rab_secure_owner', `SET ROLE rab_secure_owner`],
        ['set session authorization', `SET SESSION AUTHORIZATION crewflow`],
      ];
      const results = [];
      for (const [label, sql] of attempts) results.push([label, await codeOf(c.query(sql))]);
      // GRANT on a function you do not own is a WARNING-free no-op in some versions; it must never change the ACL.
      const outcomes = Object.fromEntries(results);
      for (const [label] of attempts) {
        if (label === 'grant the function onward') continue;
        expect([label, outcomes[label]]).toEqual([label, '42501']);
      }
      const [{ pub }] = (
        await admin.query(
          `SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = 'core.provision_workspace(uuid)'::regprocedure AND a.grantee = 0) AS pub`,
        )
      ).rows;
      expect(pub).toBe(false);
      const { rows } = await admin.query(
        `SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'staff_profile'`,
        [ready.schema],
      );
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    } finally {
      await c.end();
    }
  });

  it('crewflow_app gained no CREATE anywhere and no role membership after provisioning', async () => {
    const { rows } = await admin.query(
      `SELECT has_database_privilege('crewflow_app', current_database(), 'CREATE') AS db,
              has_schema_privilege('crewflow_app', 'core', 'CREATE') AS core,
              has_schema_privilege('crewflow_app', $1, 'CREATE') AS ws,
              has_schema_privilege('crewflow_app', $1, 'USAGE') AS ws_usage,
              pg_has_role('crewflow_app', 'crewflow', 'USAGE') AS m1, pg_has_role('crewflow_app', 'rab_secure_owner', 'USAGE') AS m2`,
      [ready.schema],
    );
    expect(rows[0]).toEqual({ db: false, core: false, ws: false, ws_usage: true, m1: false, m2: false });
  });

  // ---------------------------------------------------------------------------------------------- inputs and ownership

  it('§12.8 invalid ids are refused: NULL (22004), the nil uuid / an unknown uuid (P0002), a non-uuid (22P02)', async () => {
    const ws = await seed('inputs');
    const ctx = { org: ws.org, uid: ws.owner };
    expect(await codeOf(asApp(ctx, (c) => c.query(`SELECT core.provision_workspace(NULL)`)))).toBe('22004');
    expect(await codeOf(asApp(ctx, (c) => c.query(`SELECT core.provision_workspace('00000000-0000-0000-0000-000000000000')`)))).toBe('P0002');
    expect(await codeOf(asApp(ctx, (c) => c.query(`SELECT core.provision_workspace(gen_random_uuid())`)))).toBe('P0002');
    expect(await codeOf(asApp(ctx, (c) => c.query(`SELECT core.provision_workspace($1)`, ['workspace_x; DROP SCHEMA core']))) ).toBe('22P02');
    expect(await state(ws)).toMatchObject({ schema_status: 'CREATING', registry: null, schemas: 0 });
  });

  it('§12.9 a foreign workspace is not found (P0002) and untouched: other organisation, same organisation other owner, mismatched org binding, no binding', async () => {
    const victim = await seed('victim');
    const otherOrg = await seed('attacker');
    const sameOrg = await seed('colleague', { org: victim.org });
    const cases: Array<[string, { org?: string; uid?: string }]> = [
      ['other organisation owner', { org: otherOrg.org, uid: otherOrg.owner }],
      ['same organisation, other owner', { org: victim.org, uid: sameOrg.owner }],
      ['victim owner id with another organisation bound', { org: otherOrg.org, uid: victim.owner }],
      ['organisation bound, no user', { org: victim.org }],
      ['no context at all', {}],
    ];
    for (const [label, ctx] of cases) {
      expect([label, await codeOf(asApp(ctx, (c) => c.query(`SELECT core.provision_workspace($1)`, [victim.id])))]).toEqual([label, 'P0002']);
    }
    expect(await state(victim)).toMatchObject({ schema_status: 'CREATING', registry: null, schemas: 0 });
  });

  it('lifecycle gate: SUPERSEDED, legacy NULL and a non-active workspace are refused (55000) and untouched', async () => {
    for (const [label, opts] of [
      ['superseded', { schemaStatus: 'SUPERSEDED' }],
      ['legacy-null', { schemaStatus: null }],
      ['suspended', { status: 'suspended' }],
    ] as Array<[string, { schemaStatus?: string | null; status?: string }]>) {
      const ws = await seed(label, opts);
      expect([label, await codeOf(provision(ws))]).toEqual([label, '55000']);
      expect((await state(ws)).schemas).toBe(0);
    }
  });

  // ---------------------------------------------------------------------------------------------- idempotency and races

  it('§12.10 an already READY workspace is never re-provisioned: ALREADY_READY, catalog and registry unchanged', async () => {
    const before = await catalog(ready);
    const s0 = await state(ready);
    expect(await provision(ready)).toBe('ALREADY_READY');
    expect(await catalog(ready)).toEqual(before);
    const s1 = await state(ready);
    expect(s1.ready_at).toEqual(s0.ready_at);
    expect(s1.last_migrated_at).toEqual(s0.last_migrated_at);
  });

  it('§12.11 concurrent calls (two connections, as two API replicas would) build exactly one schema; READY exactly once', async () => {
    const ws = await seed('race');
    const [a, b, c3] = await Promise.all([app(), app(), app()]);
    try {
      const outcomes = await Promise.all([provision(ws, undefined, a), provision(ws, undefined, b), provision(ws, undefined, c3)]);
      expect(outcomes.sort()).toEqual(['ALREADY_READY', 'ALREADY_READY', 'READY']);
    } finally {
      await Promise.all([a.end(), b.end(), c3.end()]);
    }
    const s = await state(ws);
    expect(s).toMatchObject({ schema_status: 'READY', registry: 'READY', schemas: 1 });
    expect((await catalog(ws)).filter((l) => l.startsWith('rel|') && l.split('|')[2] === 'r')).toHaveLength(WORKSPACE_TABLES.length);
  });

  // ---------------------------------------------------------------------------------------------- failure, rollback, retry

  it('§12.12 a mid-template DDL failure rolls back to ZERO objects, records a SAFE FAILED error, and §12.13 a retry from FAILED succeeds', async () => {
    const ws = await seed('partial');
    // Fails CREATE TABLE <ws>.payroll_run — the 18th of 21 tables, after most of the template has been applied.
    await admin.query(`
      CREATE OR REPLACE FUNCTION public.spp_inject_failure() RETURNS event_trigger LANGUAGE plpgsql AS $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF r.command_tag = 'CREATE TABLE' AND r.object_identity = '${ws.schema}.payroll_run' THEN
            RAISE EXCEPTION 'spp injected failure with a secret-looking detail: password=hunter2';
          END IF;
        END LOOP;
      END $$`);
    await admin.query(`CREATE EVENT TRIGGER spp_inject_failure ON ddl_command_end EXECUTE FUNCTION public.spp_inject_failure()`);
    try {
      expect(await provision(ws)).toBe('FAILED');
    } finally {
      await admin.query(`DROP EVENT TRIGGER spp_inject_failure`);
      await admin.query(`DROP FUNCTION public.spp_inject_failure()`);
    }
    const failed = await state(ws);
    expect(failed).toMatchObject({ schema_status: 'FAILED', registry: 'FAILED', schemas: 1, relations: 0 });
    expect(failed.schema_last_error).toBe('V1 provisioning failed at apply (SQLSTATE P0001)');
    expect(failed.schema_last_error).not.toMatch(/hunter2|injected|password/);

    expect(await provision(ws)).toBe('READY');
    expect(await state(ws)).toMatchObject({ schema_status: 'READY', schema_last_error: null, registry: 'READY' });
    expect(await provision(ws)).toBe('ALREADY_READY');
  });

  it('a non-empty schema (stray object) is refused without adopting it, then a retry succeeds once it is removed', async () => {
    const ws = await seed('stray');
    await admin.query(`CREATE SCHEMA ${ws.schema} AUTHORIZATION rab_secure_owner`);
    await admin.query(`CREATE TABLE ${ws.schema}.stray(i int)`);
    expect(await provision(ws)).toBe('FAILED');
    const s = await state(ws);
    expect(s).toMatchObject({ schema_status: 'FAILED', schema_last_error: 'schema is not empty; refusing to apply' });
    await admin.query(`DROP TABLE ${ws.schema}.stray`);
    expect(await provision(ws)).toBe('READY');
  });

  it('a lost connection mid-provisioning (backend terminated while the template waits on a lock) leaves the previous state; retry succeeds', async () => {
    const ws = await seed('crash');
    const locker = new Client({ connectionString: adminUrl });
    await locker.connect();
    const victim = await app();
    victim.on('error', () => undefined);
    try {
      // Hold a lock the template needs part-way through (FKs to core.stored_file come after several tables).
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE core.stored_file IN ACCESS EXCLUSIVE MODE');
      const [{ pid }] = (await victim.query('SELECT pg_backend_pid() AS pid')).rows;
      const pending = codeOf(provision(ws, undefined, victim));
      // Wait until the provisioning backend is actually blocked inside the template.
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const { rows } = await admin.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
        blocked = rows[0]?.wait_event_type === 'Lock';
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked).toBe(true);
      // Part of the template already ran inside the (uncommitted) transaction before it blocked: it holds the
      // AccessExclusive locks of the tables it has just created (invisible to other sessions until commit).
      const { rows: seen } = await admin.query(`SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND locktype = 'relation' AND mode = 'AccessExclusiveLock' AND granted`, [pid]);
      expect(seen[0].n).toBeGreaterThan(0);
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      expect(await pending).toMatch(/^(57P01|NO-CODE)$/);
    } finally {
      await locker.query('ROLLBACK');
      await locker.end();
      await victim.end().catch(() => undefined);
    }
    // Everything the call did rolled back: still CREATING, no registry row, no schema, no stray lock.
    expect(await state(ws)).toMatchObject({ schema_status: 'CREATING', registry: null, schemas: 0 });
    expect(await provision(ws)).toBe('READY');
  });

  it('temp-object shadowing by the caller has no effect (pinned search_path; everything schema-qualified)', async () => {
    const ws = await seed('shadow');
    const c = await app();
    try {
      const tempAllowed = (await codeOf(c.query(`CREATE TEMP TABLE manager_workspace(id uuid, organisation_id uuid, owner_user_id uuid, schema_status text, status text)`))) === 'ACCEPTED';
      expect(tempAllowed).toBe(true); // crewflow_app has TEMP (PostgreSQL default), so the shadowing attempt is real
      if (tempAllowed) {
        await c.query(`CREATE TEMP TABLE workspace_schema_registry(workspace_id uuid, status text)`);
        await c.query(`CREATE TEMP TABLE shift(id uuid)`);
      }
      expect(await provision(ws, undefined, c)).toBe('READY');
    } finally {
      await c.end();
    }
    expect(await state(ws)).toMatchObject({ schema_status: 'READY', registry: 'READY' });
  });

  // ---------------------------------------------------------------------------------------------- verification catches tampering

  /** Runs `action` (as the DDL's own role, inside the provisioning transaction) right after the LAST workspace CHECK is bound. */
  const tamperAfterBind = async (ws: Ws, action: string, fn: () => Promise<void>) => {
    await admin.query(`
      CREATE OR REPLACE FUNCTION public.spp_tamper() RETURNS event_trigger LANGUAGE plpgsql AS $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF r.command_tag = 'ALTER TABLE' AND r.object_identity = '${ws.schema}.payslip_document'
             AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payslip_document_workspace_bound' AND connamespace = '${ws.schema}'::regnamespace) THEN
            ${action};
          END IF;
        END LOOP;
      END $$`);
    await admin.query(`CREATE EVENT TRIGGER spp_tamper ON ddl_command_end WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION public.spp_tamper()`);
    try {
      await fn();
    } finally {
      await admin.query(`DROP EVENT TRIGGER IF EXISTS spp_tamper`);
      await admin.query(`DROP FUNCTION IF EXISTS public.spp_tamper()`);
    }
  };

  it.each([
    ['a missing RLS policy', (s: string) => `DROP POLICY staff_profile_shift_team_select ON ${s}.staff_profile`, 'verification failed: policy count'],
    ['an incomplete schema (a table missing)', (s: string) => `DROP TABLE ${s}.payslip_document`, 'verification failed: table count'],
    ['FORCE RLS removed from a table', (s: string) => `ALTER TABLE ${s}.shift NO FORCE ROW LEVEL SECURITY`, 'verification failed: FORCE RLS'],
  ])('in-transaction verification detects %s: nothing is marked READY, everything rolls back, FAILED records the fixed label', async (_label, sql, expected) => {
    const ws = await seed(`tamper-${Math.random().toString(36).slice(2, 6)}`);
    await tamperAfterBind(ws, `EXECUTE ${"'"}${sql(ws.schema).replace(/'/g, "''")}${"'"}`, async () => {
      expect(await provision(ws)).toBe('FAILED');
    });
    expect(await state(ws)).toMatchObject({ schema_status: 'FAILED', registry: 'FAILED', relations: 0, schema_last_error: expected });
    expect(await provision(ws)).toBe('READY');
  });

  it.each([
    ['a dropped policy', (s: string) => `DROP POLICY staff_profile_shift_team_select ON ${s}.staff_profile`, 'policy count'],
    ['a dropped table', (s: string) => `DROP TABLE ${s}.payslip_document`, 'table count'],
    ['FORCE RLS removed', (s: string) => `ALTER TABLE ${s}.shift NO FORCE ROW LEVEL SECURITY`, 'FORCE RLS'],
  ])('a READY workspace with %s is reported (CWV02), never re-provisioned or re-marked', async (_label, sql, label) => {
    const ws = await seed(`drift-${Math.random().toString(36).slice(2, 6)}`);
    expect(await provision(ws)).toBe('READY');
    await admin.query(sql(ws.schema));
    const before = await state(ws);
    const err = await provision(ws).then(() => null, (e) => e as { code?: string; message?: string });
    expect(err?.code).toBe('CWV02');
    expect(err?.message).toContain(label);
    expect(await state(ws)).toEqual(before);
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('SET ROLE crewflow');
      expect((await c.query('SELECT core.verify_workspace_schema_v1($1) AS v', [ws.id])).rows[0].v).toBe(label);
    } finally {
      await c.end();
    }
  });

  // ---------------------------------------------------------------------------------------------- template parity

  it('§12.15 the server path builds exactly what the legacy TypeScript provisioner (as crewflow) builds: every object, policy, grant and owner', async () => {
    legacy = await seed('legacy');
    const crewflow = new Client({ connectionString: adminUrl });
    await crewflow.connect();
    try {
      await crewflow.query('SET ROLE crewflow');
      const result = await provisionWorkspaceSchema(crewflow, legacy.id);
      expect(result.outcome).toBe('READY');
    } finally {
      await crewflow.end();
    }
    const serverSide = await catalog(ready);
    const legacySide = await catalog(legacy);
    expect(serverSide.length).toBeGreaterThan(500);
    expect(serverSide).toEqual(legacySide);
  });

  it('§12.16 provisioning another workspace leaves an existing workspace byte-for-byte unchanged', async () => {
    const before = await catalog(legacy);
    const beforeState = await state(legacy);
    const another = await seed('another');
    expect(await provision(another)).toBe('READY');
    expect(await catalog(legacy)).toEqual(before);
    expect(await state(legacy)).toEqual(beforeState);
  });
});
