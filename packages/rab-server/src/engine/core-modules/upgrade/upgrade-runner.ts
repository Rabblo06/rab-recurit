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
 *
 * OWNER-DB-ULTIMATE Part D: after the instance commands of <v> completed, the WORKSPACE commands of <v> run once per workspace
 * (workspace-command-runner.ts; Twenty upgrade-sequence-runner.service.ts:180-211), and on the adoption release every READY
 * workspace without a logbook row is adopted (one is_initial row). A failed workspace step is reported like a failed command
 * (warn and serve, exit 70); the other workspaces are not affected. The previous-version check also needs every workspace to
 * have completed the previous version's last workspace command (Twenty run-instance-commands.command.ts:124-168).
 */
import type { LedgerAttribution } from '../../../database/typeorm/scripts/migrate/owner-login/release-floor';
import { UpgradeCommand } from './upgrade-commands/upgrade-command';
import type { WorkspaceUpgradeCommand } from './upgrade-commands/workspace-upgrade-command';
import { UPGRADE_COMMANDS, WORKSPACE_UPGRADE_COMMANDS } from './upgrade-commands/registry';
import {
  getLastAttemptedInstanceStep,
  getWorkspaceCursors,
  hasInstanceRows,
  instanceVersions,
  isLastAttemptCompleted,
  markAsInstanceInitial,
  recordUpgradeMigration,
  UpgradeSession,
  upgradeLedgerExists,
  withUpgradeScope,
} from './upgrade-migration.service';
import { commandsForVersion, commandStepName, lastInstanceStepOfVersion, lastWorkspaceStepOfVersion, migrationsStepName, sequenceForVersions } from './upgrade-sequence';
import { decideUpgradeStart, UpgradeStartDecision, versionsToCheck } from './upgrade-version-check';
import { ADOPTION_RELEASE_VERSION, compareVersions, CREWFLOW_PREVIOUS_VERSIONS } from './upgrade-version';
import { cursorHasCompleted, listReadyWorkspaces, WorkspaceCommandRunner, WorkspaceOutcome, WorkspaceRunOptions } from './workspace-command-runner';

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
  /** Set when an upgrade COMMAND (instance, or a workspace step / adoption) failed after every migration applied (warn and serve). */
  commandFailure: { name: string; errorName: string; workspaceId?: string } | null;
  /** Part D: the workspace pass (null when it did not run). Workspace ids and step names only, never a message. */
  workspaces: { total: number; adopted: number; upgraded: number; failures: Array<Pick<WorkspaceOutcome, 'workspaceId' | 'status' | 'step' | 'errorClass' | 'attempt'>> } | null;
}

export interface UpgradeRunOptions {
  codeVersion: string;
  force: boolean;
  log: (line: string) => void;
  registry?: Readonly<Record<string, readonly UpgradeCommand[]>>;
  /** Part D: the workspace commands per release (default WORKSPACE_UPGRADE_COMMANDS). */
  workspaceRegistry?: Readonly<Record<string, readonly WorkspaceUpgradeCommand[]>>;
  /** Part D test seams for the workspace pass (integration specs only). */
  workspaceRunner?: Pick<WorkspaceRunOptions, 'lockTimeoutMs' | 'workspaceIds' | 'expectedFingerprint'>;
  /** The published versions before this one (default CREWFLOW_PREVIOUS_VERSIONS). */
  previousVersions?: readonly string[];
  /** Test seam (NODE_ENV=test + disposable database only; validated by the caller): this command name fails. */
  testFailCommand?: string | null;
}

/** One upgrade run's state, shared by the runner hooks. */
export class UpgradeRun {
  readonly report: UpgradeRunReport;
  private decision: UpgradeStartDecision | null = null;

  constructor(private readonly options: UpgradeRunOptions) {
    this.report = { codeVersion: options.codeVersion, forced: options.force, decision: null, adoptedFrom: null, recorded: [], commandFailure: null, workspaces: null };
  }

  private get registry() {
    return this.options.registry ?? UPGRADE_COMMANDS;
  }

  private get workspaceRegistry() {
    return this.options.workspaceRegistry ?? WORKSPACE_UPGRADE_COMMANDS;
  }

  private get previousVersions(): readonly string[] {
    return this.options.previousVersions ?? CREWFLOW_PREVIOUS_VERSIONS;
  }

