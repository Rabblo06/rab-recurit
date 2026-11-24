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
 *
 * PATCH releases (owner decision 2026-11-18, Twenty upgrade-sequence-runner.service.ts:98-247 "Rerun the upgrade to resume
 * from this step" + resumeWorkspaceCommandsFromCursors): a patch carries no command of its own; it resumes its minor .0. Every
 * .0 instance COMMAND whose latest attempt is not completed runs again under the .0's own step name, recorded with
 * executed_by_version = the patch. ORDER INVARIANT (review R1 of #240; Twenty runs migrations as steps of the sequence): the
 * .0's commands run in beforeApply, BEFORE any migration of this start is applied (never after this start's migrations; on
 * the .0 schema unless an earlier --force or fresh patch start applied later ones), and only when the .0's migrations step
 * is completed (nothing maps a migration to a release, so that step is the proof that every migration the .0 ships is
 * applied). Then the migrations apply, then (afterApply) the patch's own migrations step is recorded and the workspace pass
 * runs. If a .0 command fails again with migrations pending: an unforced start is refused (MinorReleaseResumeFailedError,
 * exit 66, fail closed: this code cannot serve with its migrations unapplied); a --force start goes on (review B of #240:
 * the migrations apply and it serves degraded, exit 70, every row forced; the blocked workspace stays 503). With nothing
 * pending it serves degraded (exit 70). A degraded start does not record the patch's own step. A .0 command left with its
 * migrations step incomplete refuses 65 ("Nothing was applied") unless --force: the hotfix case (a .0 migration failed and
 * the patch ships the fix) therefore needs --force when the .0 has instance commands, because the .0's commands must not
 * run on a schema whose .0 migrations are not all applied, and the patch can only apply them together with its own. Two documented exceptions run the .0's
 * commands AFTER every migration (afterApply): a start with no instance row yet (fresh install, or an unchecked local / test
 * history: nothing of the .0 has run) and that --force start (logged as a WARNING).
 * The workspace pass walks each workspace's sequence from its cursor, so a failed .0 WORKSPACE step runs again the same way
 * (that workspace stays blocked until it passes). Every command must be safe to run twice (upgrade-command.ts /
 * workspace-upgrade-command.ts).
 */
import type { LedgerAttribution } from '../../../database/typeorm/scripts/migrate/owner-login/release-floor';
import { UpgradeCommand, UpgradeCommandHost } from './upgrade-commands/upgrade-command';
import { createUpgradeCommandHost } from './upgrade-command-host';
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
  versionStartedUnforced,
  withUpgradeScope,
  unforcedInstanceVersions,
  anyForcedInstanceAttempt,
} from './upgrade-migration.service';
import {
  commandsForVersion,
  commandStepName,
  instanceVersionsOfStart,
  lastInstanceStepOfVersion,
  lastWorkspaceStepOfVersion,
  migrationsStepName,
  sequenceForVersions,
} from './upgrade-sequence';
import { assertRegistryKeys } from './upgrade-registry-key';
import { decideUpgradeStart, UpgradeStartDecision, UpgradeVersionTooOldError, versionsToCheck } from './upgrade-version-check';
import {
  ADOPTION_RELEASE_VERSION,
  compareVersions,
  CREWFLOW_PREVIOUS_VERSIONS,
  CREWFLOW_UPGRADE_FROM_VERSIONS,
  isPatchRelease,
  isVersion as isVersionOf,
  minorReleaseOf,
  UpgradeFromVersions,
} from './upgrade-version';
import { cursorHasCompleted, listReadyWorkspaces, WorkspaceCommandRunner, WorkspaceOutcome, WorkspaceRunOptions } from './workspace-command-runner';

/**
 * A PATCH start resumed its minor .0's failed instance command before the migrations (owner decision 2026-11-18, review R1
 * of #240) and the command failed again while migrations of this code are pending: the start is refused (exit 66, outcomeOf
 * default 'migrationFailed'); the patch's migrations are NOT applied and the failed attempt is recorded. The next start retries.
 */
