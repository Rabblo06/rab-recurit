/**
 * OWNER-DB-ULTIMATE Part D, owner condition D6: seed N workspaces (default 1,000) on a DISPOSABLE test database and measure the
 * workspace command runner's per-workspace cost: adoption (structure check + one row) and a no-op data step (every post-step
 * check), with the time of each check query. Refuses anything but the disposable test database (resolveIntegrationTestDatabase,
 * NODE_ENV=test). Prints numbers only (no URL, no secret).
 *
 *   NODE_ENV=test TEST_DATABASE_URL=… TEST_DATABASE_URL_UNPOOLED=… PERF_WORKSPACES=1000 \
 *     ts-node --transpile-only -P packages/rab-server/tsconfig.app.json packages/rab-server/src/__tests__/perf/workspace-runner-perf.ts
 * Phases (PERF_PHASE): seed | measure | all (default).
 */
import 'reflect-metadata';
import { Client } from 'pg';

import { integrationTestDatabase } from '../../database/typeorm/core/integration-test-database-gate';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { EXPECTED_WORKSPACE_FINGERPRINTS, selectWorkspaceFingerprintsForServer } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { provisionWorkspaceSchema } from '../../database/typeorm/workspace-schema/provision-workspace-schema';
import type { WorkspaceUpgradeCommand } from '../../engine/core-modules/upgrade/upgrade-commands/workspace-upgrade-command';
import { upgradeSessionOf, UpgradeSession } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { WorkspaceCommandRunner } from '../../engine/core-modules/upgrade/workspace-command-runner';

const N = Number.parseInt(process.env.PERF_WORKSPACES ?? '1000', 10);
const PHASE = process.env.PERF_PHASE ?? 'all';
const PREFIX = 'perf-ws';
const out = (line: string) => process.stdout.write(`[d6] ${line}\n`);

// Default 1: parallel provisioning deadlocks in the provisioning functions (observed with 3 on PG16), so seeding is serial.
const CONCURRENCY = Math.max(1, Math.min(4, Number.parseInt(process.env.PERF_SEED_CONCURRENCY ?? '1', 10)));

async function seed(adminUrl: string): Promise<void> {
  const probe = new Client({ connectionString: adminUrl });
  await probe.connect();
  const have = Number((await probe.query(`SELECT count(*)::int AS n FROM core.organisation WHERE slug LIKE $1`, [`${PREFIX}-%`])).rows[0].n);
  await probe.end();
  out(`seed: ${have} already present, target ${N}, ${CONCURRENCY} parallel seeder(s)`);
  const t0 = Date.now();
  let next = have;
  let done = have;
  await Promise.all(Array.from({ length: CONCURRENCY }, () => seedWorker(adminUrl, () => (next < N ? next++ : null), () => {
    done += 1;
    if (done % 100 === 0) out(`seed: ${done}/${N} (${Math.round((Date.now() - t0) / 1000)} s)`);
  })));
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const stats = (await admin.query(`SELECT (SELECT count(*) FROM pg_class)::int AS classes, (SELECT count(*) FROM pg_attribute)::int AS attributes,
                                           pg_size_pretty(pg_database_size(current_database())) AS size`)).rows[0];
  out(`seed done in ${Math.round((Date.now() - t0) / 1000)} s: pg_class ${stats.classes}, pg_attribute ${stats.attributes}, database ${stats.size}`);
  await admin.end();
}

async function seedWorker(adminUrl: string, take: () => number | null, tick: () => void): Promise<void> {
  let admin: Client | null = null;
  let crewflow: Client | null = null;
  let k = 0;
  for (let i = take(); i !== null; i = take()) {
    if (!crewflow || !admin || k % 50 === 0) {
      // A fresh backend every 50 workspaces bounds the per-backend catalog caches (the host is a 4 GB VM).
      await crewflow?.end();
      await admin?.end();
      crewflow = new Client({ connectionString: adminUrl });
      await crewflow.connect();
      await crewflow.query('SET ROLE crewflow');
      admin = new Client({ connectionString: adminUrl });
      await admin.connect();
    }
    k += 1;
    const label = `${PREFIX}-${String(i).padStart(5, '0')}`;
    const r = await admin.query(
      `WITH o AS (INSERT INTO core.organisation(name, slug) VALUES ($1::text, $1::text) RETURNING id),
            u AS (INSERT INTO core."user"(organisation_id, email, first_name, last_name, status)
                  SELECT id, $1::text || '@perf.invalid', 'Perf', 'Owner', 'active' FROM o RETURNING id, organisation_id)
       INSERT INTO core.manager_workspace(organisation_id, owner_user_id, name, subdomain, status, schema_status)
       SELECT organisation_id, id, $1::text, $1::text, 'active', 'CREATING' FROM u RETURNING id`,
      [label],
    );
    await provisionWorkspaceSchema(crewflow, r.rows[0].id);
    tick();
  }
  await crewflow?.end();
  await admin?.end();
}

