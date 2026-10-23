import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { DataSource } from 'typeorm';

import { GuardedMigrationDataSource } from './core.datasource';
import {
  assertProductionMigrationApproval,
  isApprovedForProduction,
  PRODUCTION_APPROVED_MIGRATIONS,
  PRODUCTION_APPROVED_THROUGH,
  UnapprovedProductionMigrationError,
} from './production-migration-approval';

const MIGRATIONS_DIR = join(__dirname, 'migrations');
/** `1786719400000-OfferKind.ts` -> `OfferKind1786719400000`, the name TypeORM records in core.migrations. */
const migrationNames = readdirSync(MIGRATIONS_DIR)
  .map((f) => /^(\d{13})-(.+)\.ts$/.exec(f))
  .filter((m): m is RegExpExecArray => m !== null)
  .map((m) => `${m[2]}${m[1]}`);

/** Development-only migrations of 2026-10-22 (N1). None may be applied to production without an explicit approval. */
const DEV_ONLY = [
  'OfferKind1786719400000',
  'AttendanceCheckIn1786719450000',
  'ServerPathWorkspaceProvisioning1786719500000',
  'WorkspaceBoundChecksForLaterTables1786719510000',
  'HwsHistoricalRowsPrivilegedCopy1786719520000',
  'ReconcileSuperuserOwnedCoreObjects1786719600000',
  'AuditLogRecordedIdentityOrganisationCheck1786719610000',
  'BootstrapFirstPlatformAdminFunction1786719620000',
];

describe('production migration approval (N1): pure decision', () => {
  const baseline = 'ManagerMarkPaidInitialManagerCalendar1786719300000';

  it('local and test targets apply anything, unchanged', () => {
    for (const target of ['local', 'test'] as const) {
      expect(() => assertProductionMigrationApproval({ target, pendingMigrationNames: DEV_ONLY })).not.toThrow();
    }
  });

  it('production allows the reviewed release baseline', () => {
    expect(() => assertProductionMigrationApproval({ target: 'production', pendingMigrationNames: [baseline] })).not.toThrow();
    expect(() => assertProductionMigrationApproval({ target: 'production', pendingMigrationNames: [] })).not.toThrow();
  });

  it('production refuses the whole run and names every unapproved migration', () => {
    let error: unknown;
    try {
      assertProductionMigrationApproval({ target: 'production', pendingMigrationNames: [baseline, ...DEV_ONLY] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnapprovedProductionMigrationError);
    const message = (error as Error).message;
    for (const name of DEV_ONLY) expect(message).toContain(name);
    expect(message).not.toContain(baseline);
    expect(message).toContain('Nothing was applied');
  });

  it('an explicit by-name approval admits exactly that migration', () => {
    const approved = new Set(['OfferKind1786719400000']);
    expect(() =>
      assertProductionMigrationApproval({ target: 'production', pendingMigrationNames: ['OfferKind1786719400000'], approved }),
    ).not.toThrow();
    expect(() =>
      assertProductionMigrationApproval({
        target: 'production',
        pendingMigrationNames: ['OfferKind1786719400000', 'AttendanceCheckIn1786719450000'],
        approved,
      }),
    ).toThrow(/AttendanceCheckIn1786719450000/);
  });

  it('fails closed: unknown or staging target is restricted; a name without a timestamp is never approved', () => {
    expect(() => assertProductionMigrationApproval({ target: undefined, pendingMigrationNames: DEV_ONLY })).toThrow(
      UnapprovedProductionMigrationError,
    );
    expect(() => assertProductionMigrationApproval({ target: 'staging', pendingMigrationNames: DEV_ONLY })).toThrow(
      UnapprovedProductionMigrationError,
    );
    expect(isApprovedForProduction('NoTimestamp')).toBe(false);
    expect(isApprovedForProduction('Short123')).toBe(false);
  });
});

describe('production migration approval (N1): the reviewed list against the migrations directory', () => {
  it('the baseline covers exactly the 186 migrations of the reviewed release (origin/main 5968fc52)', () => {
    const baseline = migrationNames.filter((n) => isApprovedForProduction(n, PRODUCTION_APPROVED_THROUGH, new Set()));
    expect(baseline).toHaveLength(186);
    expect(baseline).toContain('ManagerMarkPaidInitialManagerCalendar1786719300000');
  });

  it('none of the 2026-10-22 development-only migrations is approved for production', () => {
    for (const name of DEV_ONLY) expect(isApprovedForProduction(name)).toBe(false);
  });

  it('every migration after the baseline in the directory is unapproved unless named explicitly', () => {
    for (const name of migrationNames) {
      const afterBaseline = Number(name.slice(-13)) > PRODUCTION_APPROVED_THROUGH;
      if (afterBaseline) expect(isApprovedForProduction(name)).toBe(PRODUCTION_APPROVED_MIGRATIONS.has(name));
    }
  });

  it('every by-name approval refers to a migration that exists', () => {
    for (const name of PRODUCTION_APPROVED_MIGRATIONS) expect(migrationNames).toContain(name);
  });
});

describe('GuardedMigrationDataSource: runner refusal (N1)', () => {
  afterEach(() => jest.restoreAllMocks());

  /** Loaded migrations: the reviewed baseline from the directory plus the development-only ones (whether or not present yet). */
  const loaded = [...migrationNames.filter((n) => isApprovedForProduction(n)), ...DEV_ONLY];

  /** A runner whose database calls are stubbed: ledger present, `applied` recorded, `loaded` migrations loaded. */
  function runnerFor(target: string | undefined, applied: string[]) {
    const ds = new GuardedMigrationDataSource({ type: 'postgres', url: 'postgres://unused@127.0.0.1:1/unused' });
    const internals = ds as unknown as Record<string, unknown>;
    internals.dbTarget = target;
    Object.defineProperty(ds, 'migrations', { value: loaded.map((name) => ({ name, up: jest.fn(), down: jest.fn() })) });
    const query = jest.fn(async (sql: string) => (/to_regclass/.test(sql) ? [{ hasLedger: true }] : applied.map((name) => ({ name }))));
    internals.query = query;
    const identity = jest.fn(async () => undefined);
    internals.assertIdentityForPendingMigrations = identity;
    const run = jest.spyOn(DataSource.prototype, 'runMigrations').mockResolvedValue([]);
    return { ds, run, identity };
  }

  const baselineApplied = migrationNames.filter((n) => isApprovedForProduction(n));

  it('production with unapproved pending migrations: refuses before the identity check and before any migration runs', async () => {
    const { ds, run, identity } = runnerFor('production', baselineApplied);
    await expect(ds.runMigrations()).rejects.toThrow(/HwsHistoricalRowsPrivilegedCopy1786719520000/);
    expect(identity).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('production with only approved migrations pending proceeds', async () => {
    const { ds, run } = runnerFor('production', [...baselineApplied.slice(0, -1), ...DEV_ONLY]);
    await expect(ds.runMigrations()).resolves.toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('test target with the same pending migrations proceeds unchanged', async () => {
    const { ds, run, identity } = runnerFor('test', baselineApplied);
    await expect(ds.runMigrations()).resolves.toEqual([]);
    expect(identity).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a runner whose target was never established is treated as restricted', async () => {
    const { ds, run } = runnerFor(undefined, baselineApplied);
    await expect(ds.runMigrations()).rejects.toThrow(UnapprovedProductionMigrationError);
    expect(run).not.toHaveBeenCalled();
  });
});
