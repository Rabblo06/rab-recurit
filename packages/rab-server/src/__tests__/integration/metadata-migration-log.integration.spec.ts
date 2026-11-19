/**
 * Metadata engine M2, phase 1 (docs/plans/phase-x4/M2-PLAN.md §10 S-1, PR-3; owner decisions 2026-11-18): the insert-only
 * runtime change log `core.metadata_migration` of MetadataMigrationLog1786721640000 on the real disposable test database
 * (migrations alone, owner-login bootstrap). Checks run over the runtime login's own connection (TEST_DATABASE_URL =
 * crewflow_owner, NOBYPASSRLS, bound by FORCE RLS); fixtures are committed by the cluster superuser
 * (TEST_DATABASE_ADMIN_URL) and removed with their organisations. Every mutation the runtime login attempts runs in a
 * transaction that is rolled back. No URL or password is ever printed.
 *
 *   ML-1   catalog: the migration's exact expected state (owner crewflow, ENABLE + FORCE, one tenant policy, crewflow_app
 *          SELECT + INSERT only, nothing for PUBLIC, the guard triggers, workspace CASCADE / actor SET NULL).
 *   ML-2   no tenant context bound → zero rows while rows exist (CLAUDE.md testing floor); an organisation alone → zero.
 *   ML-3   a workspace sees only its own log; a foreign organisation / workspace binding sees nothing; WITH CHECK and the
 *          guard refuse a row for another tenant.
 *   ML-4   the one legitimate write: a data-model change and its log row in one transaction, actor = the bound user,
 *          created_at = the insert time whatever the writer sends.
 *   ML-5   abuse: a row without a change in this transaction, a stale / skipped / repeated version, a forged or missing
 *          actor, an unknown change kind, malformed actions, a request id carrying control characters.
 *   ML-6   insert-only while the guard trigger is enabled: a plain UPDATE / DELETE refused for the runtime login AND the
 *          superuser (42501); TRUNCATE refused to the
 *          request path (also through TRUNCATE core.manager_workspace CASCADE), allowed to the superuser.
 *   ML-7   owner decision: deleting the actor user keeps the row and sets only actor_user_id to NULL.
 *   ML-8   owner decision: deleting a workspace deletes exactly its log rows.
 *   ML-9   down() refuses while a row exists (rolled back; FORCE stays on).
 *   ML-10  release-2 dependency: the 0 → 1 change of a workspace cannot be logged (E2 sync must seed version 1 first).
 *   ML-11  two concurrent changes of one workspace: serialised on the version row, consecutive versions, both logged.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import {
  METADATA_MIGRATION_STATE_SQL,
  metadataMigrationStateProblems,
} from '../../database/typeorm/core/metadata-migration-log-sql';
import { MetadataMigrationLog1786721640000 } from '../../database/typeorm/core/migrations/1786721640000-MetadataMigrationLog';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';

jest.setTimeout(300_000);

const MIGRATION_ON_BRANCH = existsSync(join(__dirname, '..', '..', 'database', 'typeorm', 'core', 'migrations', '1786721640000-MetadataMigrationLog.ts'));
const env = resolveIntegrationTestDatabase(process.env);
const OWNER_URL = env.appUrl;
const ADMIN_URL = env.adminUrl;
const loginOf = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return '';
  }
};
// With the migration on the branch, a runtime login other than crewflow_owner is a CI misconfiguration, never a skip.
if (MIGRATION_ON_BRANCH && loginOf(OWNER_URL) !== 'crewflow_owner') {
  throw new Error('metadata-migration-log spec: TEST_DATABASE_URL must be the runtime login crewflow_owner (MetadataMigrationLog1786721640000 is on this branch)');
}
const RUN = MIGRATION_ON_BRANCH;
const describeIfLog = RUN ? describe : describe.skip;
const RUN_ID = randomBytes(4).toString('hex');
const ARGON = '$argon2id$v=19$m=19456,t=2,p=1$bWwxc2FsdG1sMXNhbHQ$bWwtbm90LWEtcmVhbC1oYXNoLTAwMDAwMDAwMDAwMDAw';

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url, application_name: 'metadata-migration-log-spec' });
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

/** `sql` inside a savepoint: the SQLSTATE (null = succeeded) and the violated constraint. */
async function attempt(c: Client, sql: string, params: unknown[] = []): Promise<{ code: string | null; constraint: string | null; rowCount: number }> {
  await c.query('SAVEPOINT ml_try');
  try {
    const r = await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT ml_try');
    return { code: null, constraint: null, rowCount: r.rowCount ?? 0 };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT ml_try');
    const err = e as { code?: string; constraint?: string };
    return { code: err.code ?? 'unknown', constraint: err.constraint ?? null, rowCount: 0 };
  }
}

