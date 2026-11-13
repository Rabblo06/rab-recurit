/**
 * OWNER-DB-ULTIMATE Part B3: the upgrade sequence on the LOCKED migration session (the migrate-on-start child and the
 * manual `upgrade --force` command). Twenty: `database/commands/run-instance-commands.command.ts:124-180` (check, then
 * the pending TypeORM migrations, then the instance commands, each recorded by `upgrade-migration.service.ts`).
 * Re-implemented, not copied.
 *
 * Order of one start, every step with the migration lock held:
 *   1. beforeApply   read the logbook ('status' scope), decide (upgrade-version-check.ts); a refusal throws before anything
 *                    is applied (exit 65);
 *   2. (the runner applies the pending TypeORM migrations and runs the post-checks)
 *   3. afterApply    adoption: the one is_initial row; then `<v>_TypeOrmMigrations` completed (unless its latest attempt is
 *                    already completed); then each command of <v> whose latest attempt is not completed: run it, record
 *                    completed or failed. A failed COMMAND stops the sequence and is reported (warn and serve, exit 70);
 *   on a migration or post-check failure: `<v>_TypeOrmMigrations` failed (attempt + 1) when the table exists, then the
 *   failure propagates (refuse, exit 66 / 68). A crash writes no row: the step re-runs on the next start.
 * Every row of a forced run has forced = true. Rows are written in their own short transactions (withUpgradeScope), never
 * inside a migration's transaction, so a failed migration's rollback cannot take its own failure row with it.
 */
import type { LedgerAttribution } from '../../../database/typeorm/scripts/migrate/owner-login/release-floor';
import { UpgradeCommand } from './upgrade-commands/upgrade-command';
import { UPGRADE_COMMANDS } from './upgrade-commands/registry';
import {
  getLastAttemptedInstanceStep,
  hasInstanceRows,
  instanceVersions,
  isLastAttemptCompleted,
  markAsInstanceInitial,
  Query,
  recordUpgradeMigration,
  upgradeLedgerExists,
  withUpgradeScope,
} from './upgrade-migration.service';
import { commandsForVersion, commandStepName, lastStepOfVersion, migrationsStepName } from './upgrade-sequence';
import { decideUpgradeStart, UpgradeStartDecision, versionsToCheck } from './upgrade-version-check';
import { compareVersions } from './upgrade-version';

export interface RecordedStep {
  name: string;
  status: 'completed' | 'failed';
  attempt: number;
}

export interface UpgradeRunReport {
  codeVersion: string;
  forced: boolean;
  decision: UpgradeStartDecision['kind'] | null;
  adoptedFrom: string | null;
  recorded: RecordedStep[];
  /** Set when an upgrade COMMAND failed after every migration applied (warn and serve). */
  commandFailure: { name: string; errorName: string } | null;
}

export interface UpgradeRunOptions {
  codeVersion: string;
  force: boolean;
  log: (line: string) => void;
  registry?: Readonly<Record<string, readonly UpgradeCommand[]>>;
  /** Test seam (NODE_ENV=test + disposable database only; validated by the caller): this command name fails. */
  testFailCommand?: string | null;
}

/** One upgrade run's state, shared by the runner hooks. */
export class UpgradeRun {
  readonly report: UpgradeRunReport;
  private decision: UpgradeStartDecision | null = null;

  constructor(private readonly options: UpgradeRunOptions) {
    this.report = { codeVersion: options.codeVersion, forced: options.force, decision: null, adoptedFrom: null, recorded: [], commandFailure: null };
  }

  private get registry() {
    return this.options.registry ?? UPGRADE_COMMANDS;
  }

  /** Step 1. Throws UpgradeVersionTooOldError (65) or AppVersionError (64) before anything is applied. */
  async beforeApply(query: Query, input: { fresh: boolean; attribution: LedgerAttribution | null; unrestrictedTarget: boolean }): Promise<UpgradeStartDecision> {
    const { codeVersion, force, log } = this.options;
    const ledgerExists = await upgradeLedgerExists(query);
    const facts = ledgerExists
      ? await withUpgradeScope(query, 'status', async (q) => {
          const instance = await hasInstanceRows(q);
          const complete: Record<string, boolean> = {};
          for (const v of versionsToCheck(codeVersion)) complete[v] = await isLastAttemptCompleted(q, { name: lastStepOfVersion(v, this.registry), workspaceId: null });
          const newer = (await instanceVersions(q)).filter((v) => compareVersions(v, codeVersion) > 0);
          return { instance, complete, newer };
        })
      : { instance: false, complete: {}, newer: [] as string[] };
    const decision = decideUpgradeStart({
      codeVersion,
      fresh: input.fresh,
      force,
      ledgerExists,
      hasInstanceRows: facts.instance,
      complete: facts.complete,
      newerVersions: facts.newer,
      attribution: input.attribution,
      unrestrictedTarget: input.unrestrictedTarget,
    });
    this.decision = decision;
    this.report.decision = decision.kind;
    if (decision.kind === 'adopt') this.report.adoptedFrom = decision.initialVersion;
    log(`upgrade check (${codeVersion}${force ? ', --force' : ''}): ${decision.kind}: ${decision.reason}`);
    if (force) log('WARNING: upgrade --force: the previous-version check is skipped; every logbook row of this run is marked forced');
    return decision;
  }