export class MinorReleaseResumeFailedError extends Error {
  constructor(
    message: string,
    /** The .0 step that failed again (a step name, never a message) and the attempt recorded for it. */
    readonly step: string,
    readonly attempt: number | null,
  ) {
    super(message);
    this.name = 'MinorReleaseResumeFailedError';
  }
}

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
  /** Part C3: an instance command wrote, kept or lifted a workspace block marker (the resolver cache epoch must be bumped). */
  commandBlockChanged: boolean;
  /** Part D: the workspace pass (null when it did not run). Workspace ids and step names only, never a message. */
  workspaces: {
    total: number;
    adopted: number;
    upgraded: number;
    failures: Array<Pick<WorkspaceOutcome, 'workspaceId' | 'status' | 'step' | 'errorClass' | 'attempt' | 'blocked'>>;
    /** D2/D3: workspaces blocked after this run (503, Worker paused). */
    blocked: string[];
    /** D2/D3: a block was written or lifted (the resolver cache epoch must be bumped). */
    blockChanged: boolean;
  } | null;
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
  /** The reviewed upgrade-from list per minor release (default CREWFLOW_UPGRADE_FROM_VERSIONS). */
  upgradeFrom?: UpgradeFromVersions;
  /** Test seam (NODE_ENV=test + disposable database only; validated by the caller): this command name fails. */
  testFailCommand?: string | null;
  /** Part C3: the host facts lent to instance commands (default: the real process, upgrade-command-host.ts). */
  host?: UpgradeCommandHost;
  /** Part C3 (review L-4): bumps the resolver cache epoch on demand (migrate-on-start; throws when it cannot). */
  flushBlockCache?: () => Promise<void>;
}

/** One upgrade run's state, shared by the runner hooks. */
export class UpgradeRun {
  readonly report: UpgradeRunReport;
  private decision: UpgradeStartDecision | null = null;
  /** A patch start already resumed its minor .0's instance commands in beforeApply: 'ok' or 'failed' (null: not done there). */
  private minorResumed: 'ok' | 'failed' | null = null;