/** TenantContextService's request binding (tenant-context.service.ts bindGucsSql), transaction-local. */
const BIND_SQL =
  "SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', 'ceo', true), set_config('rab.actor_type', 'user', true)";

const LOG_COLUMNS = '(organisation_id, workspace_id, previous_version, metadata_version, change_kind, actions, actor_user_id, request_id, executor_version)';
const INSERT_LOG = `INSERT INTO core.metadata_migration ${LOG_COLUMNS} VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`;

interface Ws {
  tag: string;
  org: string;
  owner: string;
  workspace: string;
  object: string;
}

describeIfLog('metadata engine M2 phase 1: core.metadata_migration, insert-only, FORCE RLS (MetadataMigrationLog1786721640000)', () => {
  const orgs: string[] = [];
  let A1: Ws;
  let A2: Ws;
  let B1: Ws;
  let actor: string; // a second user of organisation A, deleted in ML-7

  async function createOrg(tag: string): Promise<string> {
    return asAdmin(async (c) => {
      const org = (await c.query<{ id: string }>('INSERT INTO core.organisation (name, slug) VALUES ($1, $2) RETURNING id::text', [`ML ${tag}`, `ml-${RUN_ID}-${tag}`])).rows[0]!.id;
      orgs.push(org);
      return org;
    });
  }

  async function createUser(org: string, tag: string): Promise<string> {
    return asAdmin(async (c) =>
      (
        await c.query<{ id: string }>(
          "INSERT INTO core.\"user\" (organisation_id, email, password_hash, first_name, last_name, status) VALUES ($1, $2, $3, 'ML', 'Log', 'active') RETURNING id::text",
          [org, `${tag}-ml-${RUN_ID}@ml.invalid`, ARGON],
        )
      ).rows[0]!.id,
    );
  }

  /** A workspace with one custom object (its insert creates the workspace's metadata version row at 1). */
  async function seedWorkspace(org: string, tag: string): Promise<Ws> {
    const owner = await createUser(org, `owner-${tag}`);
    return asAdmin(async (c) => {
      const workspace = (
        await c.query<{ id: string }>("INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id::text", [
          org,
          owner,
          `ML ${tag}`,
          `ml-${RUN_ID}-${tag}`,
        ])
      ).rows[0]!.id;
      const object = (
        await c.query<{ id: string }>(
          `INSERT INTO core.object_metadata (organisation_id, workspace_id, name_singular, name_plural, label_singular, label_plural, physical_table, is_custom, allows_custom_fields)
           VALUES ($1, $2, 'equipment', 'equipments', 'Equipment', 'Equipment', $3, true, true) RETURNING id::text`,
          [org, workspace, `c_${randomBytes(6).toString('hex')}`],
        )
      ).rows[0]!.id;
      return { tag, org, owner, workspace, object };
    });
  }

  /** A real data-model change in the CURRENT transaction (a custom label), so the M1 trigger bumps the version once. */
  async function change(c: Client, ws: Ws): Promise<{ previous: string; current: string }> {
    await c.query('UPDATE core.object_metadata SET label_singular = $1 WHERE id = $2', [`Equipment ${randomBytes(3).toString('hex')}`, ws.object]);
    const v = (await c.query<{ v: string }>('SELECT metadata_version::text AS v FROM core.workspace_metadata_state WHERE workspace_id = $1', [ws.workspace])).rows[0]!.v;
    return { previous: String(BigInt(v) - 1n), current: v };
  }

  const logParams = (ws: Ws, previous: string, current: string, over: Partial<Record<'kind' | 'actions' | 'actor' | 'request' | 'executor', unknown>> = {}) => [
    ws.org,
    ws.workspace,
    previous,
    current,
    'kind' in over ? over.kind : 'object.update',
    'actions' in over ? over.actions : JSON.stringify([{ action: 'rename_label', object_id: ws.object }]),
    'actor' in over ? over.actor : ws.owner,
    'request' in over ? over.request : `req-${RUN_ID}`,
    'executor' in over ? over.executor : 1,
  ];

  /** Commit one legitimate log row for `ws`, written by the superuser through the real binding (fixtures). */
  async function commitLogRow(ws: Ws, actorUser: string): Promise<void> {
    await asAdmin(async (c) => {
      await c.query('BEGIN');
      await c.query(BIND_SQL, [ws.org, ws.workspace, actorUser]);
      const v = await change(c, ws);
      await c.query(INSERT_LOG, logParams(ws, v.previous, v.current, { actor: actorUser }));
      await c.query('COMMIT');
    });
  }

  const countFor = (workspace: string) =>
    asAdmin(async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM core.metadata_migration WHERE workspace_id = $1', [workspace])).rows[0]!.n);

  /** As the runtime login, bound to (org, workspace, user), in a rolled-back transaction. */
  const bound = <T>(ws: Pick<Ws, 'org' | 'workspace'>, user: string, fn: (c: Client) => Promise<T>) =>
    asOwner((c) =>
      rolledBack(c, async () => {
        await c.query(BIND_SQL, [ws.org, ws.workspace, user]);
        return fn(c);
      }),
    );

  beforeAll(async () => {
    const exists = await asAdmin(async (c) => (await c.query<{ ok: boolean }>("SELECT to_regclass('core.metadata_migration') IS NOT NULL AS ok")).rows[0]!.ok);
    if (!exists) throw new Error('core.metadata_migration does not exist on the test database (MetadataMigrationLog1786721640000 did not run)');
    const orgA = await createOrg('a');
    const orgB = await createOrg('b');
    A1 = await seedWorkspace(orgA, 'a1');
    A2 = await seedWorkspace(orgA, 'a2');
    B1 = await seedWorkspace(orgB, 'b1');
    actor = await createUser(orgA, 'actor');
    await commitLogRow(A1, actor);
    await commitLogRow(A1, A1.owner);
    await commitLogRow(A2, A2.owner);
    await commitLogRow(B1, B1.owner);
  });

  afterAll(async () => {
    if (!RUN) return;
    await asAdmin(async (c) => {
      for (const org of orgs) await c.query('DELETE FROM core.organisation WHERE id = $1', [org]).catch(() => undefined);
    });
  });

  // ------------------------------------------------------------------------------------------------------------ ML-1
  it('ML-1 the runtime login is crewflow_owner without BYPASSRLS (the identity every check below runs as)', async () => {
    const row = await asOwner(async (c) => (await c.query(`SELECT current_user::text AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`)).rows[0]);
    expect(row).toEqual({ u: 'crewflow_owner', bypass: false });
  });

  it('ML-1 the catalog state is exactly the migration post-condition (owner, FORCE, policy, grants, triggers, FK actions, guard)', async () => {
    const state = await asAdmin(async (c) => (await c.query<Record<string, unknown>>(METADATA_MIGRATION_STATE_SQL)).rows[0]);
    expect(metadataMigrationStateProblems(state)).toEqual([]);
    const qual = await asAdmin(
      async (c) =>
        (await c.query<{ q: string }>("SELECT pg_get_expr(p.polqual, p.polrelid) AS q FROM pg_policy p WHERE p.polrelid = 'core.metadata_migration'::regclass")).rows.map((r) => r.q),
    );
    expect(qual).toEqual(['((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))']);
    const app = await asAdmin(
      async (c) =>
        (
          await c.query<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }>(
            `SELECT has_table_privilege('crewflow_app', 'core.metadata_migration', 'SELECT') AS s, has_table_privilege('crewflow_app', 'core.metadata_migration', 'INSERT') AS i,
                    has_table_privilege('crewflow_app', 'core.metadata_migration', 'UPDATE') AS u, has_table_privilege('crewflow_app', 'core.metadata_migration', 'DELETE') AS d,
                    has_table_privilege('crewflow_app', 'core.metadata_migration', 'TRUNCATE') AS t`,
          )
        ).rows[0],
    );
    expect(app).toEqual({ s: true, i: true, u: false, d: false, t: false });
  });

  // ------------------------------------------------------------------------------------------------------------ ML-2
  it('ML-2 no tenant context bound → zero rows, while rows exist (fail closed)', async () => {
    expect(await countFor(A1.workspace)).toBe(2);
    const seen = await asOwner(async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM core.metadata_migration')).rows[0]!.n);
    expect(seen).toBe(0);
    const orgOnly = await asOwner((c) =>
      rolledBack(c, async () => {
        await c.query("SELECT set_config('rab.organisation_id', $1, true)", [A1.org]);
        return (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM core.metadata_migration')).rows[0]!.n;
      }),
    );
    expect(orgOnly).toBe(0);
  });

  // ------------------------------------------------------------------------------------------------------------ ML-3
  it('ML-3 a workspace sees only its own log; a foreign organisation / workspace binding sees nothing', async () => {
    const seen = (ws: Pick<Ws, 'org' | 'workspace'>, user: string) =>
      bound(ws, user, async (c) => (await c.query<{ w: string }>('SELECT DISTINCT workspace_id::text AS w FROM core.metadata_migration')).rows.map((r) => r.w));
    expect(await seen(A1, A1.owner)).toEqual([A1.workspace]);
    expect(await seen(A2, A2.owner)).toEqual([A2.workspace]);
    expect(await seen(B1, B1.owner)).toEqual([B1.workspace]);
    expect(await seen({ org: B1.org, workspace: A1.workspace }, B1.owner)).toEqual([]); // A1's workspace under B's organisation
    expect(await seen({ org: A1.org, workspace: B1.workspace }, A1.owner)).toEqual([]);
  });

  it('ML-3 a row for another workspace or organisation is refused (guard / WITH CHECK, 42501), even after a real change', async () => {
    const r = await bound(A1, A1.owner, async (c) => {
      const v = await change(c, A1);
      return [
        (await attempt(c, INSERT_LOG, logParams({ ...A1, workspace: A2.workspace }, v.previous, v.current, { actor: A1.owner }))).code,
        (await attempt(c, INSERT_LOG, logParams({ ...A1, org: B1.org, workspace: B1.workspace }, v.previous, v.current, { actor: A1.owner }))).code,
      ];
    });
    expect(r).toEqual(['42501', '42501']);
  });

  // ------------------------------------------------------------------------------------------------------------ ML-4
  it('ML-4 the legitimate write: a change and its log row in one transaction; actor = bound user; created_at = insert time', async () => {
    const row = await bound(A1, A1.owner, async (c) => {
      const v = await change(c, A1);
      await c.query(
        `INSERT INTO core.metadata_migration ${LOG_COLUMNS.replace(')', ', created_at)')} VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, '2000-01-01T00:00:00Z')`,
        logParams(A1, v.previous, v.current),
      );
      return (
        await c.query<{ actor: string; old: boolean; v: string }>(
          'SELECT actor_user_id::text AS actor, created_at < now() - interval \'1 day\' AS old, metadata_version::text AS v FROM core.metadata_migration WHERE workspace_id = $1 AND metadata_version = $2',
          [A1.workspace, v.current],
        )
      ).rows[0];
    });
    expect(row).toMatchObject({ actor: A1.owner, old: false });
  });

  // ------------------------------------------------------------------------------------------------------------ ML-5
  it('ML-5 abuse: a log row with no data-model change in this transaction is refused (42501)', async () => {
    const r = await bound(A1, A1.owner, async (c) => {
      const v = (await c.query<{ v: string }>('SELECT metadata_version::text AS v FROM core.workspace_metadata_state WHERE workspace_id = $1', [A1.workspace])).rows[0]!.v;
      return [
        (await attempt(c, INSERT_LOG, logParams(A1, String(BigInt(v) - 1n), v))).code, // the committed current version
        (await attempt(c, INSERT_LOG, logParams(A1, v, String(BigInt(v) + 1n)))).code, // a version that does not exist
      ];
    });
    expect(r).toEqual(['42501', '42501']);
  });

  it('ML-5 abuse: a stale, skipped or repeated version is refused (42501 / 23514 / 23505)', async () => {
    const r = await bound(A1, A1.owner, async (c) => {
      const v = await change(c, A1);
      const cur = BigInt(v.current);
      const out = {
        stale: (await attempt(c, INSERT_LOG, logParams(A1, String(cur - 2n), String(cur - 1n)))).code,
        skipped: (await attempt(c, INSERT_LOG, logParams(A1, String(cur - 2n), v.current))).code,
        first: (await attempt(c, INSERT_LOG, logParams(A1, v.previous, v.current))).code,
        repeated: (await attempt(c, INSERT_LOG, logParams(A1, v.previous, v.current))).code,
      };
      return out;
    });
    expect(r).toEqual({ stale: '42501', skipped: '23514', first: null, repeated: '23505' });
  });

  it('ML-5 abuse: a forged actor (another user, or none while a user is bound) is refused (42501)', async () => {
    const r = await bound(A1, A1.owner, async (c) => {
      const v = await change(c, A1);
      return {
        other: (await attempt(c, INSERT_LOG, logParams(A1, v.previous, v.current, { actor: actor }))).code,
        foreign: (await attempt(c, INSERT_LOG, logParams(A1, v.previous, v.current, { actor: B1.owner }))).code,
        none: (await attempt(c, INSERT_LOG, logParams(A1, v.previous, v.current, { actor: null }))).code,
      };
    });
    expect(r).toEqual({ other: '42501', foreign: '42501', none: '42501' });
  });

  it('ML-5 a context with NO user bound (a future job) records a NULL actor, and only NULL', async () => {
    const r = await bound(A1, '', async (c) => {
      const v = await change(c, A1);
      const forged = (await attempt(c, INSERT_LOG, logParams(A1, v.previous, v.current, { actor: A1.owner }))).code;
      const nullActor = (await attempt(c, INSERT_LOG, logParams(A1, v.previous, v.current, { actor: null }))).code;
      const stored = (await c.query<{ a: string | null }>('SELECT actor_user_id::text AS a FROM core.metadata_migration WHERE workspace_id = $1 AND metadata_version = $2', [A1.workspace, v.current])).rows;
      return { forged, nullActor, stored };
    });
    expect(r).toEqual({ forged: '42501', nullActor: null, stored: [{ a: null }] });
  });

  it('ML-10 release-2 dependency: a workspace first-ever change (version 0 → 1) can never be logged (23514); E2 sync must seed version 1 first', async () => {
    const bare = await asAdmin(async (c) => {
      const workspace = (
        await c.query<{ id: string }>("INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id::text", [
          A1.org,
          A1.owner,
          'ML bare',
          `ml-${RUN_ID}-bare`,
        ])
      ).rows[0]!.id;
      return workspace;
    });
    const r = await bound({ org: A1.org, workspace: bare }, A1.owner, async (c) => {
      const before = (await c.query('SELECT 1 FROM core.workspace_metadata_state WHERE workspace_id = $1', [bare])).rowCount;
      const object = (
        await c.query<{ id: string }>(
          `INSERT INTO core.object_metadata (organisation_id, workspace_id, name_singular, name_plural, label_singular, label_plural, physical_table, is_custom, allows_custom_fields)
           VALUES ($1, $2, 'asset', 'assets', 'Asset', 'Assets', $3, true, true) RETURNING id::text`,
          [A1.org, bare, `c_${randomBytes(6).toString('hex')}`],
        )
      ).rows[0]!.id;
      const v = (await c.query<{ v: string }>('SELECT metadata_version::text AS v FROM core.workspace_metadata_state WHERE workspace_id = $1', [bare])).rows[0]!.v;
      const out = await attempt(c, INSERT_LOG, logParams({ tag: 'bare', org: A1.org, owner: A1.owner, workspace: bare, object }, '0', '1'));
      return { before, v, code: out.code, constraint: out.constraint };
    });
    expect(r).toEqual({ before: 0, v: '1', code: '23514', constraint: 'metadata_migration_version_step_ck' });
  });

  it('ML-5 abuse: unknown change kind, malformed actions and an unsafe request id are refused (23514)', async () => {
    const tooMany = JSON.stringify(Array.from({ length: 33 }, () => ({ action: 'rename_label', object_id: randomUUID() })));
    const tooBig = JSON.stringify([{ action: 'rename_label', note: 'x'.repeat(9000) }]);
    const cases: Array<[string, Parameters<typeof logParams>[3]]> = [
      ['kind', { kind: 'object.drop' }],
      ['kind-status', { kind: 'PUBLISHED' }],
      ['actions-object', { actions: JSON.stringify({ action: 'rename_label' }) }],
      ['actions-scalar', { actions: JSON.stringify(['DROP TABLE core.user']) }],
      ['actions-nested', { actions: JSON.stringify([[{ action: 'rename_label' }]]) }],
      ['actions-many', { actions: tooMany }],
      ['actions-big', { actions: tooBig }],
      ['request-newline', { request: 'req\nInjected: yes' }],
      ['request-long', { request: 'r'.repeat(65) }],
      ['executor', { executor: 0 }],
    ];
    const r = await bound(A1, A1.owner, async (c) => {
      const v = await change(c, A1);
      const out: Record<string, string | null> = {};
      for (const [label, over] of cases) out[label] = (await attempt(c, INSERT_LOG, logParams(A1, v.previous, v.current, over))).code;
      return out;
    });
    expect(r).toEqual(Object.fromEntries(cases.map(([label]) => [label, '23514'])));
  });

  // ------------------------------------------------------------------------------------------------------------ ML-6
  it('ML-6 insert-only: UPDATE and DELETE are refused to the runtime login (42501), the rows are unchanged', async () => {
    const r = await bound(A1, A1.owner, async (c) => ({
      seen: (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM core.metadata_migration')).rows[0]!.n,
      update: (await attempt(c, "UPDATE core.metadata_migration SET change_kind = 'object.create'")).code,
      actorNull: (await attempt(c, 'UPDATE core.metadata_migration SET actor_user_id = NULL')).code,
      delete: (await attempt(c, 'DELETE FROM core.metadata_migration')).code,
    }));
    expect(r).toEqual({ seen: 2, update: '42501', actorNull: '42501', delete: '42501' });
    expect(await countFor(A1.workspace)).toBe(2);
  });

  it('ML-6 while the guard trigger is enabled, a plain superuser UPDATE or DELETE is refused too (42501)', async () => {
    const r = await asAdmin((c) =>
      rolledBack(c, async () => ({
        update: (await attempt(c, "UPDATE core.metadata_migration SET request_id = 'x' WHERE workspace_id = $1", [B1.workspace])).code,
        delete: (await attempt(c, 'DELETE FROM core.metadata_migration WHERE workspace_id = $1', [B1.workspace])).code,
      })),
    );
    expect(r).toEqual({ update: '42501', delete: '42501' });
  });

  it('ML-6 TRUNCATE is refused to the request path, directly and through TRUNCATE core.manager_workspace CASCADE (42501)', async () => {
    const r = await asOwner(async (c) => ({
      direct: await rolledBack(c, async () => (await attempt(c, 'TRUNCATE core.metadata_migration')).code),
      cascade: await rolledBack(c, async () => (await attempt(c, 'TRUNCATE core.manager_workspace CASCADE')).code),
    }));
    expect(r).toEqual({ direct: '42501', cascade: '42501' });
    expect(await countFor(B1.workspace)).toBe(1);
  });

  it('ML-6 the superuser (operators, test teardowns) may TRUNCATE (rolled back)', async () => {
    const r = await asAdmin((c) =>
      rolledBack(c, async () => {
        const out = await attempt(c, 'TRUNCATE core.metadata_migration');
        return { code: out.code, left: (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM core.metadata_migration')).rows[0]!.n };
      }),
    );
    expect(r).toEqual({ code: null, left: 0 });
    expect(await countFor(B1.workspace)).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------------------ ML-7
  it('ML-7 deleting the actor user keeps the row and sets only actor_user_id to NULL (owner decision: SET NULL)', async () => {
    const snapshot = (c: Client) =>
      c.query<Record<string, unknown>>(
        `SELECT id::text, organisation_id::text, workspace_id::text, previous_version::text, metadata_version::text, change_kind, actions, actor_user_id::text, request_id, executor_version, created_at
           FROM core.metadata_migration WHERE workspace_id = $1 ORDER BY metadata_version`,
        [A1.workspace],
      );
    const before = await asAdmin(async (c) => (await snapshot(c)).rows);
    expect(before.map((r) => r.actor_user_id)).toEqual([actor, A1.owner]);
    await asAdmin((c) => c.query('DELETE FROM core."user" WHERE id = $1', [actor]));
    const after = await asAdmin(async (c) => (await snapshot(c)).rows);
    expect(after).toEqual([{ ...before[0], actor_user_id: null }, before[1]]);
  });

  // ------------------------------------------------------------------------------------------------------------ ML-9
  it('ML-9 down() refuses while a change-log row exists (rolled back; FORCE stays on)', async () => {
    const ds = new DataSource({ type: 'postgres', url: ADMIN_URL, entities: [], synchronize: false, logging: false, extra: { max: 1 } });
    await ds.initialize();
    try {
      const qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await expect(new MetadataMigrationLog1786721640000().down(qr)).rejects.toThrow(/refusing down\(\): core\.metadata_migration holds \d+ change-log row/);
      } finally {
        await qr.rollbackTransaction();
        await qr.release();
      }
    } finally {
      await ds.destroy();
    }
    const force = await asAdmin(async (c) => (await c.query<{ f: boolean }>("SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'core.metadata_migration'::regclass")).rows[0]!.f);
    expect(force).toBe(true);
  });

  // ------------------------------------------------------------------------------------------------------------ ML-8
  it('ML-8 deleting a workspace deletes exactly its log rows (owner decision: CASCADE); the others stay', async () => {
    const a1 = await countFor(A1.workspace);
    const b1 = await countFor(B1.workspace);
    expect(await countFor(A2.workspace)).toBe(1);
    await asAdmin((c) => c.query('DELETE FROM core.manager_workspace WHERE id = $1', [A2.workspace]));
    expect(await countFor(A2.workspace)).toBe(0);
    expect(await countFor(A1.workspace)).toBe(a1);
    expect(await countFor(B1.workspace)).toBe(b1);
  });

  // ----------------------------------------------------------------------------------------------------------- ML-11
  it('ML-11 two concurrent changes of one workspace: the second waits for the first, then logs the next version; both commit', async () => {
    const before = await countFor(B1.workspace);
    const c1 = new Client({ connectionString: OWNER_URL, application_name: 'metadata-migration-log-spec-1' });
    const c2 = new Client({ connectionString: OWNER_URL, application_name: 'metadata-migration-log-spec-2' });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await c1.query(BIND_SQL, [B1.org, B1.workspace, B1.owner]);
      await c2.query(BIND_SQL, [B1.org, B1.workspace, B1.owner]);
      const v1 = await change(c1, B1);
      const second = change(c2, B1); // blocks on c1's row locks (the object row it relabelled, the version row it bumped)
      const raced = await Promise.race([second.then(() => 'not blocked'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 1500))]);
      await c1.query(INSERT_LOG, logParams(B1, v1.previous, v1.current));
      await c1.query('COMMIT');
      const v2 = await second;
      await c2.query(INSERT_LOG, logParams(B1, v2.previous, v2.current));
      await c2.query('COMMIT');
      expect(raced).toBe('blocked');
      expect(BigInt(v2.previous)).toBe(BigInt(v1.current));
      expect(BigInt(v2.current)).toBe(BigInt(v1.current) + 1n);
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined);
      await c2.query('ROLLBACK').catch(() => undefined);
      await c1.end();
      await c2.end();
    }
    expect(await countFor(B1.workspace)).toBe(before + 2);
    const versions = await asAdmin(async (c) => (await c.query<{ v: string }>('SELECT metadata_version::text AS v FROM core.metadata_migration WHERE workspace_id = $1 ORDER BY 1', [B1.workspace])).rows.map((x) => x.v));
    expect(new Set(versions).size).toBe(versions.length);
  });
});
