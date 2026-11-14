/**
 * B2 tests (OWNER-DB-ULTIMATE.md Part B1/B2; UPGRADE-LEDGER-INTERFACE.md §1): the table `core.upgrade_migration` on the real
 * disposable test database the owner-login install built (twenty-mode-check.ts ci-db). SQL only: nothing here imports B1's
 * TypeScript, only its migration has to be on the branch (LEDGER_MIGRATION_ON_BRANCH).
 *
 *   LS-1  Twenty's columns (snake_case) + forced; status only completed | failed (no started); the CHECKs (bad name, bad
 *         version, a message on a completed row, an is_initial row with attempt <> 1 or forced, a message over 4000);
 *         error_message stored as-is.
 *   LS-2  the four interface indexes (two partial uniques as Twenty, two workspace indexes); duplicates -> 23505.
 *   LS-3  workspace_id -> core.manager_workspace ON DELETE CASCADE; an unknown workspace -> 23503.
 *   LR-1  ENABLE + FORCE row-level security.
 *   LR-2  ordinary request handlers (no rab.upgrade_scope): 0 rows, INSERT 42501, no UPDATE/DELETE/TRUNCATE; the schema
 *         roles crewflow / crewflow_app / crewflow_worker: 42501. Rows unchanged afterwards.
 *   LR-3  the scopes, adversarially: `upgrade` reads all and inserts ONLY with no tenant bound AND the migration lock held
 *         by this backend; `status` reads only; `workspace_init` inserts only is_initial rows of a workspace of the bound
 *         organisation; unknown / mis-cased values, session-level values carried into a request, a tenant-bound `upgrade`
 *         or `status`: nothing.
 *   LR-4  no tenant context, no scope: zero rows while committed rows exist (CLAUDE.md testing floor).
 *   LR-5  tools/check-rls-coverage.ts stays green as crewflow_owner.
 *   LD-1  deleting a workspace removes exactly its rows (the FK cascade).
 *   LD-2  nothing else updates / deletes / truncates: not even the `upgrade` scope holding the lock.
 *
 * Fixtures: two synthetic organisations, each with a CEO and a manager workspace, COMMITTED by the cluster superuser
 * (TEST_DATABASE_URL_UNPOOLED, fixtures only) with workspace-bound ledger rows, so the cascade cleans them up; instance rows
 * are only ever written inside rolled-back transactions. Owner checks run over the runtime login's own connection
 * (TEST_DATABASE_URL, crewflow_owner). No URL or password is ever printed.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import {
  ERROR_MESSAGE_MAX,
  EXPECTED_COLUMNS,
  EXPECTED_WORKSPACE_TABLE,
  INDEXES,
  LEDGER_MIGRATION_ON_BRANCH,
  loginOf,
  MIGRATION_LOCK_KEY_SQL,
  OPTIONAL_COLUMNS,
  REFUSED_STATUSES,
  REPO_ROOT,
  setScope,
  STATUSES,
} from './ledger-contract';

jest.setTimeout(300_000);

const env = resolveIntegrationTestDatabase(process.env);
const OWNER_URL = env.appUrl;
const ADMIN_URL = env.adminUrl;
const RUN = LEDGER_MIGRATION_ON_BRANCH && loginOf(OWNER_URL) === 'crewflow_owner';
const describeIfLedger = RUN ? describe : describe.skip;

const RUN_ID = randomBytes(4).toString('hex');
const VERSION = '0.6.0';
/** Interface §1 name shape `<version>_<Step>_<13-digit ts>`. */
const STEP = (i: number) => `${VERSION}_B2LedgerTestStep${i}_1786799999${String(i).padStart(3, '0')}`;

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url, application_name: 'b2-ledger-table-spec' });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const asAdmin = <T>(fn: (c: Client) => Promise<T>) => withClient(ADMIN_URL, fn);
const asOwner = <T>(fn: (c: Client) => Promise<T>) => withClient(OWNER_URL, fn);

