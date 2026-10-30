import 'reflect-metadata';
import { Client } from 'pg';
import { MigrationInterface, QueryRunner } from 'typeorm';

import { coreDataSourceOptions } from '../../database/typeorm/core/core.datasource';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { runLockedMigrations } from '../../database/typeorm/scripts/migrate/locked-migration-runner';
import {
  assertMigrationApproval,
  LEGACY_MIGRATION_APPROVAL,
  MigrationApprovalError,
  migrationApprovalToken,
} from '../../database/typeorm/scripts/migrate/migration-approval';

/**
 * Final review F5, on the real locked runner and the disposable test database: the approval gate runs on the pending set
 * read AFTER the migration lock, as the last gate before MigrationExecutor, so a refused approval applies nothing.
 *
 * One probe migration is added to the code's list (dataSourceOverrides), so at least that one is pending (on a database
 * that is behind this branch, the branch's own migrations are pending too; the refusal cases work either way and apply
 * nothing). Its up() only records that it ran. The approved case runs ONLY when the probe is the single pending migration
 * (a fully migrated harness database, as in CI): it lets the probe apply and deletes its ledger row again in `finally`, and
 * it never applies a real migration. Run in band, like schema-compatibility.integration.spec.ts.
 */
jest.setTimeout(180_000);

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const PROBE = 'F5ApprovalProbe9999999999998';
let probeRuns = 0;

class F5ApprovalProbe9999999999998 implements MigrationInterface {
  name = PROBE;
  async up(queryRunner: QueryRunner): Promise<void> {
    probeRuns += 1;
    await queryRunner.query('SELECT 1');
  }
  async down(): Promise<void> {
    // Nothing to undo: up() changes no schema.
  }
}

describeIfDb('F5: migration approval bound to the exact pending set (integration, disposable test database)', () => {
  const { adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  let admin: Client;

  const migrations = [...((coreDataSourceOptions.migrations as Array<string | (new () => MigrationInterface)>) ?? []), F5ApprovalProbe9999999999998];
  const run = (mode: 'apply' | 'check', approval: string | null, log: string[] = []) =>
    runLockedMigrations({
      label: 'f5-approval-spec',
      env: { NODE_ENV: 'test', DB_TARGET: 'test', PG_DATABASE_URL: adminUrl },
      dotenvValues: {},
      mode,
      requireMigrationIdentity: true,
      approvePending: approval === null ? undefined : (pending) => assertMigrationApproval(approval, pending),
      dataSourceOverrides: { migrations } as never,
      log: (line) => log.push(line),
    });
  const ledgerHasProbe = async () => ((await admin.query('SELECT 1 FROM core.migrations WHERE name = $1', [PROBE])).rowCount ?? 0) > 0;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query('DELETE FROM core.migrations WHERE name = $1', [PROBE]);
  });

  afterAll(async () => {
    await admin.query('DELETE FROM core.migrations WHERE name = $1', [PROBE]);
    await admin.end();
  });

  /** The set pending on this database (read by a check run), probe included. */
  let pendingNow: string[] = [];

  it('the check run applies nothing and reports the pending set (the probe included)', async () => {
    const result = await run('check', null);
    pendingNow = result.pendingBefore;
    expect(pendingNow).toContain(PROBE);
    expect(result.applied).toEqual([]);
    expect(await ledgerHasProbe()).toBe(false);
  });

  it('a stale token (another set), a malformed value and the retired constant are refused after the lock; nothing is applied', async () => {
    probeRuns = 0;
    const stale = pendingNow.filter((name) => name !== PROBE); // the set before the probe "release" arrived
    for (const approval of [migrationApprovalToken(stale), migrationApprovalToken(['AddThing1786000000001']), 'yes', LEGACY_MIGRATION_APPROVAL]) {
      const log: string[] = [];
      const error = await run('apply', approval, log).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(MigrationApprovalError);
      expect((error as Error).message).toContain(migrationApprovalToken(pendingNow));
      expect((error as Error).message).not.toMatch(/postgres:\/\//);
      // Refused under the lock (the lock line is logged), before MigrationExecutor ran.
      expect(log.join('\n')).toMatch(/migration lock acquired/);
      expect(log.join('\n')).not.toMatch(/gates passed after the lock/);
    }
    expect(probeRuns).toBe(0);
    expect(await ledgerHasProbe()).toBe(false);
  });

  it('the token of the set pending now applies exactly that set (only when the probe is the single pending migration)', async () => {
    if (pendingNow.length !== 1) {
      // eslint-disable-next-line no-console
      console.warn(`[f5-approval-spec] apply case not run: ${pendingNow.length} migrations are pending on this database (it is behind this branch); the spec never applies a real migration.`);
      return;
    }
    probeRuns = 0;
    try {
      const result = await run('apply', migrationApprovalToken([PROBE]));
      expect(result.pendingBefore).toEqual([PROBE]);
      expect(result.applied).toEqual([PROBE]);
      expect(probeRuns).toBe(1);
      expect(await ledgerHasProbe()).toBe(true);
      // A second identical run (one that waited behind the first) finds nothing pending: the token approves nothing.
      const again = await run('apply', migrationApprovalToken([PROBE]));
      expect(again.applied).toEqual([]);
      expect(probeRuns).toBe(1);
    } finally {
      await admin.query('DELETE FROM core.migrations WHERE name = $1', [PROBE]);
    }
  });
});