  private get versions(): string[] {
    return [...this.previousVersions, this.options.codeVersion];
  }

  /**
   * Part D (Twenty run-instance-commands.command.ts:145-158 areAllWorkspacesAtCommand): for every version that has workspace
   * commands, whether every READY workspace has completed its last workspace command. Versions without one are not listed
   * (nothing is read: 0.4.0 / 0.5.0 / 0.6.0 behave exactly as Part B).
   */
  private async workspacesComplete(session: UpgradeSession, versions: readonly string[]): Promise<Record<string, boolean>> {
    const lastSteps = versions
      .map((v) => [v, lastWorkspaceStepOfVersion(v, this.workspaceRegistry)] as const)
      .filter((e): e is readonly [string, string] => e[1] !== null);
    if (!lastSteps.length) return {};
    const workspaces = await listReadyWorkspaces(session.query, this.options.workspaceRunner?.workspaceIds);
    const cursors = await withUpgradeScope(session, 'status', (q) => getWorkspaceCursors(q, workspaces.map((w) => w.workspaceId)));
    const sequence = sequenceForVersions(this.versions, this.registry, this.workspaceRegistry);
    const out: Record<string, boolean> = {};
    for (const [v, step] of lastSteps) out[v] = workspaces.every((w) => cursorHasCompleted(sequence, this.options.codeVersion, cursors.get(w.workspaceId), step));
    return out;
  }

  /** Twenty checks the PREVIOUS version's workspace segment only: the code version's own workspace steps are this run's job. */
  private previousOnly(versions: readonly string[]): string[] {
    return versions.filter((v) => v !== this.options.codeVersion);
  }

