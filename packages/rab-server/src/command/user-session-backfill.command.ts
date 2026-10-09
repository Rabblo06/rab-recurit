import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';

import { UserSessionBackfillService } from '../engine/core-modules/auth/token/backfill/user-session-backfill.service';

interface Options {
  batch?: number;
  dryRun?: boolean;
  apply?: boolean;
  verify?: boolean;
}

/**
 * `user-session:backfill` — P1B's backfill from existing `core.refresh_token` families to
 * `core.user_session` rows, for sessions created before this phase shipped. See
 * `UserSessionBackfillService`'s own doc comment for the full algorithm (consistency check,
 * fail-closed, terminal-state derivation, idempotency).
 *
 * Needs an owner (`rab_owner`) connection for BOTH the candidate scan (an unfiltered,
 * cross-organisation read of `core.refresh_token`, which only the table owner can do) and the
 * per-family write (`core.user_session`, FORCE RLS — bound to each family's own identity before
 * its own insert, never a bypass). `DATABASE_URL_UNPOOLED` is this package's existing `rab_owner`
 * convention (`BootstrapAdminCommand`, `provisionWorkspaceSchema`, `hws:backfill`).
 *
 * `DB_TARGET` and the production-command safeguards already run globally in
 * `command/main.ts`'s `bootstrap()` before this command's `run()` — nothing extra needed here.
 *
 * Modes (mutually exclusive; `--dry-run` is the default — report-only, zero writes):
 *   --dry-run   report only — candidate families, consistency outcome, zero writes
 *   --apply     writes `core.user_session` rows (idempotent — re-running reports
 *               already-present, never duplicates)
 *   --verify    cross-organisation PASS/FAIL count (see `count_user_session_backfill_status()`)
 */
@Command({
  name: 'user-session:backfill',
  description: 'Backfill core.user_session rows for existing refresh_token families (dry-run by default)',
})
export class UserSessionBackfillCommand extends CommandRunner {
  constructor(private readonly backfill: UserSessionBackfillService) {
    super();
  }

  @Option({ flags: '--batch <n>', description: 'Bound on how many families are scanned per run (default 500)' })
  parseBatch(value: string): number {
    return Number(value);
  }

  @Option({ flags: '--dry-run', description: 'Report only, zero writes (default if no mode flag is given)' })
  parseDryRun(): boolean {
    return true;
  }

  @Option({ flags: '--apply', description: "MODIFIES: write core.user_session rows for consistent, not-yet-backfilled families" })
  parseApply(): boolean {
    return true;
  }

  @Option({ flags: '--verify', description: 'Report cross-organisation backfill completeness; no writes' })
  parseVerify(): boolean {
    return true;
  }

  async run(_params: string[], options: Options): Promise<void> {
    const modesRequested = [options.dryRun, options.apply, options.verify].filter(Boolean).length;
    if (modesRequested > 1) throw new Error('--dry-run, --apply and --verify are mutually exclusive — pass exactly one.');
    const mode: 'dry-run' | 'apply' | 'verify' = options.verify ? 'verify' : options.apply ? 'apply' : 'dry-run';
    const batchSize = options.batch && options.batch > 0 ? options.batch : 500;

    if (!process.env.DATABASE_URL_UNPOOLED) {
      throw new Error('DATABASE_URL_UNPOOLED is required (the rab_owner connection this backfill needs for both the scan and the write).');
    }
    const ownerDataSource = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL_UNPOOLED, entities: [], synchronize: false, logging: false });
    await ownerDataSource.initialize();
    this.backfill.ownerDataSource = ownerDataSource;
    try {
      // eslint-disable-next-line no-console
      console.log(`[user-session:backfill] mode=${mode} batch=${batchSize}`);
      if (mode === 'verify') {
        const result = await this.backfill.verify();
        // eslint-disable-next-line no-console
        console.log(`  total=${result.totalFamilies} backfilled=${result.backfilled} missing=${result.missing} PASS=${result.pass}`);
        return;
      }
      const result = await this.backfill.run({ dryRun: mode === 'dry-run', batchSize });
      // eslint-disable-next-line no-console
      console.log(
        `  scanned=${result.candidatesScanned} inserted=${result.inserted} alreadyPresent=${result.alreadyPresent} failedClosed=${result.failedClosed}`,
      );
      for (const family of result.families) {
        if (family.outcome === 'skipped-inconsistent') {
          // eslint-disable-next-line no-console
          console.warn(`  BLOCKED family=${family.familyId}: ${family.reason}`);
        }
      }
    } finally {
      await ownerDataSource.destroy();
      this.backfill.ownerDataSource = undefined;
    }
  }
}