/** Wraps the session: time per statement kind (the first 48 characters, collapsed). */
function timed(session: UpgradeSession): { session: UpgradeSession; totals: Map<string, { n: number; ms: number }> } {
  const totals = new Map<string, { n: number; ms: number }>();
  return {
    totals,
    session: {
      upgradeSession: true,
      query: async (sql, params) => {
        const t = process.hrtime.bigint();
        try {
          return await session.query(sql, params);
        } finally {
          const key = sql.replace(/\s+/g, ' ').trim().slice(0, 48);
          const e = totals.get(key) ?? { n: 0, ms: 0 };
          e.n += 1;
          e.ms += Number(process.hrtime.bigint() - t) / 1e6;
          totals.set(key, e);
        }
      },
    },
  };
}

async function measure(appUrl: string, adminUrl: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const ids = (await admin.query(
    `SELECT w.id FROM core.manager_workspace w JOIN core.organisation o ON o.id = w.organisation_id WHERE o.slug LIKE $1 ORDER BY w.id`,
    [`${PREFIX}-%`],
  )).rows.map((r: { id: string }) => r.id);
  await admin.end();
  const app = new Client({ connectionString: appUrl });
  await app.connect();
  await selectWorkspaceFingerprintsForServer(async (sql) => (await app.query(sql)).rows);
  await app.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY.toString()]);
  const base = upgradeSessionOf(app);
  const run = async (label: string, opts: Partial<ConstructorParameters<typeof WorkspaceCommandRunner>[0]>) => {
    const { session, totals } = timed(base);
    const t0 = Date.now();
    const report = await new WorkspaceCommandRunner({
      codeVersion: '0.7.0',
      versions: ['0.4.0', '0.5.0', '0.6.0'],
      force: false,
      adopt: false,
      log: () => undefined,
      workspaceIds: ids,
      ...opts,
    }).run(session);
    const ms = Date.now() - t0;
    out(`${label}: ${ids.length} workspaces in ${(ms / 1000).toFixed(1)} s = ${(ms / ids.length).toFixed(0)} ms per workspace; failures ${report.failures.length}`);
    const top = [...totals.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 10);
    for (const [k, v] of top) out(`   ${(v.ms / ids.length).toFixed(1).padStart(7)} ms/ws  n=${String(v.n).padStart(6)}  ${k}`);
  };
  await run('adoption (0.6.0)', { codeVersion: '0.6.0', versions: ['0.4.0', '0.5.0'], adopt: true });
  const noop: WorkspaceUpgradeCommand = { kind: 'workspace', name: 'PerfNoop', timestamp: 1786990000000, run: async () => undefined };
  await run('no-op data step (0.7.0)', { workspaceRegistry: { '0-7': [noop] } });
  // A structural step (one ADD COLUMN IF NOT EXISTS, level 21): the full catalog checks run.
  const ref = new Client({ connectionString: adminUrl });
  await ref.connect();
  const ddl = (s: string) => `ALTER TABLE ${s}.venue ADD COLUMN IF NOT EXISTS d_perf text`;
  await ref.query('BEGIN');
  await ref.query(ddl('workspace_' + ids[0]!.replace(/-/g, '')));
  const level21 = (await ref.query('SELECT core.workspace_schema_fingerprint($1) AS f', [ids[0]])).rows[0].f as string;
  await ref.query('ROLLBACK');
  await ref.end();
  const structural: WorkspaceUpgradeCommand = { kind: 'workspace', name: 'PerfColumn', timestamp: 1786990000001, sql: ddl, structure: { level: 21, fingerprints: {} } };
  await run('structural step (0.7.0, ADD COLUMN)', {
    workspaceRegistry: { '0-7': [noop, structural] },
    expectedFingerprint: (level) => (level === 21 ? level21 : EXPECTED_WORKSPACE_FINGERPRINTS[level]),
  });
  await app.end();
}

async function main(): Promise<void> {
  const { adminUrl, appUrl } = integrationTestDatabase();
  if (PHASE === 'seed' || PHASE === 'all') await seed(adminUrl);
  if (PHASE === 'measure' || PHASE === 'all') await measure(appUrl, adminUrl);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    out(`FAILED: ${error instanceof Error ? `${error.name}: ${error.message}`.replace(/postgres(ql)?:\/\/\S+/g, '<url>') : 'error'}`);
    process.exit(1);
  },
);