async function rolledBack<T>(c: Client, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    return await fn();
  } finally {
    await c.query('ROLLBACK');
  }
}

/** `sql` inside a savepoint: the SQLSTATE it failed with (null = succeeded) and the row count / rows. */
async function attempt(c: Client, sql: string, params: unknown[] = []): Promise<{ code: string | null; rowCount: number; rows: Record<string, unknown>[] }> {
  await c.query('SAVEPOINT b2_try');
  try {
    const r = await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT b2_try');
    return { code: null, rowCount: r.rowCount ?? 0, rows: r.rows };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT b2_try');
    return { code: (e as { code?: string }).code ?? 'unknown', rowCount: 0, rows: [] };
  }
}
/**
 * A DELETE by crewflow_owner deletes nothing: refused (no privilege) or 0 rows (the owner role keeps DELETE so the FK cascade
 * can run as the table owner, but no RLS policy admits a DELETE, so a non-owner session matches no row).
 */
const deletesNothing = (r: { code: string | null; rowCount: number }) => r.code !== null || r.rowCount === 0;
const count = async (c: Client, where = '', params: unknown[] = []) => {
  const r = await attempt(c, `SELECT count(*)::int AS n FROM core.upgrade_migration ${where}`, params);
  return r.code ? r.code : (r.rows[0]!.n as number);
};

const INSERT_SQL =
  'INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, error_message, is_initial, workspace_id, forced) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
const ins = (name: string, status: string, attempt_: number, opts: { msg?: string | null; initial?: boolean; ws?: string | null; forced?: boolean; version?: string } = {}) => [
  name,
  status,
  attempt_,
  opts.version ?? VERSION,
  opts.msg ?? null,
  opts.initial ?? false,
  opts.ws ?? null,
  opts.forced ?? false,
];

/** TenantContextService's request binding (tenant-context.service.ts), transaction-local. */
const REQUEST_CONTEXT_SQL =
  "SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', 'ceo', true), set_config('rab.actor_type', 'user', true)";
const TAKE_LOCK_SQL = `SELECT pg_try_advisory_xact_lock(${MIGRATION_LOCK_KEY_SQL}) AS ok`;

interface Fixture {
  org: string;
  user: string;
  workspace: string;
}