  constructor(private readonly options: UpgradeRunOptions) {
    this.report = { codeVersion: options.codeVersion, forced: options.force, decision: null, adoptedFrom: null, recorded: [], commandFailure: null, commandBlockChanged: false, workspaces: null };
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

  private get upgradeFrom(): UpgradeFromVersions {
    return this.options.upgradeFrom ?? CREWFLOW_UPGRADE_FROM_VERSIONS;
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
    const { workspaces, cursors } = await this.readyCursors(session);
    const sequence = sequenceForVersions(this.versions, this.registry, this.workspaceRegistry);
    const out: Record<string, boolean> = {};
    for (const [v, step] of lastSteps) out[v] = workspaces.every((w) => cursorHasCompleted(sequence, this.options.codeVersion, cursors.get(w.workspaceId), step));
    return out;
  }

  /** READY workspaces (the test filter applied) and their cursors (the newest logbook row of each), read in 'status' scope. */
  private async readyCursors(session: UpgradeSession) {
    const workspaces = await listReadyWorkspaces(session.query, this.options.workspaceRunner?.workspaceIds);
    const cursors = await withUpgradeScope(session, 'status', (q) => getWorkspaceCursors(q, workspaces.map((w) => w.workspaceId)));
    return { workspaces, cursors };
  }

  /** Twenty checks the PREVIOUS version's workspace segment only: the code version's own workspace steps are this run's job. */
  private previousOnly(versions: readonly string[]): string[] {
    return versions.filter((v) => v !== this.options.codeVersion);
  }

  /** Step 1. Throws UpgradeVersionTooOldError (65) or AppVersionError (64) before anything is applied. */
  async beforeApply(
    session: UpgradeSession,
    input: {
      fresh: boolean;
      attribution: LedgerAttribution | null;
      unrestrictedTarget: boolean;
      /** The migrations this start will apply (the locked runner's pendingBefore). Default none. */
      pendingMigrations?: readonly string[];
    },
  ): Promise<UpgradeStartDecision> {
    const { codeVersion, force, log } = this.options;
    // Security review L-1: the registry keys are checked first, unconditionally (a fresh or no-ledger start reads no registry
    // before the migrations): a patch key refuses here (config, 64), before any migration is applied.
    assertRegistryKeys(this.registry);
    assertRegistryKeys(this.workspaceRegistry);
    // M-1: versionsToCheck also lists the minor release of an accepted previous patch; its workspace half is read below and
    // decideUpgradeStart folds it into the patch's entry (effectiveComplete).
    const ledgerExists = await upgradeLedgerExists(session.query);
    const toCheck = versionsToCheck(codeVersion, this.previousVersions, this.upgradeFrom);
    const minor = isPatchRelease(codeVersion) ? minorReleaseOf(codeVersion) : null;
    const facts = ledgerExists
      ? await withUpgradeScope(session, 'status', async (q) => {
          const instance = await hasInstanceRows(q);
          const complete: Record<string, boolean> = {};
          for (const v of toCheck) complete[v] = await isLastAttemptCompleted(q, { name: lastInstanceStepOfVersion(v, this.registry), workspaceId: null });
          const newer = (await instanceVersions(q)).filter((v) => compareVersions(v, codeVersion) > 0);
          const started = await versionStartedUnforced(q, codeVersion);
          // Review O3 of #240: the .0 counts as started when an unforced, non-initial instance row was executed by the .0 OR by
          // an earlier patch of its line (a fresh 0.7.1 whose 0.7.0 retry failed wrote rows as 0.7.1 only).
          const minorStarted =
            minor !== null && (await unforcedInstanceVersions(q)).some((v) => isVersionOf(v) && minorReleaseOf(v) === minor && compareVersions(v, codeVersion) < 0);
          return { instance, complete, newer, started, minorStarted };
        })
      : { instance: false, complete: {} as Record<string, boolean>, newer: [] as string[], started: false, minorStarted: false };
    let minorReleaseResumable = false;
    if (ledgerExists) {
      const ws = await this.workspacesComplete(session, this.previousOnly(toCheck));
      for (const [v, done] of Object.entries(ws)) facts.complete[v] = facts.complete[v] === true && done;
      // (b) a patch resumes its .0 only when every READY workspace has a logbook row: a patch never adopts (only 0.6.0 does),
      // so a workspace without one could not be resumed and would only be refused; the start is refused (65) instead.
      if (facts.minorStarted) {
        const { workspaces, cursors } = await this.readyCursors(session);
        minorReleaseResumable = workspaces.every((w) => cursors.has(w.workspaceId));
      }
    }
    const decision = decideUpgradeStart({
      previousVersions: this.previousVersions,
      upgradeFrom: this.upgradeFrom,
      minorReleaseResumable,
      codeVersion,
      fresh: input.fresh,
      force,
      ledgerExists,
      hasInstanceRows: facts.instance,
      codeVersionStarted: facts.started,
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
    if (minor !== null && ledgerExists && (decision.kind === 'continue' || decision.kind === 'forced')) await this.resumeMinorBeforeMigrations(session, minor, input.pendingMigrations ?? []);
    return decision;
  }

  /**
   * The ORDER INVARIANT of a patch start (see the header): the minor .0's incomplete instance commands run now, before any
   * migration of this start, and only when the .0's migrations step is completed. Throws before anything is applied:
   * UpgradeVersionTooOldError (65) when the .0's migrations step is not completed (unless --force: then they run in
   * afterApply, after every migration, with a WARNING); MinorReleaseResumeFailedError (66) when a command fails again while
   * migrations are pending, unless --force (review B: then the migrations apply and the start serves degraded, 70).
   */
  private async resumeMinorBeforeMigrations(session: UpgradeSession, minor: string, pendingMigrations: readonly string[]): Promise<void> {
    const { codeVersion, force, log } = this.options;
    const incomplete: string[] = [];
    for (const c of commandsForVersion(minor, this.registry)) {
      const name = commandStepName(minor, c);
      if (!(await withUpgradeScope(session, 'status', (q) => isLastAttemptCompleted(q, { name, workspaceId: null })))) incomplete.push(name);
    }
    if (!incomplete.length) return;
    const migrationsDone = await withUpgradeScope(session, 'status', (q) => isLastAttemptCompleted(q, { name: migrationsStepName(minor), workspaceId: null }));
    if (!migrationsDone) {
      if (!force) {
        throw new UpgradeVersionTooOldError(
          `${codeVersion} must re-run ${minor}'s incomplete command(s) ${incomplete.join(', ')} before any of its own migrations, but ${migrationsStepName(minor)} is not completed, so migrations of ${minor} may still be pending. Start ${minor} again first, or run the manual command \`upgrade --force\` (not recommended: the commands then run after every migration). Nothing was applied.`,
        );
      }
      log(`WARNING: upgrade --force: ${migrationsStepName(minor)} is not completed, so ${minor}'s command(s) ${incomplete.join(', ')} run AFTER every migration of this start (not before ${codeVersion}'s own)`);
      return;
    }
    log(`upgrade ${codeVersion}: resuming ${minor} before any migration: ${incomplete.length} incomplete instance command(s) re-run under their own names (${incomplete.join(', ')})`);
    // Final review of #240: nothing pending, and an earlier attempt of the step was forced: an earlier --force start already
    // applied this code's migrations, so the retry runs on a schema that start moved past the .0. Recorded forced = true.
    const forcedSteps = new Set<string>();
    if (!pendingMigrations.length) {
      for (const name of incomplete) {
        if (await withUpgradeScope(session, 'status', (q) => anyForcedInstanceAttempt(q, name))) {
          forcedSteps.add(name);
          log(
            `WARNING: ${name} runs on a schema that an earlier --force start moved past ${minor} (this code's migrations are already applied); its attempt is recorded forced`,
          );
        }
      }
    }
    const ok = await this.runInstanceSteps(session, minor, forcedSteps);
    this.minorResumed = ok ? 'ok' : 'failed';
    if (!ok && pendingMigrations.length) {
      const failed = this.report.recorded.filter((r) => r.status === 'failed').slice(-1)[0];
      const step = this.report.commandFailure?.name ?? failed?.name ?? minor;
      if (force) {
        log(
          `WARNING: upgrade --force: ${step} failed again (attempt ${failed?.attempt ?? '?'}); applying ${codeVersion}'s ${pendingMigrations.length} pending migration(s) anyway. The start serves degraded (exit 70), every row is marked forced, and the workspaces that step blocked stay blocked (503).`,
        );
        return;
      }
      throw new MinorReleaseResumeFailedError(
        `${step} failed again (attempt ${failed?.attempt ?? '?'}, recorded) before any migration of this start; ${codeVersion}'s ${pendingMigrations.length} pending migration(s) were NOT applied, so this image cannot serve. Fix the cause and start again, run the manual command \`upgrade --force\` (serves degraded; the blocked workspaces stay 503), or redeploy the ${minor} image.`,
        step,
        failed?.attempt ?? null,
      );
    }
  }

  /** Step 3, after the migrations applied and the post-checks passed. Never throws for a failed COMMAND (reported instead). */
  async afterApply(session: UpgradeSession): Promise<void> {
    const { codeVersion, log } = this.options;
    const decision = this.decision;
    if (!decision) throw new Error('upgrade run: afterApply before beforeApply');
    if (decision.kind === 'rollback') return;
    if (!(await upgradeLedgerExists(session.query))) throw new Error('upgrade run: core.upgrade_migration does not exist after the migrations');
    await withUpgradeScope(session, 'upgrade', async (q) => {
      if (decision.kind === 'adopt' && (await markAsInstanceInitial(q, { name: decision.initialName, executedByVersion: decision.initialVersion }))) {
        log(`adopted: is_initial row ${decision.initialName}`);
      }
    });
    // A minor release: its own instance steps. A PATCH release: its minor .0's incomplete instance steps (already run in
    // beforeApply, before the migrations, unless this is a fresh install or a --force start whose .0 migrations step was
    // incomplete; see the header), then its own migrations step. A failed command stops the start (warn and serve).
    if (this.minorResumed === 'failed') return;
    for (const version of instanceVersionsOfStart(codeVersion)) {
      if (version !== codeVersion && this.minorResumed === 'ok') continue;
      if (!(await this.runInstanceSteps(session, version))) return;
    }
    await this.runWorkspacePass(session);
    if (!this.report.commandFailure) log(`upgrade logbook: ${codeVersion} complete`);
  }

  /**
   * The instance steps of `version` (the code version, or a patch's minor .0), each recorded under `version`'s own step name
   * with executed_by_version = the CODE version: the migrations step completed (this start applied every migration of the
   * code), then each command whose latest attempt is not completed: run it, record completed or failed. Returns false when a
   * command failed (recorded and reported: warn and serve, exit 70; the next start retries it).
   */
  private async runInstanceSteps(session: UpgradeSession, version: string, forcedSteps: ReadonlySet<string> = new Set()): Promise<boolean> {
    const { codeVersion, force, log } = this.options;
    await this.recordIfIncomplete(session, migrationsStepName(version), 'completed');
    for (const command of commandsForVersion(version, this.registry)) {
      const name = commandStepName(version, command);
      const done = await withUpgradeScope(session, 'upgrade', (q) => isLastAttemptCompleted(q, { name, workspaceId: null }));
      if (done) continue;
      if (version !== codeVersion) log(`upgrade ${codeVersion}: re-running ${name} (an incomplete step of ${version}) under its own name`);
      try {
        if (this.options.testFailCommand && this.options.testFailCommand === command.name) throw Object.assign(new Error('test seam: forced command failure'), { name: 'TestCommandFailure' });
        log(`upgrade command ${name}: running`);
        await command.run({
          query: session.query,
          log,
          host: this.options.host ?? createUpgradeCommandHost(),
          markBlockChanged: () => {
            this.report.commandBlockChanged = true;
          },
          flushBlockCache: this.options.flushBlockCache,
        });
      } catch (error) {
        const attempt = await withUpgradeScope(session, 'upgrade', (q) =>
          recordUpgradeMigration(q, { name, status: 'failed', executedByVersion: codeVersion, forced: force || forcedSteps.has(name), error }),
        );
        this.report.recorded.push({ name, status: 'failed', attempt });
        this.report.commandFailure = { name, errorName: error instanceof Error ? error.name : 'Error' };
        log(`ERROR: upgrade command ${name} FAILED (attempt ${attempt}); the schema matches this code, so the API serves with upgradeFailed:true (exit 70). The next start retries it.`);
        return false;
      }
      const attempt = await withUpgradeScope(session, 'upgrade', (q) =>
        recordUpgradeMigration(q, { name, status: 'completed', executedByVersion: codeVersion, forced: force || forcedSteps.has(name) }),
      );
      this.report.recorded.push({ name, status: 'completed', attempt });
    }
    return true;
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
      failures: result.failures.map(({ workspaceId, status, step, errorClass, attempt, blocked }) => ({ workspaceId, status, step, errorClass, attempt, blocked: blocked === true })),
      blocked: result.outcomes.filter((o) => o.blocked).map((o) => o.workspaceId),
      blockChanged: result.blockChanged,
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