  /** Step 3, after the migrations applied and the post-checks passed. Never throws for a failed COMMAND (reported instead). */
  async afterApply(query: Query): Promise<void> {
    const { codeVersion, force, log } = this.options;
    const decision = this.decision;
    if (!decision) throw new Error('upgrade run: afterApply before beforeApply');
    if (decision.kind === 'rollback') return;
    if (!(await upgradeLedgerExists(query))) throw new Error('upgrade run: core.upgrade_migration does not exist after the migrations');
    await withUpgradeScope(query, 'upgrade', async (q) => {
      if (decision.kind === 'adopt' && (await markAsInstanceInitial(q, { name: decision.initialName, executedByVersion: decision.initialVersion }))) {
        log(`adopted: is_initial row ${decision.initialName}`);
      }
    });
    const migrationsStep = migrationsStepName(codeVersion);
    await this.recordIfIncomplete(query, migrationsStep, 'completed');
    for (const command of commandsForVersion(codeVersion, this.registry)) {
      const name = commandStepName(codeVersion, command);
      const done = await withUpgradeScope(query, 'upgrade', (q) => isLastAttemptCompleted(q, { name, workspaceId: null }));
      if (done) continue;
      try {
        if (this.options.testFailCommand && this.options.testFailCommand === command.name) throw Object.assign(new Error('test seam: forced command failure'), { name: 'TestCommandFailure' });
        log(`upgrade command ${name}: running`);
        await command.run({ query, log });
      } catch (error) {
        const attempt = await withUpgradeScope(query, 'upgrade', (q) => recordUpgradeMigration(q, { name, status: 'failed', executedByVersion: codeVersion, forced: force, error }));
        this.report.recorded.push({ name, status: 'failed', attempt });
        this.report.commandFailure = { name, errorName: error instanceof Error ? error.name : 'Error' };
        log(`ERROR: upgrade command ${name} FAILED (attempt ${attempt}); the schema matches this code, so the API serves with upgrade:"failed" (exit 70). The next start retries it.`);
        return;
      }
      const attempt = await withUpgradeScope(query, 'upgrade', (q) => recordUpgradeMigration(q, { name, status: 'completed', executedByVersion: codeVersion, forced: force }));
      this.report.recorded.push({ name, status: 'completed', attempt });
    }
    log(`upgrade logbook: ${codeVersion} complete`);
  }

  /** A migration or post-check failure (lock still held). Records `<v>_TypeOrmMigrations` failed when the table exists. Never throws. */
  async onApplyFailure(query: Query, error: unknown): Promise<void> {
    const { codeVersion, force, log } = this.options;
    if (!this.decision || this.decision.kind === 'rollback') return;
    try {
      await query('ROLLBACK').catch(() => undefined); // a failed migration may leave the session in an aborted transaction
      if (!(await upgradeLedgerExists(query))) {
        log('the migration failure could not be recorded: core.upgrade_migration does not exist yet (it is created by a later migration)');
        return;
      }
      const name = migrationsStepName(codeVersion);
      const attempt = await withUpgradeScope(query, 'upgrade', (q) => recordUpgradeMigration(q, { name, status: 'failed', executedByVersion: codeVersion, forced: force, error }));
      this.report.recorded.push({ name, status: 'failed', attempt });
      log(`upgrade logbook: ${name} failed (attempt ${attempt}); the next start retries it`);
    } catch (recordError) {
      log(`WARNING: the migration failure could not be recorded (${recordError instanceof Error ? recordError.name : 'error'})`);
    }
  }

  private async recordIfIncomplete(query: Query, name: string, status: 'completed'): Promise<void> {
    const { codeVersion, force } = this.options;
    const attempt = await withUpgradeScope(query, 'upgrade', async (q) => {
      if (await isLastAttemptCompleted(q, { name, workspaceId: null })) return null;
      return recordUpgradeMigration(q, { name, status, executedByVersion: codeVersion, forced: force });
    });
    if (attempt !== null) this.report.recorded.push({ name, status, attempt });
  }
}

/** For the health read and the `upgrade` command output. */
export { getLastAttemptedInstanceStep };
