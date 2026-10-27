import 'reflect-metadata';
import { randomUUID } from 'node:crypto';

import { Client, Pool } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { CREWFLOW_APP_COPIED_WRITE_REVOKES_1786720020000 } from '../../database/typeorm/core/migrations/1786720020000-CrewflowAppCopiedWriteGrantRevoke';
import { dropWorkspaceSchema, provisionServerPath, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace, sqlstateOf } from './helpers/workspace-fixtures';

/**
 * M10 lane C — CrewflowAppCopiedWriteGrantRevoke1786720020000. Disposable database only (bootstrap superuser as
 * TEST_DATABASE_URL_UNPOOLED, crewflow_app as TEST_DATABASE_URL).
 *
 * Abuse cases (CLAUDE.md testing floor — the denial, not just the happy path):
 *  - the runtime role, inside its OWN organisation's bound context where the row is visible, cannot INSERT/UPDATE/DELETE
 *    core.workspace_schema_registry (42501, not "0 rows"): it could otherwise flip a workspace's routing status/version or
 *    erase the registry row that routes it;
 *  - nor DELETE core.workspace_membership / core.hws_backfill_checkpoint / core.stored_file (evidence and identity rows);
 *  - a spoofed organisation GUC sees zero registry rows of another tenant, and the write is still refused by privilege;
 *  - a pooled connection (pool max 1) reused after a bound transaction sees zero rows (no stale tenant context).
 * Still-working paths (regression): server-path provisioning as crewflow_app (core.provision_workspace, DEFINER), the
 * TS provisioner as crewflow, core.mark_workspace_schema_superseded as crewflow_app (DEFINER), membership
 * suspend/reinstate (DEFINER), the hws:backfill checkpoint upsert and the stored_file tombstone UPDATE as crewflow_app.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(240_000);

describeIfDb('crewflow_app copied write grants revoked (1786720020000)', () => {
  const { adminUrl, appUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  const sfx = Math.random().toString(36).slice(2, 8);
  let admin: Client;
  let app: Client;
  let a: SeededWorkspace; // READY via the server path (crewflow_app)
  let b: SeededWorkspace; // READY via the TS provisioner (crewflow), another organisation
  let c: SeededWorkspace; // PROVISIONING registry row, then superseded through the DEFINER function
  const created: SeededWorkspace[] = [];
  let fileId: string;

  /** Runs `fn` as crewflow_app in one transaction with the tenant GUCs bound (as TenantContextService does). */
  async function asApp<T>(org: string, ws: string | null, user: string | null, fn: () => Promise<T>): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`,
        [org, ws ?? '', user ?? ''],
      );
      return await fn();
    } finally {
      await app.query('ROLLBACK');
    }
  }

  /** Same, but each statement in its own savepoint so a refused one does not abort the rest. */
  const refused = async (sql: string, params: unknown[] = []) => {
    await app.query('SAVEPOINT s');
    const code = await sqlstateOf(app.query(sql, params));
    await app.query('ROLLBACK TO SAVEPOINT s');
    return code;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    if (!(await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0].rolsuper) {
      throw new Error('this suite needs the disposable database bootstrap superuser as TEST_DATABASE_URL_UNPOOLED');
    }
    app = new Client({ connectionString: appUrl });
    await app.connect();
    expect((await app.query('SELECT current_user AS u')).rows[0].u).toBe('crewflow_app');

    a = await seedWorkspace(admin, `lcg-a-${sfx}`);
    b = await seedWorkspace(admin, `lcg-b-${sfx}`);
    c = await seedWorkspace(admin, `lcg-c-${sfx}`);
    created.push(a, b, c);
    expect(await provisionServerPath(appUrl, a)).toBe('READY');
    expect(await provisionTypeScript(adminUrl, b)).toBe('READY');

    // c: a PROVISIONING registry row, written the way the provisioner does (crewflow, lifecycle functions).
    const cf = new Client({ connectionString: adminUrl });
    await cf.connect();
    try {
      await cf.query('SET ROLE crewflow');
      await cf.query('BEGIN');
      await cf.query(`SELECT set_config('rab.organisation_id', $1, true)`, [c.org]);
      await cf.query('SELECT core.begin_workspace_schema_attempt($1)', [c.id]);
      await cf.query('SELECT core.register_workspace_schema($1)', [c.id]);
      await cf.query('COMMIT');
    } finally {
      await cf.end();
    }

    // a: an active membership, a backfill checkpoint row and a file row, all of a's own organisation/workspace.
    await admin.query(
      `INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source) VALUES ($1, $2, $3, 'active', 'write_path')
       ON CONFLICT DO NOTHING`,
      [a.org, a.owner, a.id],
    );
    await admin.query(
      `INSERT INTO core.hws_backfill_checkpoint (organisation_id, workspace_id, table_name, state) VALUES ($1, $2, 'venue', 'completed')`,
      [a.org, a.id],
    );
    fileId = (
      await admin.query(
        `INSERT INTO core.stored_file (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, object_key, original_filename, mime_type, size_bytes, status, created_by)
         VALUES ($1, $2, 'ORGANISATION_LOGO', 'organisation', $1, 'LOCAL', $3, 'f.bin', 'application/octet-stream', 10, 'PENDING', $4) RETURNING id`,
        [a.org, a.id, `lane-c/${randomUUID()}`, a.owner],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    for (const ws of created) await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
    await app?.end();
    await admin?.end();
  });

  it('catalog: every revoked privilege is gone (table AND column level); SELECT and the kept writes remain', async () => {
    for (const { table, privileges } of CREWFLOW_APP_COPIED_WRITE_REVOKES_1786720020000) {
      const rel = `core.${table}`;
      const q = async (sql: string) => (await admin.query(sql, [rel])).rows[0].v as boolean;
      expect(await q(`SELECT has_table_privilege('crewflow_app', $1::regclass, 'SELECT') AS v`)).toBe(true);
      for (const p of privileges) {
        expect([table, p, await q(`SELECT has_table_privilege('crewflow_app', $1::regclass, '${p}') AS v`)]).toEqual([table, p, false]);
        if (p !== 'DELETE') expect(await q(`SELECT has_any_column_privilege('crewflow_app', $1::regclass, '${p}') AS v`)).toBe(false);
      }
    }
    const kept: Array<[string, string]> = [
      ['workspace_membership', 'INSERT'],
      ['workspace_membership', 'UPDATE'],
      ['hws_backfill_checkpoint', 'INSERT'],
      ['hws_backfill_checkpoint', 'UPDATE'],
      ['stored_file', 'INSERT'],
      ['stored_file', 'UPDATE'],
    ];
    for (const [t, p] of kept) {
      expect([t, p, (await admin.query(`SELECT has_table_privilege('crewflow_app', $1::regclass, $2) AS v`, [`core.${t}`, p])).rows[0].v]).toEqual([t, p, true]);
    }
    // The privileged identities keep what their own paths need.
    expect((await admin.query(`SELECT has_table_privilege('rab_secure_owner', 'core.workspace_schema_registry', 'UPDATE') AS v`)).rows[0].v).toBe(true);
    expect((await admin.query(`SELECT has_table_privilege('crewflow', 'core.workspace_schema_registry', 'UPDATE') AS v`)).rows[0].v).toBe(true);
  });

  it('abuse: crewflow_app cannot INSERT/UPDATE/DELETE its own organisation’s registry row (42501), and the row is unchanged', async () => {
    const before = await registryOf(admin, a.id);
    await asApp(a.org, a.id, a.owner, async () => {
      // Positive control: the row IS visible, so a refusal below is the privilege, not RLS hiding it.
      expect((await app.query('SELECT status FROM core.workspace_schema_registry WHERE workspace_id = $1', [a.id])).rows).toEqual([{ status: 'READY' }]);
      expect(await refused(`UPDATE core.workspace_schema_registry SET status = 'FAILED' WHERE workspace_id = $1`, [a.id])).toBe('42501');
      expect(await refused(`UPDATE core.workspace_schema_registry SET schema_version = 99 WHERE workspace_id = $1`, [a.id])).toBe('42501');
      expect(await refused(`UPDATE core.workspace_schema_registry SET migration_error = 'x' WHERE workspace_id = $1`, [a.id])).toBe('42501');
      expect(await refused(`DELETE FROM core.workspace_schema_registry WHERE workspace_id = $1`, [a.id])).toBe('42501');
      expect(
        await refused(`INSERT INTO core.workspace_schema_registry (workspace_id, organisation_id, schema_name, status) VALUES ($1, $2, $3, 'PROVISIONING')`, [
          c.id,
          a.org,
          c.schema,
        ]),
      ).toBe('42501');
    });
    expect(await registryOf(admin, a.id)).toEqual(before);
  });

  it('abuse: a spoofed organisation GUC sees zero rows of another tenant, and the write is refused by privilege first', async () => {
    await asApp(a.org, a.id, a.owner, async () => {
      expect((await app.query('SELECT count(*)::int AS n FROM core.workspace_schema_registry WHERE workspace_id = $1', [b.id])).rows[0].n).toBe(0);
      expect(await refused(`UPDATE core.workspace_schema_registry SET status = 'FAILED' WHERE workspace_id = $1`, [b.id])).toBe('42501');
    });
    expect((await registryOf(admin, b.id)).status).toBe('READY');
  });

  it('abuse: crewflow_app cannot DELETE membership, backfill checkpoint or file evidence rows it can see (42501)', async () => {
    await asApp(a.org, a.id, a.owner, async () => {
      expect((await app.query('SELECT count(*)::int AS n FROM core.workspace_membership WHERE user_id = $1', [a.owner])).rows[0].n).toBe(1);
      expect((await app.query('SELECT count(*)::int AS n FROM core.hws_backfill_checkpoint WHERE workspace_id = $1', [a.id])).rows[0].n).toBe(1);
      expect((await app.query('SELECT count(*)::int AS n FROM core.stored_file WHERE id = $1', [fileId])).rows[0].n).toBe(1);
      expect(await refused('DELETE FROM core.workspace_membership WHERE user_id = $1', [a.owner])).toBe('42501');
      expect(await refused('DELETE FROM core.hws_backfill_checkpoint WHERE workspace_id = $1', [a.id])).toBe('42501');
      expect(await refused('DELETE FROM core.stored_file WHERE id = $1', [fileId])).toBe('42501');
    });
    expect((await admin.query('SELECT count(*)::int AS n FROM core.stored_file WHERE id = $1', [fileId])).rows[0].n).toBe(1);
  });

  it('no tenant context bound: zero rows (fail closed), and a pool of one connection carries no stale context', async () => {
    const pool = new Pool({ connectionString: appUrl, max: 1 });
    try {
      const bound = await pool.connect();
      try {
        await bound.query('BEGIN');
        await bound.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [
          a.org,
          a.id,
          a.owner,
        ]);
        expect((await bound.query('SELECT count(*)::int AS n FROM core.workspace_schema_registry')).rows[0].n).toBe(1);
        await bound.query('COMMIT');
      } finally {
        bound.release();
      }
      // The SAME physical connection (max 1), next "request" with nothing bound.
      for (const t of ['workspace_schema_registry', 'workspace_membership', 'hws_backfill_checkpoint', 'stored_file']) {
        expect([t, (await pool.query(`SELECT count(*)::int AS n FROM core.${t}`)).rows[0].n]).toEqual([t, 0]);
      }
    } finally {
      await pool.end();
    }
  });

  it('regression: the DEFINER write paths still work for crewflow_app (supersede, membership suspend/reinstate)', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [c.org, c.owner]);
    await app.query('SELECT core.mark_workspace_schema_superseded($1, $2)', [c.id, 'lane-c regression']);
    await app.query('COMMIT');
    expect((await registryOf(admin, c.id)).status).toBe('FAILED');
    expect((await admin.query('SELECT schema_status FROM core.manager_workspace WHERE id = $1', [c.id])).rows[0].schema_status).toBe('SUPERSEDED');

    await app.query('BEGIN');
    await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [
      a.org,
      a.id,
      a.owner,
    ]);
    await app.query('SELECT core.suspend_workspace_membership($1)', [a.owner]);
    await app.query('COMMIT');
    expect((await admin.query('SELECT status FROM core.workspace_membership WHERE user_id = $1', [a.owner])).rows[0].status).toBe('suspended');
    await app.query('BEGIN');
    await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [
      a.org,
      a.id,
      a.owner,
    ]);
    await app.query('SELECT core.reinstate_workspace_membership($1)', [a.owner]);
    await app.query('COMMIT');
    expect((await admin.query('SELECT status FROM core.workspace_membership WHERE user_id = $1', [a.owner])).rows[0].status).toBe('active');
  });

  it('regression: the hws:backfill checkpoint upsert and the stored_file tombstone UPDATE still work as crewflow_app', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [a.org, a.id]);
    // Same statement shape as HwsBackfillService (INSERT ... ON CONFLICT DO UPDATE).
    await app.query(
      `INSERT INTO core.hws_backfill_checkpoint (organisation_id, workspace_id, table_name, state, rows_copied, started_at, completed_at, last_safe_error, updated_at)
       VALUES ($1, $2, 'venue', 'completed', 3, now(), now(), NULL, now())
       ON CONFLICT (workspace_id, table_name) DO UPDATE SET state = EXCLUDED.state, rows_copied = EXCLUDED.rows_copied, updated_at = now()`,
      [a.org, a.id],
    );
    await app.query(`UPDATE core.stored_file SET status = 'DELETED', deleted_at = now() WHERE id = $1`, [fileId]);
    await app.query('COMMIT');
    expect((await admin.query(`SELECT rows_copied FROM core.hws_backfill_checkpoint WHERE workspace_id = $1 AND table_name = 'venue'`, [a.id])).rows[0].rows_copied).toBe(3);
    expect((await admin.query('SELECT status FROM core.stored_file WHERE id = $1', [fileId])).rows[0].status).toBe('DELETED');
  });
});