describeIfLedger('core.upgrade_migration: the table, the scopes and the delete path (Part B1/B2)', () => {
  const fixtures: Fixture[] = [];

  async function createWorkspace(tag: string): Promise<Fixture> {
    return asAdmin(async (c) => {
      const slug = `b2-ledger-${RUN_ID}-${tag}`;
      const org = (await c.query<{ id: string }>('INSERT INTO core.organisation (name, slug) VALUES ($1, $2) RETURNING id::text', [`B2 ledger ${tag}`, slug])).rows[0]!.id;
      const user = (
        await c.query<{ id: string }>(
          "INSERT INTO core.\"user\" (organisation_id, email, password_hash, first_name, last_name, status) VALUES ($1, $2, '$argon2id$v=19$m=19456,t=2,p=1$YjJsZWRnZXJzYWx0MDAwMA$YjItbGVkZ2VyLW5vdC1hLXJlYWwtaGFzaC0wMDAwMDAw', 'B2', 'Ledger', 'active') RETURNING id::text",
          [org, `ceo-${slug}@b2-ledger.invalid`],
        )
      ).rows[0]!.id;
      const workspace = (
        await c.query<{ id: string }>("INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id::text", [
          org,
          user,
          `B2 ledger ${tag}`,
          slug,
        ])
      ).rows[0]!.id;
      const f = { org, user, workspace };
      fixtures.push(f);
      return f;
    });
  }

  const rowsOf = (workspace: string) =>
    asAdmin(async (c) => (await c.query('SELECT id::text, name, status, attempt, executed_by_version, error_message, is_initial, forced FROM core.upgrade_migration WHERE workspace_id = $1 ORDER BY name, attempt', [workspace])).rows);
  const snapshot = async () => [await rowsOf(A.workspace), await rowsOf(B.workspace)];

  let A: Fixture;
  let B: Fixture;

  beforeAll(async () => {
    const exists = await asAdmin(async (c) => (await c.query<{ ok: boolean }>("SELECT to_regclass('core.upgrade_migration') IS NOT NULL AS ok")).rows[0]!.ok);
    // Fail loudly: on a branch that carries the migration, a missing table is a broken install, not a reason to skip.
    if (!exists) throw new Error('core.upgrade_migration does not exist on the test database (the ledger migration did not run)');
    A = await createWorkspace('a');
    B = await createWorkspace('b');
    await asAdmin(async (c) => {
      for (const f of [A, B]) {
        await c.query(INSERT_SQL, ins(STEP(1), 'completed', 1, { initial: true, ws: f.workspace }));
        await c.query(INSERT_SQL, ins(STEP(2), 'failed', 1, { msg: 'B2 fixture failure', ws: f.workspace }));
        await c.query(INSERT_SQL, ins(STEP(2), 'completed', 2, { ws: f.workspace }));
      }
    });
  });

  afterAll(async () => {
    // The cascade is the only delete path: removing the organisations removes their workspaces and so their ledger rows.
    await asAdmin(async (c) => {
      for (const f of fixtures) await c.query('DELETE FROM core.organisation WHERE id = $1', [f.org]).catch(() => undefined);
    });
  });

  // ------------------------------------------------------------------------------------------------------------ LS-1
  it("LS-1 has exactly Twenty's columns (snake_case) plus forced, with the reviewed types, nullability and defaults", async () => {
    const cols = await asAdmin(
      async (c) =>
        (
          await c.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
            "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'core' AND table_name = 'upgrade_migration' ORDER BY ordinal_position",
          )
        ).rows,
    );
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    const problems: string[] = [];
    for (const [name, want] of Object.entries(EXPECTED_COLUMNS)) {
      const got = byName.get(name);
      if (!got) {
        problems.push(`${name}: missing`);
        continue;
      }
      if (got.data_type !== want.type) problems.push(`${name}: type ${got.data_type}, want ${want.type}`);
      if ((got.is_nullable === 'YES') !== want.nullable) problems.push(`${name}: nullable=${got.is_nullable}, want ${want.nullable ? 'YES' : 'NO'}`);
      if (want.defaultLike && !want.defaultLike.test(got.column_default ?? '')) problems.push(`${name}: default ${got.column_default ?? 'none'}, want ${want.defaultLike}`);
    }
    const extra = cols.map((c) => c.column_name).filter((n) => !(n in EXPECTED_COLUMNS) && !OPTIONAL_COLUMNS.has(n));
    if (extra.length) problems.push(`unexpected columns (Part B1: drop error_class unless the status read needs it): ${extra.join(', ')}`);
    expect(problems).toEqual([]);
  });

  it('LS-1 status admits only completed | failed (no started: a crash leaves no row)', async () => {
    await asAdmin((c) =>
      rolledBack(c, async () => {
        for (const s of STATUSES) expect([s, (await attempt(c, INSERT_SQL, ins(STEP(10), s, s === 'failed' ? 1 : 2, { msg: s === 'failed' ? 'x' : null }))).code]).toEqual([s, null]);
        for (const s of REFUSED_STATUSES) expect([s, (await attempt(c, INSERT_SQL, ins(STEP(11), s, 1))).code]).toEqual([s, '23514']);
        expect((await attempt(c, INSERT_SQL, ins(STEP(12), null as unknown as string, 1))).code).toBe('23502');
      }),
    );
  });

  it('LS-1 the CHECKs: a bad name or version, a message on a completed row, an is_initial row with attempt <> 1 or forced, attempt < 1', async () => {
    await asAdmin((c) =>
      rolledBack(c, async () => {
        const cases: [string, unknown[]][] = [
          ['name without a version', ins('TypeOrmMigrations', 'completed', 1)],
          ['name with free text', ins(`${VERSION}_drop table x; --`, 'completed', 1)],
          ['version with a leading zero', ins(STEP(13), 'completed', 1, { version: '0.06.0' })],
          ['version not M.m.p', ins(STEP(13), 'completed', 1, { version: 'v0.6' })],
          ['a message on a completed row', ins(STEP(14), 'completed', 1, { msg: 'should not be here' })],
          ['is_initial with attempt 2', ins(STEP(15), 'completed', 2, { initial: true })],
          ['is_initial and forced', ins(STEP(16), 'completed', 1, { initial: true, forced: true })],
          ['attempt 0', ins(STEP(17), 'completed', 0)],
          [`a message over ${ERROR_MESSAGE_MAX}`, ins(STEP(18), 'failed', 1, { msg: 'e'.repeat(ERROR_MESSAGE_MAX + 1) })],
        ];
        for (const [what, params] of cases) expect([what, (await attempt(c, INSERT_SQL, params)).code]).toEqual([what, '23514']);
        expect((await attempt(c, INSERT_SQL, ins(STEP(19), 'failed', 1, { msg: 'e'.repeat(ERROR_MESSAGE_MAX) }))).code).toBeNull();
      }),
    );
  });

  it('LS-1 error_message is stored as-is (no rewriting by the database)', async () => {
    const message = 'relation "core.x" does not exist; detail: ünïcødé\nsecond line\ttab';
    await asAdmin((c) =>
      rolledBack(c, async () => {
        const id = randomUUID();
        await c.query(
          'INSERT INTO core.upgrade_migration (id, name, status, attempt, executed_by_version, error_message, is_initial, workspace_id, forced) VALUES ($1, $2, $3, 1, $4, $5, false, NULL, false)',
          [id, STEP(20), 'failed', VERSION, message],
        );
        expect((await c.query<{ m: string }>('SELECT error_message AS m FROM core.upgrade_migration WHERE id = $1', [id])).rows[0]!.m).toBe(message);
      }),
    );
  });

  // ------------------------------------------------------------------------------------------------------------ LS-2
  it("LS-2 has Twenty's two partial unique indexes and the two workspace indexes (interface names)", async () => {
    const idx = await asAdmin(
      async (c) =>
        (
          await c.query<{ name: string; def: string; uniq: boolean; pred: string | null }>(
            `SELECT i.relname AS name, pg_get_indexdef(x.indexrelid) AS def, x.indisunique AS uniq, pg_get_expr(x.indpred, x.indrelid) AS pred
               FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
              WHERE x.indrelid = 'core.upgrade_migration'::regclass AND NOT x.indisprimary`,
          )
        ).rows,
    );
    const by = new Map(idx.map((i) => [i.name, i]));
    const keyCols = (def: string) => (/\(([^)]*)\)/.exec(def)?.[1] ?? '').split(',').map((s) => s.trim().replace(/"/g, ''));
    const inst = by.get(INDEXES.instanceUq);
    const ws = by.get(INDEXES.workspaceUq);
    expect({ uniq: inst?.uniq, cols: inst && keyCols(inst.def).sort(), pred: inst?.pred }).toEqual({ uniq: true, cols: ['attempt', 'name'], pred: '(workspace_id IS NULL)' });
    expect({ uniq: ws?.uniq, cols: ws && keyCols(ws.def).sort(), pred: ws?.pred }).toEqual({ uniq: true, cols: ['attempt', 'name', 'workspace_id'], pred: '(workspace_id IS NOT NULL)' });
    expect(by.has(INDEXES.workspaceNameAttempt) && by.has(INDEXES.workspaceCreatedAt)).toBe(true);
    // The cascade (DELETE ... WHERE workspace_id = $1) needs an index that leads with workspace_id.
    expect(idx.some((i) => keyCols(i.def)[0] === 'workspace_id')).toBe(true);
  });

  it('LS-2 a duplicate (name, attempt) is refused per instance and per workspace; instance and workspace rows do not collide', async () => {
    await asAdmin((c) =>
      rolledBack(c, async () => {
        expect((await attempt(c, INSERT_SQL, ins(STEP(30), 'failed', 1, { msg: 'x' }))).code).toBeNull();
        expect((await attempt(c, INSERT_SQL, ins(STEP(30), 'completed', 1))).code).toBe('23505');
        expect((await attempt(c, INSERT_SQL, ins(STEP(30), 'completed', 2))).code).toBeNull();
        expect((await attempt(c, INSERT_SQL, ins(STEP(30), 'failed', 1, { msg: 'x', ws: A.workspace }))).code).toBeNull();
        expect((await attempt(c, INSERT_SQL, ins(STEP(30), 'completed', 1, { ws: A.workspace }))).code).toBe('23505');
        expect((await attempt(c, INSERT_SQL, ins(STEP(30), 'failed', 1, { msg: 'x', ws: B.workspace }))).code).toBeNull();
      }),
    );
  });

  // ------------------------------------------------------------------------------------------------------------ LS-3
  it('LS-3 workspace_id references core.manager_workspace ON DELETE CASCADE (like Twenty); an unknown workspace -> 23503', async () => {
    const fk = await asAdmin(
      async (c) =>
        (
          await c.query<{ ref: string; del: string; cols: string }>(
            `SELECT confrelid::regclass::text AS ref, confdeltype AS del,
                    (SELECT string_agg(a.attname, ',') FROM pg_attribute a WHERE a.attrelid = conrelid AND a.attnum = ANY (conkey)) AS cols
               FROM pg_constraint WHERE conrelid = 'core.upgrade_migration'::regclass AND contype = 'f'`,
          )
        ).rows,
    );
    expect(fk).toEqual([{ ref: EXPECTED_WORKSPACE_TABLE, del: 'c', cols: 'workspace_id' }]);
    await asAdmin((c) => rolledBack(c, async () => expect((await attempt(c, INSERT_SQL, ins(STEP(31), 'completed', 1, { initial: true, ws: randomUUID() }))).code).toBe('23503')));
  });

  // ------------------------------------------------------------------------------------------------------- LR-1..LR-4
  it('LR-1 row-level security is ENABLED and FORCED', async () => {
    const r = await asAdmin(async (c) => (await c.query("SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'core.upgrade_migration'::regclass")).rows[0]);
    expect(r).toEqual({ enabled: true, forced: true });
  });

  it('LR-4 no tenant context and no scope: zero rows (while committed rows exist)', async () => {
    expect(await asAdmin((c) => rolledBack(c, () => count(c, 'WHERE workspace_id = ANY ($1::uuid[])', [[A.workspace, B.workspace]])))).toBe(6);
    expect(await asOwner((c) => rolledBack(c, () => count(c)))).toBe(0);
  });

  it('LR-2 an ordinary request handler (crewflow_owner + a full request context, no scope) can neither read nor write it', async () => {
    const before = await snapshot();
    await asOwner((c) =>
      rolledBack(c, async () => {
        await c.query(REQUEST_CONTEXT_SQL, [A.org, A.workspace, A.user]);
        expect(await count(c)).toBe(0);
        expect((await attempt(c, INSERT_SQL, ins(STEP(40), 'completed', 1, { initial: true, ws: A.workspace }))).code).toBe('42501');
        expect((await attempt(c, INSERT_SQL, ins(STEP(41), 'completed', 1))).code).toBe('42501');
        expect((await attempt(c, "UPDATE core.upgrade_migration SET status = 'completed', forced = true")).code).toBe('42501');
        expect(deletesNothing(await attempt(c, 'DELETE FROM core.upgrade_migration'))).toBe(true);
        expect((await attempt(c, 'TRUNCATE core.upgrade_migration')).code).toBe('42501');
      }),
    );
    expect(await snapshot()).toEqual(before);
  });

  it('LR-2 the schema roles (crewflow, crewflow_app, crewflow_worker) get 42501, read or write, with any scope', async () => {
    const before = await snapshot();
    const roles = await asAdmin(async (c) => (await c.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname IN ('crewflow', 'crewflow_app', 'crewflow_worker') ORDER BY 1")).rows.map((r) => r.rolname));
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      for (const scope of ['', 'upgrade', 'status', 'workspace_init']) {
        await asAdmin((c) =>
          rolledBack(c, async () => {
            // sql-injection-reviewed: role is one of three code-constant role names read back from pg_roles above
            await c.query(`SET LOCAL ROLE ${role}`);
            await setScope(c, scope);
            const tag = `${role}/${scope || 'unset'}`;
            expect([tag, (await attempt(c, 'SELECT count(*) FROM core.upgrade_migration')).code]).toEqual([tag, '42501']);
            expect([tag, (await attempt(c, INSERT_SQL, ins(STEP(50), 'completed', 1))).code]).toEqual([tag, '42501']);
            expect([tag, (await attempt(c, "UPDATE core.upgrade_migration SET status = 'completed'")).code]).toEqual([tag, '42501']);
            expect([tag, (await attempt(c, 'DELETE FROM core.upgrade_migration')).code]).toEqual([tag, '42501']);
            expect([tag, (await attempt(c, 'TRUNCATE core.upgrade_migration')).code]).toEqual([tag, '42501']);
          }),
        );
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  // ------------------------------------------------------------------------------------------------------------ LR-3
  describe('LR-3 the rab.upgrade_scope access rules, adversarially', () => {
    it('upgrade, no tenant, lock held: reads every row and inserts an instance row', async () => {
      await asOwner((c) =>
        rolledBack(c, async () => {
          await setScope(c, 'upgrade');
          expect((await c.query(TAKE_LOCK_SQL)).rows[0].ok).toBe(true);
          expect(await count(c, 'WHERE workspace_id = ANY ($1::uuid[])', [[A.workspace, B.workspace]])).toBe(6);
          expect((await attempt(c, INSERT_SQL, ins(STEP(60), 'completed', 1))).code).toBeNull();
        }),
      );
    });

    it('upgrade WITHOUT the migration lock (or with another key) cannot insert: 42501', async () => {
      await asOwner((c) =>
        rolledBack(c, async () => {
          await setScope(c, 'upgrade');
          expect((await attempt(c, INSERT_SQL, ins(STEP(61), 'completed', 1))).code).toBe('42501');
          // The same numbers as a two-int key, and a neighbouring bigint: not the migration lock.
          await c.query('SELECT pg_advisory_xact_lock(1668441463, 1835624306)');
          await c.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY_SQL} + 1)`);
          expect((await attempt(c, INSERT_SQL, ins(STEP(61), 'completed', 1))).code).toBe('42501');
        }),
      );
    });

    it('upgrade or status with a tenant bound (a request handler setting the scope) reads 0 rows and cannot insert', async () => {
      for (const scope of ['upgrade', 'status']) {
        await asOwner((c) =>
          rolledBack(c, async () => {
            await c.query(REQUEST_CONTEXT_SQL, [A.org, A.workspace, A.user]);
            await setScope(c, scope);
            await c.query(TAKE_LOCK_SQL);
            expect([scope, await count(c)]).toEqual([scope, 0]);
            expect([scope, (await attempt(c, INSERT_SQL, ins(STEP(62), 'completed', 1))).code]).toEqual([scope, '42501']);
          }),
        );
      }
    });

    it('status: reads, never writes (insert / update / delete 42501), even holding the lock', async () => {
      await asOwner((c) =>
        rolledBack(c, async () => {
          await setScope(c, 'status');
          await c.query(TAKE_LOCK_SQL);
          expect(await count(c, 'WHERE workspace_id = ANY ($1::uuid[])', [[A.workspace, B.workspace]])).toBe(6);
          expect((await attempt(c, INSERT_SQL, ins(STEP(63), 'completed', 1))).code).toBe('42501');
          expect((await attempt(c, INSERT_SQL, ins(STEP(63), 'completed', 1, { initial: true, ws: A.workspace }))).code).toBe('42501');
          expect((await attempt(c, "UPDATE core.upgrade_migration SET forced = true")).code).toBe('42501');
          expect(deletesNothing(await attempt(c, 'DELETE FROM core.upgrade_migration'))).toBe(true);
        }),
      );
    });

    it("workspace_init: only is_initial rows of a workspace of the bound organisation; another organisation's -> 42501", async () => {
      const W = await createWorkspace('init');
      const other = await createWorkspace('initother');
      await asOwner((c) =>
        rolledBack(c, async () => {
          await c.query(REQUEST_CONTEXT_SQL, [W.org, W.workspace, W.user]);
          await setScope(c, 'workspace_init');
          expect((await attempt(c, INSERT_SQL, ins(STEP(70), 'completed', 1, { initial: true, ws: other.workspace }))).code).toBe('42501');
          expect((await attempt(c, INSERT_SQL, ins(STEP(70), 'completed', 1, { initial: false, ws: W.workspace }))).code).toBe('42501');
          expect((await attempt(c, INSERT_SQL, ins(STEP(70), 'completed', 1, { initial: true, ws: null }))).code).toBe('42501');
          expect((await attempt(c, INSERT_SQL, ins(STEP(70), 'completed', 1, { initial: true, ws: W.workspace }))).code).toBeNull();
          // It reads its own workspace's rows only: never A's / B's, never instance rows.
          expect(await count(c, 'WHERE workspace_id <> $1 OR workspace_id IS NULL', [W.workspace])).toBe(0);
          expect((await attempt(c, "UPDATE core.upgrade_migration SET forced = true WHERE workspace_id = $1", [W.workspace])).code).toBe('42501');
          expect(deletesNothing(await attempt(c, 'DELETE FROM core.upgrade_migration WHERE workspace_id = $1', [W.workspace]))).toBe(true);
        }),
      );
      // workspace_init with NO organisation bound: nothing.
      await asOwner((c) =>
        rolledBack(c, async () => {
          await setScope(c, 'workspace_init');
          expect(await count(c)).toBe(0);
          expect((await attempt(c, INSERT_SQL, ins(STEP(71), 'completed', 1, { initial: true, ws: W.workspace }))).code).toBe('42501');
        }),
      );
    });

    it('unknown, mis-cased or padded scope values grant nothing', async () => {
      for (const scope of ['UPGRADE', 'upgrade ', ' upgrade', 'upgrade,status', 'admin', 'all', '*', 'true', 'on', "upgrade'--"]) {
        await asOwner((c) =>
          rolledBack(c, async () => {
            await setScope(c, scope);
            await c.query(TAKE_LOCK_SQL);
            expect([scope, await count(c)]).toEqual([scope, 0]);
            expect([scope, (await attempt(c, INSERT_SQL, ins(STEP(72), 'completed', 1))).code]).toEqual([scope, '42501']);
          }),
        );
      }
    });

    it('a scope leaked at SESSION level onto a pooled connection gives the next request (tenant bound) nothing', async () => {
      await asOwner(async (c) => {
        // A buggy caller using set_config(..., false): the value outlives its transaction on this connection.
        await c.query('SELECT set_config($1, $2, false)', ['rab.upgrade_scope', 'upgrade']);
        await c.query(TAKE_LOCK_SQL.replace('_xact', ''));
        const seen = await rolledBack(c, async () => {
          await c.query(REQUEST_CONTEXT_SQL, [A.org, A.workspace, A.user]);
          return { n: await count(c), insert: (await attempt(c, INSERT_SQL, ins(STEP(73), 'completed', 1))).code };
        });
        await c.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY_SQL})`);
        expect(seen).toEqual({ n: 0, insert: '42501' });
      });
    });
  });

  // ------------------------------------------------------------------------------------------------------------ LD-2
  it('LD-2 not even the upgrade scope holding the lock can UPDATE, DELETE or TRUNCATE (the cascade is the only delete)', async () => {
    const before = await snapshot();
    await asOwner((c) =>
      rolledBack(c, async () => {
        await setScope(c, 'upgrade');
        expect((await c.query(TAKE_LOCK_SQL)).rows[0].ok).toBe(true);
        expect((await attempt(c, "UPDATE core.upgrade_migration SET status = 'completed', forced = true WHERE workspace_id = $1", [A.workspace])).code).toBe('42501');
        expect(deletesNothing(await attempt(c, 'DELETE FROM core.upgrade_migration WHERE workspace_id = $1', [A.workspace]))).toBe(true);
        expect((await attempt(c, 'TRUNCATE core.upgrade_migration')).code).toBe('42501');
      }),
    );
    expect(await snapshot()).toEqual(before);
  });

  it('LD-2 (owner-required) a direct DELETE as crewflow_owner, and after SET ROLE rab_secure_owner, removes 0 rows', async () => {
    const before = await snapshot();
    const total = async () => asAdmin(async (c) => Number((await c.query('SELECT count(*) FROM core.upgrade_migration')).rows[0]!.count));
    const n0 = await total();
    for (const [label, setup] of [
      ['crewflow_owner, no scope', [] as string[]],
      ['crewflow_owner, upgrade scope + lock', ["SELECT set_config('rab.upgrade_scope', 'upgrade', true)", TAKE_LOCK_SQL]],
      ['SET ROLE rab_secure_owner', ['SET LOCAL ROLE rab_secure_owner']],
      ['SET ROLE rab_secure_owner + upgrade scope + lock', ['SET LOCAL ROLE rab_secure_owner', "SELECT set_config('rab.upgrade_scope', 'upgrade', true)", TAKE_LOCK_SQL]],
    ] as const) {
      // COMMITTED, not rolled back: a delete that "worked" must show in the table afterwards.
      const r = await asOwner(async (c) => {
        await c.query('BEGIN');
        try {
          for (const sql of setup) await c.query(sql);
          const all = await attempt(c, 'DELETE FROM core.upgrade_migration');
          const one = await attempt(c, 'DELETE FROM core.upgrade_migration WHERE workspace_id = $1', [A.workspace]);
          await c.query('COMMIT');
          return { all, one };
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        }
      });
      expect([label, deletesNothing(r.all), deletesNothing(r.one)]).toEqual([label, true, true]);
      expect([label, await total()]).toEqual([label, n0]);
    }
    expect(await snapshot()).toEqual(before);
  });

  // ------------------------------------------------------------------------------------------------------------ LR-5
  it('LR-5 the RLS coverage gate (tools/check-rls-coverage.ts) passes as crewflow_owner with the ledger present', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(REPO_ROOT, 'tools', 'check-rls-coverage.ts')], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SystemRoot: process.env.SystemRoot ?? '', NODE_ENV: 'test', PG_DATABASE_URL: OWNER_URL },
      encoding: 'utf8',
      timeout: 240_000,
    });
    if (r.status !== 0) {
      const tail = `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => !/:\/\//.test(l)).slice(-15).join('\n');
      throw new Error(`check-rls-coverage exited ${r.status}:\n${tail}`);
    }
    expect(r.status).toBe(0);
  });

  // ------------------------------------------------------------------------------------------------------------ LD-1
  it('LD-1 deleting a workspace removes exactly its ledger rows (FK cascade); the other workspace and instance rows stay', async () => {
    const [a0, b0] = await snapshot();
    expect([a0!.length, b0!.length]).toEqual([3, 3]);
    const instanceBefore = await asAdmin(async (c) => (await c.query('SELECT id::text FROM core.upgrade_migration WHERE workspace_id IS NULL ORDER BY id')).rows);
    await asAdmin((c) => c.query('DELETE FROM core.manager_workspace WHERE id = $1', [A.workspace]));
    expect(await rowsOf(A.workspace)).toEqual([]);
    expect(await rowsOf(B.workspace)).toEqual(b0);
    expect(await asAdmin(async (c) => (await c.query('SELECT id::text FROM core.upgrade_migration WHERE workspace_id IS NULL ORDER BY id')).rows)).toEqual(instanceBefore);
  });
});
