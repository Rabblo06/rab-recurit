import 'reflect-metadata';
import { Client } from 'pg';

import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { CREWFLOW_STANDARD_OBJECT_DEFINITIONS } from '../../database/typeorm/workspace-schema/standard-objects/standard-object-definitions';
import { EXPECTED_WORKSPACE_FINGERPRINTS, selectWorkspaceFingerprintsForServer } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { WORKSPACE_TABLES } from '../../database/typeorm/workspace-schema/workspace-tables';
import type { WorkspaceUpgradeCommand } from '../../engine/core-modules/upgrade/upgrade-commands/workspace-upgrade-command';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../engine/core-modules/upgrade/upgrade-commands/registry';
import { upgradeSessionOf, UpgradeSession } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { WorkspaceCommandRunner, WorkspaceRunOptions } from '../../engine/core-modules/upgrade/workspace-command-runner';
import { declaredFingerprint } from '../../engine/core-modules/upgrade/workspace-structure-level';
import { PAYROLL_ATTENDANCE_SYSTEM_TABLES, StandardObjectSyncError } from '../../engine/metadata/standard-objects/standard-object-plan';
import { syncStandardObjects } from '../../engine/metadata/standard-objects/standard-object-sync';
import { metadataCatalogDifferences } from './helpers/standard-metadata-equivalence';
import { dropWorkspaceSchema, FROZEN_TEMPLATE_REGISTRY, provisionTypeScript, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * Metadata engine M1 / E2 (OWNER-METADATA-ENGINE.md §1 E2, §0.3; M1 exit "metadata for every workspace matches the 21
 * tables"): the 0.6.0 workspace command SyncStandardObjects on a real (disposable) database, run by the Part D workspace
 * command runner through the one runtime login (crewflow_owner) holding the migration lock, exactly like the migrate child.
 * Workspaces are built from the frozen module-20 template and adopted at 0.6.0, so they run this code's real 0.6.0 workspace
 * commands (StaffProfileMemberSelect at level 21, DropWorkspaceCoreForeignKeys at level 22, then SyncStandardObjects). Proves:
 *  - the metadata of EVERY workspace matches its 21 tables exactly (columns, types, nullability, FKs → relations, CHECK enums
 *    → options), compared with pg_catalog independently of the code's definitions;
 *  - the §0.3 locks hold in the stored rows (seven system objects, no custom fields, locked + read-only fields, S13);
 *  - a re-run changes nothing (direct call and a runner retry after a lost logbook row): same rows, same updated_at, same
 *    metadata version; one completed logbook row per (workspace, step);
 *  - a workspace whose tables differ from the definitions is refused before anything is written (CATALOG_MISMATCH);
 *  - the runner's metadata write check: a command may not write metadata without declaring it, may not write another
 *    workspace's metadata, may not delete metadata, may not write a row twice (all OUTSIDE_SCHEMA, rolled back).
 */
jest.setTimeout(300_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';
const LOCK = MIGRATION_LOCK_KEY.toString();
const T0 = 1786800100000;
const REAL = (WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? []).map((c) => `0.6.0_${c.name}_${c.timestamp}`);
const SYNC_STEP = REAL.find((n) => n.includes('_SyncStandardObjects_'))!;

describeIfDb('M1 / E2: standard objects synced into metadata (integration)', () => {
  const { adminUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let session: UpgradeSession;
  const created: SeededWorkspace[] = [];
  const lines: string[] = [];
  let seq = 0;

  const make = async (n: string): Promise<SeededWorkspace> => {
    seq += 1;
    const ws = await seedWorkspace(admin, `so-${n}-${SFX}-${String.fromCharCode(97 + (seq % 26))}`);
    created.push(ws);
    expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: FROZEN_TEMPLATE_REGISTRY })).toBe('READY');
    return ws;
  };
  const runner = (o: Partial<WorkspaceRunOptions> & Pick<WorkspaceRunOptions, 'workspaceIds'>) =>
    new WorkspaceCommandRunner({
      codeVersion: '0.7.0',
      versions: ['0.4.0', '0.5.0', '0.6.0'],
      force: false,
      adopt: false,
      log: (l) => lines.push(l),
      expectedFingerprint: (level, major) => (level > 20 ? declaredFingerprint(level, major) : EXPECTED_WORKSPACE_FINGERPRINTS[level]),
      ...o,
      workspaceRegistry: o.workspaceRegistry ? { ...WORKSPACE_UPGRADE_COMMANDS, ...o.workspaceRegistry } : undefined,
    }).run(session);
  // The 0.6.0 adoption run with 0.6.0's own workspace commands: release 0.7.0's (C3 Q3's level 23 in the Q3 branch) were not
  // part of 0.6.0, so they are emptied here (a 0.6.0 run that knew them would refuse its workspaces as STRUCTURE_BEHIND).
  const adopt = (ids: string[]) => runner({ codeVersion: '0.6.0', versions: ['0.4.0', '0.5.0'], adopt: true, workspaceIds: ids, workspaceRegistry: { '0-7': [] } });
  const logbook = async (ws: SeededWorkspace) =>
    (await admin.query(`SELECT name, status, attempt FROM core.upgrade_migration WHERE workspace_id = $1 ORDER BY created_at, attempt`, [ws.id])).rows as Array<{ name: string; status: string; attempt: number }>;
  /** Every metadata row of the workspace (incl. updated_at and xmin, so an unchanged re-run is provable). */
  const snapshot = async (ws: SeededWorkspace) => {
    const q = async (sql: string) => (await admin.query(sql, [ws.id])).rows;
    const state = await admin.query(`SELECT to_regclass('core.workspace_metadata_state') IS NOT NULL AS ok`);
    return {
      objects: await q(`SELECT o.*, o.xmin::text AS x FROM core.object_metadata o WHERE workspace_id = $1 ORDER BY id`),
      fields: await q(`SELECT f.*, f.xmin::text AS x FROM core.field_metadata f WHERE workspace_id = $1 ORDER BY id`),
      options: await q(`SELECT p.*, p.xmin::text AS x FROM core.field_metadata_option p WHERE workspace_id = $1 ORDER BY id`),
      version: state.rows[0].ok ? await q(`SELECT metadata_version::text AS v FROM core.workspace_metadata_state WHERE workspace_id = $1`) : [],
    };
  };
  /** Runs `fn` as crewflow with the tenant bound to `ws`, in one transaction (COMMIT or ROLLBACK). */
  const asCrewflow = async <T>(ws: SeededWorkspace, fn: (q: (sql: string, p?: unknown[]) => Promise<unknown[]>) => Promise<T>, commit = true): Promise<T> => {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE crewflow');
      await admin.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [ws.org, ws.id]);
      const r = await fn(async (sql, p) => (await admin.query(sql, p as unknown[])).rows);
      await admin.query(commit ? 'COMMIT' : 'ROLLBACK');
      return r;
    } catch (e) {
      await admin.query('ROLLBACK');
      throw e;
    }
  };
  const cmd = (name: string, i: number, body: Partial<WorkspaceUpgradeCommand>): WorkspaceUpgradeCommand => ({ kind: 'workspace', name, timestamp: T0 + i, ...body });

  let a: SeededWorkspace;
  let b: SeededWorkspace;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    app = new Client({ connectionString: integrationTestDatabase().appUrl });
    await admin.connect();
    await app.connect();
    await selectWorkspaceFingerprintsForServer(async (sql) => (await admin.query(sql)).rows);
    await app.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);
    session = upgradeSessionOf(app);
    a = await make('a');
    b = await make('b');
    const run = await adopt([a.id, b.id]);
    expect(run.failures).toEqual([]);
  });

  afterAll(async () => {
    await app?.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK]).catch(() => undefined);
    for (const ws of created) {
      await admin.query('DELETE FROM core.upgrade_migration WHERE workspace_id = $1', [ws.id]).catch(() => undefined);
      await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
      await admin.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED', module_version = LEAST(module_version, 20) WHERE workspace_id = $1`, [ws.id]).catch(() => undefined);
      await admin.query('DELETE FROM core.manager_workspace WHERE id = $1', [ws.id]).catch(() => undefined);
    }
    await app?.end();
    await admin?.end();
  });

  it('the runner session is the one runtime login, never a superuser', async () => {
    const r = (await app.query(`SELECT current_user::text AS u, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS strong`)).rows[0];
    expect(r).toEqual({ u: 'crewflow_owner', strong: false });
  });

  it('each workspace ran SyncStandardObjects once, recorded completed in its logbook (Part D)', async () => {
    for (const ws of [a, b]) {
      const rows = await logbook(ws);
      expect(rows.filter((r) => r.name === SYNC_STEP)).toEqual([{ name: SYNC_STEP, status: 'completed', attempt: 1 }]);
    }
  });

  it('the metadata of EVERY workspace matches its 21 tables exactly (pg_catalog comparison)', async () => {
    for (const ws of [a, b]) expect(await metadataCatalogDifferences(admin, ws, WORKSPACE_TABLES)).toEqual([]);
    const counts = (await admin.query(
      `SELECT workspace_id::text AS ws, (SELECT count(*) FROM core.object_metadata o WHERE o.workspace_id = w.workspace_id)::int AS objects,
              (SELECT count(*) FROM core.field_metadata f WHERE f.workspace_id = w.workspace_id)::int AS fields
         FROM (SELECT unnest($1::uuid[]) AS workspace_id) w ORDER BY 1`,
      [[a.id, b.id]],
    )).rows as Array<{ objects: number; fields: number }>;
    for (const c of counts) expect({ objects: c.objects, fields: c.fields }).toEqual({ objects: 25, fields: 344 });
    // eslint-disable-next-line no-console
    console.log(`[m1-sync-equivalence] ${created.length} workspaces x ${WORKSPACE_TABLES.length} tables: 0 differences; 25 objects, 344 fields each`);
  });

  it('the §0.3 locks hold in the stored rows: seven system objects, no custom fields, every built-in field locked, read-only where required', async () => {
    const objects = (await admin.query(`SELECT physical_table, is_system, allows_custom_fields FROM core.object_metadata WHERE workspace_id = $1 AND NOT is_custom`, [a.id])).rows as Array<{ physical_table: string; is_system: boolean; allows_custom_fields: boolean }>;
    for (const t of PAYROLL_ATTENDANCE_SYSTEM_TABLES) expect(objects.find((o) => o.physical_table === t)).toEqual({ physical_table: t, is_system: true, allows_custom_fields: false });
    expect(objects.filter((o) => o.allows_custom_fields).map((o) => o.physical_table).sort()).toEqual(['job_offer', 'job_role', 'shift', 'shift_staff_review', 'staff_profile', 'venue']);
    const fields = (await admin.query(
      `SELECT o.physical_table AS t, o.is_system AS sys, f.physical_column AS c, f.type, f.is_locked, f.is_sensitive, f.is_ui_read_only AS ro, f.is_money AS money, f.settings
         FROM core.field_metadata f JOIN core.object_metadata o ON o.id = f.object_metadata_id
        WHERE f.workspace_id = $1 AND NOT f.is_custom`,
      [a.id],
    )).rows as Array<{ t: string; sys: boolean; c: string | null; type: string; is_locked: boolean; is_sensitive: boolean; ro: boolean; money: boolean; settings: Record<string, unknown> }>;
    expect(fields.filter((f) => !f.is_locked)).toEqual([]);
    expect(fields.filter((f) => f.sys && !f.ro)).toEqual([]);
    expect(fields.filter((f) => f.type === 'SELECT' && (f.c === 'status' || String(f.c).endsWith('_status')) && !f.ro)).toEqual([]);
    const money = fields.filter((f) => String(f.c).endsWith('_pence'));
    expect(money).toHaveLength(14);
    expect(money.filter((f) => !(f.type === 'NUMBER' && f.is_sensitive && f.money && f.ro))).toEqual([]);
  });

  it('a re-run changes nothing: a direct sync plans nothing; a runner retry after a lost logbook row completes with the same rows', async () => {
    const before = await snapshot(a);
    const report = await asCrewflow(a, (q) => syncStandardObjects(q, CREWFLOW_STANDARD_OBJECT_DEFINITIONS, { workspaceId: a.id, organisationId: a.org, schemaName: a.schema }));
    expect(report).toEqual({ objectsInserted: 0, objectsUpdated: 0, fieldsInserted: 0, fieldsUpdated: 0, optionsInserted: 0, optionsUpdated: 0 });
    expect(await snapshot(a)).toEqual(before);

    // A crash after COMMIT, before the logbook row: the row is lost, the step runs again on the next start and writes nothing.
    await admin.query(`DELETE FROM core.upgrade_migration WHERE workspace_id = $1 AND name = $2`, [a.id, SYNC_STEP]);
    const again = await runner({ codeVersion: '0.6.0', versions: ['0.4.0', '0.5.0'], adopt: true, workspaceIds: [a.id], workspaceRegistry: { '0-7': [] } });
    expect(again.failures).toEqual([]);
    expect((await logbook(a)).filter((r) => r.name === SYNC_STEP)).toEqual([{ name: SYNC_STEP, status: 'completed', attempt: 1 }]);
    expect(await snapshot(a)).toEqual(before);
  });

  it('a workspace whose tables differ from the definitions is refused before anything is written (CATALOG_MISMATCH)', async () => {
    const before = await snapshot(b);
    await admin.query('BEGIN');
    try {
      await admin.query(`ALTER TABLE ${b.schema}.venue ADD COLUMN surprise_col text`);
      await admin.query('SET LOCAL ROLE crewflow');
      await admin.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [b.org, b.id]);
      const err = await syncStandardObjects(async (sql, p) => (await admin.query(sql, p as unknown[])).rows, CREWFLOW_STANDARD_OBJECT_DEFINITIONS, {
        workspaceId: b.id,
        organisationId: b.org,
        schemaName: b.schema,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StandardObjectSyncError);
      expect((err as StandardObjectSyncError).code).toBe('CATALOG_MISMATCH');
      expect((err as Error).message).toContain('venue.surprise_col has no standard field');
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await snapshot(b)).toEqual(before);
  });

  it('fails closed with no tenant bound, or bound to another workspace (NO_TENANT), before reading anything', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE crewflow');
      await admin.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [b.org, b.id]);
      const err = await syncStandardObjects(async (sql, p) => (await admin.query(sql, p as unknown[])).rows, CREWFLOW_STANDARD_OBJECT_DEFINITIONS, { workspaceId: a.id, organisationId: a.org }).catch((e: unknown) => e);
      expect((err as StandardObjectSyncError).code).toBe('NO_TENANT');
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  describe('the runner metadata write check (SECURITY TRADE-OFF M1-S1)', () => {
    let i = 0;
    /** Runs one 0.7.0 probe command on `ws`, then removes its logbook rows so the next probe starts from the same cursor. */
    const run = async (c: WorkspaceUpgradeCommand, ws: SeededWorkspace) => {
      try {
        const r = await runner({ workspaceRegistry: { '0-7': [c] }, workspaceIds: [ws.id] });
        return r.failures.map((f) => [f.step, f.errorClass]);
      } finally {
        await admin.query(`DELETE FROM core.upgrade_migration WHERE workspace_id = $1 AND name LIKE '0.7.0\\_%'`, [ws.id]);
        await admin.query(`UPDATE core.workspace_schema_registry SET migration_error = NULL WHERE workspace_id = $1 AND migration_error LIKE 'upgrade-blocked: %'`, [ws.id]);
      }
    };
    const probe = (name: string, body: Partial<WorkspaceUpgradeCommand>) => {
      i += 1;
      return { c: cmd(name, i, body), step: `0.7.0_${name}_${T0 + i}` };
    };
    const labelOf = async (ws: SeededWorkspace, table: string) =>
      (await admin.query(`SELECT label_plural FROM core.object_metadata WHERE workspace_id = $1 AND physical_table = $2`, [ws.id, table])).rows[0]?.label_plural as string;
    const optionCount = async (ws: SeededWorkspace) => Number((await admin.query(`SELECT count(*)::int AS n FROM core.field_metadata_option WHERE workspace_id = $1`, [ws.id])).rows[0].n);

    it('a command that does NOT declare writesWorkspaceMetadata may not write metadata (OUTSIDE_SCHEMA, rolled back)', async () => {
      const { c, step } = probe('MetaNoFlag', {
        run: async ({ query, workspaceId }) => void (await query(`UPDATE core.object_metadata SET label_plural = 'Hacked' WHERE workspace_id = $1 AND physical_table = 'venue'`, [workspaceId])),
      });
      expect(await run(c, b)).toEqual([[step, 'OUTSIDE_SCHEMA']]);
      expect(await labelOf(b, 'venue')).toBe('Venues');
    });

    it("a declared command may not write ANOTHER workspace's metadata, even after re-binding and restoring the tenant", async () => {
      const { c, step } = probe('MetaForeign', {
        writesWorkspaceMetadata: true,
        run: async ({ query, workspaceId, organisationId }) => {
          await query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [a.org, a.id]);
          await query(`UPDATE core.object_metadata SET label_plural = 'Hacked' WHERE workspace_id = $1 AND physical_table = 'venue'`, [a.id]);
          await query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [organisationId, workspaceId]);
        },
      });
      expect(await run(c, b)).toEqual([[step, 'OUTSIDE_SCHEMA']]);
      expect(await labelOf(a, 'venue')).toBe('Venues');
    });

    it('a declared command may not delete metadata', async () => {
      const before = await optionCount(b);
      const { c, step } = probe('MetaDelete', {
        writesWorkspaceMetadata: true,
        run: async ({ query, workspaceId }) =>
          void (await query(`DELETE FROM core.field_metadata_option WHERE id = (SELECT id FROM core.field_metadata_option WHERE workspace_id = $1 ORDER BY id LIMIT 1)`, [workspaceId])),
      });
      const failures = await run(c, b);
      expect(failures).toHaveLength(1);
      expect(failures[0]![0]).toBe(step);
      // OUTSIDE_SCHEMA from the delete counter, or a permission error if the table grants no DELETE: refused either way.
      expect(['OUTSIDE_SCHEMA', 'SQLSTATE_42501']).toContain(failures[0]![1]);
      expect(await optionCount(b)).toBe(before);
    });

    it('a declared command may not write one row twice (the at-most-once rule the proof relies on)', async () => {
      const { c, step } = probe('MetaTwice', {
        writesWorkspaceMetadata: true,
        run: async ({ query, workspaceId }) => {
          await query(`UPDATE core.object_metadata SET label_plural = 'Sites' WHERE workspace_id = $1 AND physical_table = 'venue'`, [workspaceId]);
          await query(`UPDATE core.object_metadata SET label_plural = 'Places' WHERE workspace_id = $1 AND physical_table = 'venue'`, [workspaceId]);
        },
      });
      expect(await run(c, b)).toEqual([[step, 'OUTSIDE_SCHEMA']]);
      expect(await labelOf(b, 'venue')).toBe('Venues');
    });

    it('a declared command writing its own rows once passes; the next sync puts the code-owned label back', async () => {
      const { c } = probe('MetaOwnLabel', {
        writesWorkspaceMetadata: true,
        run: async ({ query, workspaceId }) => void (await query(`UPDATE core.object_metadata SET label_plural = 'Sites' WHERE workspace_id = $1 AND physical_table = 'venue'`, [workspaceId])),
      });
      expect(await run(c, b)).toEqual([]);
      expect(await labelOf(b, 'venue')).toBe('Sites');
      const report = await asCrewflow(b, (q) => syncStandardObjects(q, CREWFLOW_STANDARD_OBJECT_DEFINITIONS, { workspaceId: b.id, organisationId: b.org, schemaName: b.schema }));
      expect(report).toMatchObject({ objectsUpdated: 1, objectsInserted: 0, fieldsInserted: 0, fieldsUpdated: 0 });
      expect(await labelOf(b, 'venue')).toBe('Venues');
    });
  });
});
