import 'reflect-metadata';
import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, EntityManager } from 'typeorm';

import { checkSchemaCompatibility, DatabaseBootGateError, runDatabaseBootGates, RunBootGatesOptions } from '../../database/boot-checks/database-boot-gates';
import { coreDataSourceOptions } from '../../database/typeorm/core/core.datasource';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { schemaCompatibilityPostCheckProblems } from '../../database/typeorm/scripts/migrate/deploy-post-checks';
import { runLockedMigrations } from '../../database/typeorm/scripts/migrate/locked-migration-runner';
import { PROVISION_FUNCTION_MODULE_VERSIONS, readProvisionFunctionState } from '../../database/typeorm/workspace-schema/provision-function-versions';
import { LATEST_WORKSPACE_MODULE_VERSION, MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION } from '../../database/typeorm/workspace-schema/workspace-schema-modules';
import type { ExceptionHandlerService } from '../../engine/core-modules/exception-handler/exception-handler.service';
import { SchemaResolverService, WorkspaceRoutingError } from '../../engine/core-modules/tenant/schema-resolver.service';
import { AllExceptionsFilter } from '../../engine/filters/all-exceptions.filter';
import { assertNoPendingMigrations } from '../../engine/utils/assert-no-pending-migrations';
import { provisionServerPath, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * Phase B, "the API and Worker must refuse incompatible schema versions" (proposal 03), on the real disposable test
 * database:
 *   - a fake FUTURE ledger row (an image rollback): API / Worker / CLI boot with a warning; the provisioner refuses; a
 *     rab-migrate apply run refuses, its check run warns;
 *   - a fake INTERLEAVED ledger row (another branch / wrong database): every process refuses; RETIRED_MIGRATIONS excuses it;
 *   - a READY workspace below MIN_COMPATIBLE: routing refuses that workspace only (503), the deploy post-check refuses; at
 *     LATEST-1 but at/above the floor (an additive newest module, Phase D's 19): it routes and the post-check reports it; at
 *     LATEST+1: the provisioner refuses to start, the API does not scan the fleet.
 *
 * It WRITES fixture rows to `core.migrations` (as the bootstrap superuser) and always deletes them again in `finally`; its two
 * workspace fixtures are deleted completely in afterAll (and any leftover in beforeAll — removeCompatWorkspaces), so it
 * must run in band (CI does) — and is meant to run against a throwaway copy of the harness database (the Phase B
 * verification does). The provisioner cases need TEST_DATABASE_CREWFLOW_URL (the `crewflow` login; set by ci-worker and
 * the AI environments), and are skipped without it.
 */
jest.setTimeout(180_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const CREWFLOW_URL = process.env.TEST_DATABASE_CREWFLOW_URL?.trim();
const itIfCrewflow = CREWFLOW_URL ? it : it.skip;

const FUTURE = 'CompatFutureRollback9999999999999';
/** Subdomain prefixes of this suite's workspace fixtures (c1 / c2). Every one of them is deleted again (see removeCompatWorkspaces). */
const COMPAT_WORKSPACE_LABELS = ['compat-behind-', 'compat-current-'] as const;
const INTERLEAVED = 'CompatOtherBranch1786000000001';
const quiet = () => undefined;

function gateOptions(url: string, extra: Partial<RunBootGatesOptions> = {}): RunBootGatesOptions {
  return { env: { NODE_ENV: 'test' }, connectionEnv: { NODE_ENV: 'test', PG_DATABASE_URL: url }, retry: { attempts: 1 }, log: quiet, ...extra };
}

/**
 * Test hygiene (Phase D wave 4): deletes this suite's workspace fixtures completely, as the bootstrap superuser, in ONE
 * transaction — the workspace schema, its registry row and the workspace (its host_label_claim cascades). What stays is inert
 * and append-only by design: the migration ledger, the released_host_label quarantine row, and the organisation + owner
 * (audit_log is insert-only, so an organisation delete cascading into it is refused). A forged registry row (module_version without the matching ledger) must never
 * outlive the suite: the real workspace migrator rightly refuses such a workspace (LEDGER_GAP) and would fail closed on the
 * next chain run. Called in beforeAll (a run that was killed) and afterAll (always). Matches only the two fixture prefixes.
 */
async function removeCompatWorkspaces(admin: Client): Promise<number> {
  const patterns = COMPAT_WORKSPACE_LABELS.map((p) => `${p}%`);
  const { rows } = await admin.query<{ id: string; organisation_id: string; owner_user_id: string }>(
    `SELECT id, organisation_id, owner_user_id FROM core.manager_workspace WHERE subdomain::text LIKE ANY ($1::text[])`,
    [patterns],
  );
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  await admin.query('BEGIN');
  try {
    for (const id of ids) await admin.query(`DROP SCHEMA IF EXISTS workspace_${id.replace(/-/g, '')} CASCADE`);
    // core.workspace_schema_migration is append-only (its trigger refuses DELETE, even here) and is left as is: with the
    // workspace and its registry row gone, the migrator (which walks core.worker_list_workspaces) never visits those rows.
    await admin.query('DELETE FROM core.workspace_schema_registry WHERE workspace_id = ANY ($1::uuid[])', [ids]);
    // The workspace row itself (cascades its host_label_claim, memberships, pointers ...). Its organisation and owner stay:
    // provisioning wrote audit_log rows for them, and audit_log is insert-only — an organisation delete cascading into it is
    // refused even for the superuser (rightly). They are inert: no workspace, no registry row, nothing for any migrator.
    await admin.query('DELETE FROM core.manager_workspace WHERE id = ANY ($1::uuid[])', [ids]);
    // The host_label_sync trigger quarantines each subdomain (core.released_host_label, append-only: rows are never
    // deleted). This suite's labels carry a random suffix, so the quarantine never collides with a later run.
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  return ids.length;
}

async function refusal(promise: Promise<unknown>): Promise<DatabaseBootGateError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DatabaseBootGateError);
  expect((error as Error).message).not.toMatch(/postgres:\/\//);
  return error as DatabaseBootGateError;
}

describeIfDb('schema-version compatibility gates (integration, disposable test database)', () => {
  const { appUrl, adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  let admin: Client;

  const withLedgerRow = async (name: string, timestamp: number, fn: () => Promise<void>) => {
    await admin.query('INSERT INTO core.migrations("timestamp", name) VALUES ($1, $2)', [timestamp, name]);
    try {
      await fn();
    } finally {
      await admin.query('DELETE FROM core.migrations WHERE name = $1', [name]);
    }
  };

  /** rab-migrate's locked runner, as deploy-prepare calls it, with the disposable cluster's bootstrap superuser. */
  const migrateRun = (mode: 'apply' | 'check', log: string[] = []) =>
    runLockedMigrations({
      label: 'compat-spec',
      env: { NODE_ENV: 'test', DB_TARGET: 'test', PG_DATABASE_URL: adminUrl },
      dotenvValues: {},
      mode,
      requireMigrationIdentity: true,
      log: (line) => log.push(line),
    });

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    // A leftover from an interrupted run would poison every case below.
    await admin.query('DELETE FROM core.migrations WHERE name = ANY($1)', [[FUTURE, INTERLEAVED]]);
  });

  afterAll(async () => {
    await admin.end();
  });

  it('a current database: the API, Worker and CLI pass with no compatibility warning; the provision function is the code\'s module', async () => {
    for (const [p, extra] of [
      ['api', {}],
      ['worker', {}],
      ['cli', { cliCommand: 'storage:reconcile' }],
    ] as const) {
      const report = await runDatabaseBootGates(p, gateOptions(appUrl, extra));
      expect(report.warnings.join()).not.toMatch(/AHEAD|provision_workspace/);
      expect(report.expectedMigrations).toHaveLength((await admin.query('SELECT count(*)::int AS n FROM core.migrations')).rows[0].n);
    }
    const app = new Client({ connectionString: appUrl });
    await app.connect();
    try {
      const fn = await readProvisionFunctionState(async (sql, params) => (await app.query(sql, params as unknown[])).rows);
      // The literal of the code's LATEST module (from the frozen map; not hard-coded, so a new module cannot strand it).
      const latestLiterals = Object.entries(PROVISION_FUNCTION_MODULE_VERSIONS).filter(([, v]) => v === LATEST_WORKSPACE_MODULE_VERSION).map(([k]) => k);
      expect(latestLiterals).toHaveLength(1);
      expect(fn).toEqual({ state: 'known', literal: latestLiterals[0], moduleVersion: LATEST_WORKSPACE_MODULE_VERSION });
    } finally {
      await app.end();
    }
    await expect(migrateRun('check')).resolves.toMatchObject({ pendingBefore: [] });
  });

  itIfCrewflow('a current database: the provisioner gate passes as crewflow (and refuses crewflow_app)', async () => {
    await expect(runDatabaseBootGates('provisioner', gateOptions(CREWFLOW_URL!))).resolves.toMatchObject({ role: 'crewflow', processName: 'provisioner' });
    const wrongRole = await refusal(runDatabaseBootGates('provisioner', gateOptions(appUrl)));
    expect(wrongRole.gate).toBe('role');
  });

  it('(b1) a FUTURE ledger row (image rollback): API, Worker and CLI start with a warning; rab-migrate apply refuses, check warns', async () => {
    await withLedgerRow(FUTURE, 9999999999999, async () => {
      for (const [p, extra] of [
        ['api', {}],
        ['worker', {}],
        ['cli', { cliCommand: 'storage:reconcile' }],
      ] as const) {
        const lines: string[] = [];
        const report = await runDatabaseBootGates(p, gateOptions(appUrl, { ...extra, log: (l) => lines.push(l) }));
        expect(report.warnings.join()).toMatch(new RegExp(`AHEAD of this code by 1 migration\\(s\\): ${FUTURE}`));
        expect(lines.join('\n')).toMatch(/WARNING .*AHEAD/);
      }
      // The API prestart (check-pending-migrations.ts): the runtime DataSource options, the same assessment, a warning.
      const prestart = new DataSource({ ...coreDataSourceOptions, name: 'compat-spec-prestart' });
      await prestart.initialize();
      try {
        const a = await assertNoPendingMigrations(prestart, 'API server', { process: 'api', production: false });
        expect(a.unknownNewer).toEqual([FUTURE]);
        expect(a.warnings).toHaveLength(1);
      } finally {
        await prestart.destroy();
      }
      await expect(migrateRun('apply')).rejects.toThrow(new RegExp(`Refusing to start the migration run \\(compat-spec\\): the migration ledger is AHEAD.*${FUTURE}`));
      const log: string[] = [];
      await expect(migrateRun('check', log)).resolves.toMatchObject({ pendingBefore: [], applied: [] });
      expect(log.join('\n')).toMatch(/WARNING: the migration ledger is AHEAD/);
    });
  });

  itIfCrewflow('(b1) a FUTURE ledger row: the provisioner refuses to start', async () => {
    await withLedgerRow(FUTURE, 9999999999999, async () => {
      const error = await refusal(runDatabaseBootGates('provisioner', gateOptions(CREWFLOW_URL!)));
      expect(error.gate).toBe('schema-compatibility');
      expect(error.message).toMatch(new RegExp(`AHEAD of this code by 1 migration\\(s\\): ${FUTURE}`));
    });
  });

  it('(b2) an INTERLEAVED unknown ledger row: API, Worker, CLI and rab-migrate (both modes) refuse; a retired name is accepted', async () => {
    await withLedgerRow(INTERLEAVED, 1786000000001, async () => {
      for (const [p, extra] of [
        ['api', {}],
        ['worker', {}],
        ['cli', { cliCommand: 'storage:reconcile' }],
      ] as const) {
        const error = await refusal(runDatabaseBootGates(p, gateOptions(appUrl, extra)));
        expect(error.gate).toBe('schema-compatibility');
        expect(error.message).toMatch(new RegExp(`${INTERLEAVED}.*another branch's migration chain or the wrong database`));
      }
      await expect(migrateRun('apply')).rejects.toThrow(/another branch's migration chain/);
      await expect(migrateRun('check')).rejects.toThrow(/another branch's migration chain/);

      const app = new Client({ connectionString: appUrl });
      await app.connect();
      try {
        const query = async (sql: string, params?: unknown[]) => (await app.query(sql, params as unknown[])).rows;
        const migrations = (await admin.query('SELECT name FROM core.migrations WHERE name <> $1', [INTERLEAVED])).rows.map((r) => r.name as string);
        await expect(checkSchemaCompatibility(query, { process: 'api', production: true, expected: migrations, label: 'api process', retired: [INTERLEAVED] })).resolves.toMatchObject({
          retiredPresent: [INTERLEAVED],
          warnings: [],
        });
      } finally {
        await app.end();
      }
    });
  });

  itIfCrewflow('(b2) an INTERLEAVED unknown ledger row: the provisioner refuses too', async () => {
    await withLedgerRow(INTERLEAVED, 1786000000001, async () => {
      expect((await refusal(runDatabaseBootGates('provisioner', gateOptions(CREWFLOW_URL!)))).gate).toBe('schema-compatibility');
    });
  });

  describe('workspace module version (c1 / c2)', () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    let behind: SeededWorkspace;
    let current: SeededWorkspace;

    /**
     * The post-check reports the WHOLE fleet: on the shared CI database other suites leave READY workspaces of their own
     * (some at older module versions), so these cases compare against the fleet's findings just before the change and
     * assert the delta this suite caused (its own workspace counted and named), never a fleet that holds only its rows.
     */
    const postCheck = () => crewflowQuery((q) => schemaCompatibilityPostCheckProblems(q));
    const finding = (problems: readonly string[], kind: 'workspace-behind' | 'workspace-ahead') => {
      const text = problems.find((p) => p.startsWith(`schema-compatibility ${kind}: `));
      return { text, count: text ? Number(/: (\d+) READY workspace/.exec(text)?.[1]) : 0 };
    };
    const without = (problems: readonly string[], kind: string) => problems.filter((p) => !p.startsWith(`schema-compatibility ${kind}: `));
    /** The finding lists at most 5 workspaces (schema-compatibility.ts `show`); a named check needs the list complete. */
    const expectListed = (f: { text?: string; count: number }, entry: string) => {
      if (f.count <= 5) expect(f.text).toContain(entry);
    };

    /** One module below the routing floor: what this code refuses to route. */
    const INCOMPATIBLE = MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION - 1;
    const setModule = (ws: SeededWorkspace, v: number) => admin.query('UPDATE core.workspace_schema_registry SET module_version = $2 WHERE workspace_id = $1', [ws.id, v]);
    /**
     * The module version each fixture REALLY reached (read right after provisioning). Every forged value is restored to
     * this, never to LATEST_WORKSPACE_MODULE_VERSION: the code's LATEST can be ahead of the database's provision function
     * (a gated workspace module), and a registry row above its ledger is exactly what the real migrator refuses.
     */
    const provisioned = new Map<string, number>();
    const restoreModule = (ws: SeededWorkspace) => setModule(ws, provisioned.get(ws.id)!);

    /** SchemaResolverService over the restricted runtime role, organisation bound, cache pass-through. */
    const resolveAsApp = async (ws: SeededWorkspace): Promise<string> => {
      const app = new Client({ connectionString: appUrl });
      await app.connect();
      try {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [ws.org, ws.owner]);
        const manager = { query: async (sql: string, params?: unknown[]) => (await app.query(sql, params as unknown[])).rows } as unknown as EntityManager;
        const resolver = new SchemaResolverService({ resolveSchema: (_id: string, fetch: () => Promise<unknown>) => fetch(), invalidate: async () => undefined } as never);
        return await resolver.resolve(manager, ws.id);
      } finally {
        await app.query('ROLLBACK').catch(() => undefined);
        await app.end();
      }
    };

    const crewflowQuery = async <T>(fn: (q: (sql: string, params?: unknown[]) => Promise<unknown[]>) => Promise<T>): Promise<T> => {
      const c = new Client({ connectionString: CREWFLOW_URL ?? adminUrl });
      await c.connect();
      try {
        if (!CREWFLOW_URL) await c.query('SET ROLE crewflow');
        return await fn(async (sql, params) => (await c.query(sql, params as unknown[])).rows);
      } finally {
        await c.end();
      }
    };

    beforeAll(async () => {
      await removeCompatWorkspaces(admin); // a killed earlier run
      behind = await seedWorkspace(admin, `compat-behind-${suffix}`);
      current = await seedWorkspace(admin, `compat-current-${suffix}`);
      expect(await provisionServerPath(appUrl, behind)).toBe('READY');
      expect(await provisionServerPath(appUrl, current)).toBe('READY');
      for (const ws of [behind, current]) {
        const version = (await admin.query('SELECT module_version FROM core.workspace_schema_registry WHERE workspace_id = $1', [ws.id])).rows[0]?.module_version;
        expect(Number.isInteger(version)).toBe(true);
        provisioned.set(ws.id, version);
      }
      // The cases below assume the database provisions at the code's LATEST module (c1: LATEST-1 is "behind").
      expect([...provisioned.values()]).toEqual([LATEST_WORKSPACE_MODULE_VERSION, LATEST_WORKSPACE_MODULE_VERSION]);
    });

    afterAll(async () => {
      // Always: no fixture (and no forged registry row) outlives the suite.
      await removeCompatWorkspaces(admin);
      const ids = [behind, current].filter(Boolean).map((ws) => ws.id);
      const left = await admin.query(
        `SELECT (SELECT count(*) FROM core.manager_workspace WHERE subdomain::text LIKE ANY ($1::text[]) OR id = ANY ($2::uuid[]))
              + (SELECT count(*) FROM core.workspace_schema_registry WHERE workspace_id = ANY ($2::uuid[]))
              + (SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname = ANY ($3::text[])) AS n`,
        [COMPAT_WORKSPACE_LABELS.map((p) => `${p}%`), ids, [behind, current].filter(Boolean).map((ws) => ws.schema)],
      );
      if (Number(left.rows[0].n) !== 0) throw new Error(`schema-compatibility fixtures left behind: ${left.rows[0].n}`);
    });

    it('(c1) a READY workspace below the compatibility floor: routing refuses THAT workspace (503), the other one routes', async () => {
      const before = await postCheck();
      expect(before.join('\n')).not.toContain(behind.id);
      // Below MIN_COMPATIBLE (not simply LATEST-1: a release may keep LATEST-1 routable when the newest module is additive,
      // as Phase D does for module 19 — asserted separately below).
      await setModule(behind, INCOMPATIBLE);
      try {
        const error = await resolveAsApp(behind).then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(WorkspaceRoutingError);
        expect((error as WorkspaceRoutingError).code).toBe('incompatible-module');
        const json = jest.fn();
        const status = jest.fn(() => ({ json }));
        new AllExceptionsFilter({ captureExceptions: () => [] } as unknown as ExceptionHandlerService).catch(error, { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as unknown as ArgumentsHost);
        expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);

        await expect(resolveAsApp(current)).resolves.toBe(current.schema);

        // rab-migrate's post-check would not promote this release.
        const problems = await postCheck();
        const behindNow = finding(problems, 'workspace-behind');
        expect(behindNow.text).toMatch(new RegExp(`^schema-compatibility workspace-behind: \\d+ READY workspace\\(s\\) are below module ${LATEST_WORKSPACE_MODULE_VERSION}: `));
        expect(behindNow.count).toBe(finding(before, 'workspace-behind').count + 1);
        expectListed(behindNow, `${behind.id}@${INCOMPATIBLE}`);
        expect(behindNow.text).not.toContain(current.id);
        expect(without(problems, 'workspace-behind')).toEqual(without(before, 'workspace-behind'));
      } finally {
        await restoreModule(behind);
      }
      expect(await postCheck()).toEqual(before);
    });

    it('(c1b) a READY workspace at LATEST-1 but at/above the compatibility floor stays routable; the post-check still reports it behind', async () => {
      if (MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION >= LATEST_WORKSPACE_MODULE_VERSION) return; // floor = LATEST: (c1) covers LATEST-1
      const before = await postCheck();
      await setModule(behind, LATEST_WORKSPACE_MODULE_VERSION - 1);
      try {
        await expect(resolveAsApp(behind)).resolves.toBe(behind.schema);
        const behindNow = finding(await postCheck(), 'workspace-behind');
        expect(behindNow.count).toBe(finding(before, 'workspace-behind').count + 1);
        expectListed(behindNow, `${behind.id}@${LATEST_WORKSPACE_MODULE_VERSION - 1}`);
      } finally {
        await restoreModule(behind);
      }
      expect(await postCheck()).toEqual(before);
    });

    it('(c2) a READY workspace one module AHEAD: the API routes it (and does not scan the fleet at boot); the provisioner refuses to start', async () => {
      const before = await postCheck();
      await setModule(current, LATEST_WORKSPACE_MODULE_VERSION + 1);
      try {
        await expect(resolveAsApp(current)).resolves.toBe(current.schema);
        await expect(runDatabaseBootGates('api', gateOptions(appUrl))).resolves.toBeDefined();
        const problems = await postCheck();
        const aheadNow = finding(problems, 'workspace-ahead');
        expect(aheadNow.count).toBe(finding(before, 'workspace-ahead').count + 1);
        expectListed(aheadNow, `${current.id}@${LATEST_WORKSPACE_MODULE_VERSION + 1}`);
        expect(without(problems, 'workspace-ahead')).toEqual(without(before, 'workspace-ahead'));
        if (CREWFLOW_URL) {
          const error = await refusal(runDatabaseBootGates('provisioner', gateOptions(CREWFLOW_URL)));
          expect(error.gate).toBe('schema-compatibility');
          expect(error.message).toMatch(new RegExp(`above this code's module ${LATEST_WORKSPACE_MODULE_VERSION}: ${current.id}@${LATEST_WORKSPACE_MODULE_VERSION + 1}`));
        }
      } finally {
        await restoreModule(current);
      }
      expect(await postCheck()).toEqual(before);
    });
  });
});