  /** Step 1. Throws UpgradeVersionTooOldError (65) or AppVersionError (64) before anything is applied. */
  async beforeApply(session: UpgradeSession, input: { fresh: boolean; attribution: LedgerAttribution | null; unrestrictedTarget: boolean }): Promise<UpgradeStartDecision> {
    const { codeVersion, force, log } = this.options;
    const ledgerExists = await upgradeLedgerExists(session.query);
    const facts = ledgerExists
      ? await withUpgradeScope(session, 'status', async (q) => {
          const instance = await hasInstanceRows(q);
          const complete: Record<string, boolean> = {};
          for (const v of versionsToCheck(codeVersion, this.previousVersions)) complete[v] = await isLastAttemptCompleted(q, { name: lastInstanceStepOfVersion(v, this.registry), workspaceId: null });
          const newer = (await instanceVersions(q)).filter((v) => compareVersions(v, codeVersion) > 0);
          return { instance, complete, newer };
        })
      : { instance: false, complete: {} as Record<string, boolean>, newer: [] as string[] };
    if (ledgerExists) {
      const ws = await this.workspacesComplete(session, this.previousOnly(versionsToCheck(codeVersion, this.previousVersions)));
      for (const [v, done] of Object.entries(ws)) facts.complete[v] = facts.complete[v] === true && done;
    }
    const decision = decideUpgradeStart({
      previousVersions: this.previousVersions,
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
  async afterApply(session: UpgradeSession): Promise<void> {
    const { codeVersion, force, log } = this.options;
    const decision = this.decision;
    if (!decision) throw new Error('upgrade run: afterApply before beforeApply');
    if (decision.kind === 'rollback') return;
    if (!(await upgradeLedgerExists(session.query))) throw new Error('upgrade run: core.upgrade_migration does not exist after the migrations');
    await withUpgradeScope(session, 'upgrade', async (q) => {
      if (decision.kind === 'adopt' && (await markAsInstanceInitial(q, { name: decision.initialName, executedByVersion: decision.initialVersion }))) {
        log(`adopted: is_initial row ${decision.initialName}`);
      }
    });
    const migrationsStep = migrationsStepName(codeVersion);
    await this.recordIfIncomplete(session, migrationsStep, 'completed');
    for (const command of commandsForVersion(codeVersion, this.registry)) {
      const name = commandStepName(codeVersion, command);
      const done = await withUpgradeScope(session, 'upgrade', (q) => isLastAttemptCompleted(q, { name, workspaceId: null }));
      if (done) continue;
      try {
        if (this.options.testFailCommand && this.options.testFailCommand === command.name) throw Object.assign(new Error('test seam: forced command failure'), { name: 'TestCommandFailure' });
        log(`upgrade command ${name}: running`);
        await command.run({ query: session.query, log });
      } catch (error) {
        const attempt = await withUpgradeScope(session, 'upgrade', (q) => recordUpgradeMigration(q, { name, status: 'failed', executedByVersion: codeVersion, forced: force, error }));
        this.report.recorded.push({ name, status: 'failed', attempt });
        this.report.commandFailure = { name, errorName: error instanceof Error ? error.name : 'Error' };
        log(`ERROR: upgrade command ${name} FAILED (attempt ${attempt}); the schema matches this code, so the API serves with upgrade:"failed" (exit 70). The next start retries it.`);
        return;
      }
      const attempt = await withUpgradeScope(session, 'upgrade', (q) => recordUpgradeMigration(q, { name, status: 'completed', executedByVersion: codeVersion, forced: force }));
      this.report.recorded.push({ name, status: 'completed', attempt });
    }
    await this.runWorkspacePass(session);
    if (!this.report.commandFailure) log(`upgrade logbook: ${codeVersion} complete`);
  }

  /** Part D: adoption (adoption release) + the code version's workspace commands, per workspace. Never throws for one workspace. */
  private async runWorkspacePass(session: UpgradeSession): Promise<void> {
    const { codeVersion, force, log } = this.options;
    const runner = new WorkspaceCommandRunner({
      ...this.options.workspaceRunner,
      codeVersion,
      versions: this.versions,
      force,
      adopt: codeVersion === ADOPTION_RELEASE_VERSION,
      log,
      registry: this.registry,
      workspaceRegistry: this.workspaceRegistry,
    });
    const result = await runner.run(session);
    this.report.workspaces = {
      total: result.outcomes.length,
      adopted: result.outcomes.filter((o) => o.status === 'adopted').length,
      upgraded: result.outcomes.filter((o) => o.completed.length > 0).length,
      failures: result.failures.map(({ workspaceId, status, step, errorClass, attempt }) => ({ workspaceId, status, step, errorClass, attempt })),
    };
    const first = result.failures[0];
    if (first) {
      this.report.commandFailure = { name: first.step ?? 'workspace', errorName: first.errorClass ?? 'WorkspaceFailure', workspaceId: first.workspaceId };
      log(
        `ERROR: ${result.failures.length} workspace(s) did not complete the workspace steps of ${codeVersion}; each is on its previous, verified structure. ` +
          'Every other workspace matches this code, so the API serves with upgrade:"failed" (exit 70). The next start retries them.',
      );
    }
  }

  /** A migration or post-check failure (lock still held). Records `<v>_TypeOrmMigrations` failed when the table exists. Never throws. */
  async onApplyFailure(session: UpgradeSession, error: unknown): Promise<void> {
    const { codeVersion, force, log } = this.options;
    if (!this.decision || this.decision.kind === 'rollback') return;
    try {
      await session.query('ROLLBACK').catch(() => undefined); // a failed migration may leave the session in an aborted transaction
      if (!(await upgradeLedgerExists(session.query))) {
        log('the migration failure could not be recorded: core.upgrade_migration does not exist yet (it is created by a later migration)');
        return;
      }
      const name = migrationsStepName(codeVersion);
      const attempt = await withUpgradeScope(session, 'upgrade', (q) => recordUpgradeMigration(q, { name, status: 'failed', executedByVersion: codeVersion, forced: force, error }));
      this.report.recorded.push({ name, status: 'failed', attempt });
      log(`upgrade logbook: ${name} failed (attempt ${attempt}); the next start retries it`);
    } catch (recordError) {
      log(`WARNING: the migration failure could not be recorded (${recordError instanceof Error ? recordError.name : 'error'})`);
    }
  }

  private async recordIfIncomplete(session: UpgradeSession, name: string, status: 'completed'): Promise<void> {
    const { codeVersion, force } = this.options;
    const attempt = await withUpgradeScope(session, 'upgrade', async (q) => {
      if (await isLastAttemptCompleted(q, { name, workspaceId: null })) return null;
      return recordUpgradeMigration(q, { name, status, executedByVersion: codeVersion, forced: force });
    });
    if (attempt !== null) this.report.recorded.push({ name, status, attempt });
  }
}

/** For the health read and the `upgrade` command output. */
export { getLastAttemptedInstanceStep };
