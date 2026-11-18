/**
 * Patch releases (e.g. 0.6.1) in the upgrade runner. Upgrade commands are per MINOR release and belong to its `.0`; a patch
 * release carries no upgrade command, no workspace command and no structure level, and accepts an upgrade from its own minor
 * line only (Twenty: commands per `<major-minor>` folder, a patch runs none; re-implemented, not copied).
 *
 * The bug this pins (closed draft PR #216, branch release/0.6.1): the registry is keyed `<major>-<minor>`, so a 0.6.1 build
 * looked up `'0-6'` and re-listed 0.6.0's workspace commands as `0.6.1_…`; structureLevels() then threw "structure level 21,
 * expected 23" on every start (exit 66). Pure: no database (the database half is patch-release-upgrade.integration.spec.ts).
 */
import type { LedgerAttribution } from '../../../database/typeorm/scripts/migrate/owner-login/release-floor';
import { outcomeOf, withProbeCommands } from '../../../database/typeorm/scripts/migrate/owner-login/migrate-on-start';
import { STARTUP_EXIT_CODES } from '../../../database/owner-login/runtime-db-config';
import type { UpgradeCommand } from './upgrade-commands/upgrade-command';
import type { WorkspaceUpgradeCommand } from './upgrade-commands/workspace-upgrade-command';
import { UPGRADE_COMMANDS, WORKSPACE_UPGRADE_COMMANDS } from './upgrade-commands/registry';
import { assertRegistryKeys, PatchReleaseCommandsError, registryKeyRelease, UpgradeRegistryError } from './upgrade-registry-key';
import {
  commandsForVersion,
  instanceStepsForVersion,
  lastInstanceStepOfVersion,
  lastStepOfVersion,
  lastWorkspaceStepOfVersion,
  sequenceForVersions,
  stepsForVersion,
  workspaceCommandsForVersion,
} from './upgrade-sequence';
import { upgradeStateOf } from './upgrade-status.service';
import { decideUpgradeStart, effectiveComplete, UpgradeStartFacts, UpgradeVersionTooOldError, versionsToCheck } from './upgrade-version-check';
import { AppVersionError, assertPreviousVersions, CREWFLOW_PREVIOUS_VERSIONS, isPatchRelease, minorReleaseOf, parseVersion, readAppVersion, upgradeFromVersions } from './upgrade-version';
import { cursorHasCompleted, pendingWorkspaceSteps, structureLevels } from './workspace-command-runner';
import { UpgradeRun } from './upgrade-runner';
import type { UpgradeSession } from './upgrade-migration.service';
import { codeWorkspaceStructureLevel, structuralCommands } from './workspace-structure-level';

const inst = (name: string, timestamp: number): UpgradeCommand => ({ name, timestamp, run: async () => undefined });
const wsc = (name: string, timestamp: number, extra: Partial<WorkspaceUpgradeCommand> = {}): WorkspaceUpgradeCommand => ({
  kind: 'workspace',
  name,
  timestamp,
  run: async () => undefined,
  ...extra,
});

/** The published list as the 0.6.1 release PR will set it (this PR does not register 0.6.1: CREWFLOW_PREVIOUS_VERSIONS is unchanged). */
const PREV_061 = ['0.4.0', '0.5.0', '0.6.0'];
const PREV_070 = ['0.4.0', '0.5.0', '0.6.0', '0.6.1'];
const REAL_06 = WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? [];
const LAST_060 = lastStepOfVersion('0.6.0');
const names = (steps: readonly { name: string }[] | null) => steps?.map((s) => s.name) ?? null;
const facts = (over: Partial<UpgradeStartFacts>): UpgradeStartFacts => ({
  codeVersion: '0.6.1',
  previousVersions: PREV_061,
  fresh: false,
  force: false,
  ledgerExists: true,
  hasInstanceRows: true,
  complete: {},
  newerVersions: [],
  attribution: null,
  unrestrictedTarget: false,
  ...over,
});
const errorName = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.name : 'non-error';
  }
};

describe('patch releases: version shape (fail closed)', () => {
  it('PATCH > 0 is a patch release; its minor release is M.m.0', () => {
    expect([isPatchRelease('0.6.0'), isPatchRelease('0.6.1'), isPatchRelease('1.0.12')]).toEqual([false, true, true]);
    expect([minorReleaseOf('0.6.1'), minorReleaseOf('0.6.0'), minorReleaseOf('2.10.3')]).toEqual(['0.6.0', '0.6.0', '2.10.0']);
  });

  it('an unknown version shape still refuses (AppVersionError), in every helper a patch decision goes through', () => {
    for (const bad of ['0.6', '0.6.1-rc1', '0.06.1', 'v0.6.1', '0.6.1.0', '', ' 0.6.1']) {
      expect(() => isPatchRelease(bad)).toThrow(AppVersionError);
      expect(() => minorReleaseOf(bad)).toThrow(AppVersionError);
      expect(() => commandsForVersion(bad)).toThrow(AppVersionError);
      expect(() => workspaceCommandsForVersion(bad)).toThrow(AppVersionError);
      expect(() => upgradeFromVersions(bad, PREV_061)).toThrow(AppVersionError);
    }
  });
});

describe('patch releases carry no upgrade commands and no structure levels', () => {
  it('0.6.1 has one step, its migrations step; no instance or workspace command of 0.6 is re-listed under 0.6.1', () => {
    expect(commandsForVersion('0.6.1')).toEqual([]);
    expect(workspaceCommandsForVersion('0.6.1')).toEqual([]);
    expect(stepsForVersion('0.6.1')).toEqual(['0.6.1_TypeOrmMigrations']);
    expect(instanceStepsForVersion('0.6.1')).toEqual(['0.6.1_TypeOrmMigrations']);
    expect(lastStepOfVersion('0.6.1')).toBe('0.6.1_TypeOrmMigrations');
    expect(lastInstanceStepOfVersion('0.6.1')).toBe('0.6.1_TypeOrmMigrations');
    expect(lastWorkspaceStepOfVersion('0.6.1')).toBeNull();
    // The minor release keeps its bundle.
    expect(workspaceCommandsForVersion('0.6.0').map((c) => c.name)).toEqual(REAL_06.map((c) => c.name));
  });

  it('even when the minor bundle holds instance commands, a patch runs none of them', () => {
    const registry = { '0-7': [inst('Inst', 1786900000000)] };
    const workspace = { '0-7': [wsc('Ws', 1786900000100)] };
    expect(stepsForVersion('0.7.0', registry, workspace)).toEqual(['0.7.0_TypeOrmMigrations', '0.7.0_Inst_1786900000000', '0.7.0_Ws_1786900000100']);
    for (const v of ['0.7.1', '0.7.2', '0.7.15']) expect(stepsForVersion(v, registry, workspace)).toEqual([`${v}_TypeOrmMigrations`]);
  });

  it('PR #216 regression: the 0.4.0 … 0.6.1 sequence validates (levels 21, 22 once); the old code threw "structure level 21, expected 23"', () => {
    const sequence = sequenceForVersions(['0.4.0', '0.5.0', '0.6.0', '0.6.1']);
    expect(() => structureLevels(sequence)).not.toThrow();
    expect([...structureLevels(sequence).keys()]).toEqual([21, 22]);
    expect(sequence.filter((s) => s.version === '0.6.1').map((s) => [s.name, s.kind])).toEqual([['0.6.1_TypeOrmMigrations', 'instance']]);
    expect(sequence.filter((s) => s.kind === 'workspace').every((s) => s.version === '0.6.0')).toBe(true);
    // The code structure level does not depend on the version: a 0.6.1 image provisions and expects level 22, as 0.6.0 does.
    // A 0.6.x image knows only the 0.6 line's commands: this code's registry without the 0.7 release (which adds level 23).
    const line06 = Object.fromEntries(Object.entries(WORKSPACE_UPGRADE_COMMANDS).filter(([key]) => key !== '0-7'));
    expect(codeWorkspaceStructureLevel(line06)).toBe(22);
  });

  it('release guard: the next patch of the SHIPPED version validates and leaves nothing pending for a workspace that finished it', () => {
    const shipped = readAppVersion({});
    const v = parseVersion(shipped);
    const nextPatch = `${v.major}.${v.minor}.${v.patch + 1}`;
    const previous = [...CREWFLOW_PREVIOUS_VERSIONS, shipped];
    const sequence = sequenceForVersions([...previous, nextPatch]);
    expect(() => structureLevels(sequence)).not.toThrow();
    expect(sequence.filter((s) => s.version === nextPatch).map((s) => s.name)).toEqual([`${nextPatch}_TypeOrmMigrations`]);
    expect(names(pendingWorkspaceSteps(sequence, nextPatch, { name: lastStepOfVersion(shipped), status: 'completed' }))).toEqual([]);
    expect(upgradeFromVersions(nextPatch, previous)).toContain(shipped);
  });
});

describe('patch releases: which versions they upgrade from', () => {
  it('a patch accepts its minor .0 and earlier patches of its own line, never another minor line', () => {
    expect(upgradeFromVersions('0.6.1', PREV_061)).toEqual(['0.6.0']);
    expect(upgradeFromVersions('0.6.2', [...PREV_061, '0.6.1'])).toEqual(['0.6.0', '0.6.1']);
    expect(upgradeFromVersions('0.7.1', [...PREV_070, '0.7.0'])).toEqual(['0.7.0']);
    // A skipped patch build (0.6.2 never published) changes nothing: the published ones of the line count.
    expect(upgradeFromVersions('0.6.3', [...PREV_061, '0.6.1'])).toEqual(['0.6.0', '0.6.1']);
    expect(versionsToCheck('0.6.1', PREV_061)).toEqual(['0.6.0', '0.6.1']);
  });

  it('the minor releases keep the existing rule (0.6.0 adoption; 0.7.0 strict: the last published version)', () => {
    expect(upgradeFromVersions('0.6.0', ['0.4.0', '0.5.0'])).toEqual(['0.4.0', '0.5.0']);
    expect(upgradeFromVersions('0.7.0', PREV_061)).toEqual(['0.6.0']);
    expect(upgradeFromVersions('0.7.0', PREV_070)).toEqual(['0.6.1']);
  });

  it("fail closed: a patch whose minor .0 is not a published previous version refuses (config, 64), also on a fresh install", () => {
    expect(() => upgradeFromVersions('0.6.1', ['0.4.0', '0.5.0'])).toThrow(/needs its minor release 0\.6\.0 in CREWFLOW_PREVIOUS_VERSIONS/);
    expect(() => decideUpgradeStart(facts({ previousVersions: ['0.4.0', '0.5.0'], fresh: true }))).toThrow(AppVersionError);
    expect(outcomeOf(new AppVersionError('x'))).toBe('config');
  });
});

describe('patch releases: the start decision (decideUpgradeStart)', () => {
  const r256: LedgerAttribution = { kind: 'release', release: 'R256', beyond: [], remaining: 1 };

  it('0.6.0 → 0.6.1: continue from 0.6.0 (with or without workspaces: the workspace half is folded into `complete`)', () => {
    expect(decideUpgradeStart(facts({ complete: { '0.6.0': true } }))).toMatchObject({ kind: 'continue', from: '0.6.0' });
    // A repeated 0.6.1 start.
    expect(decideUpgradeStart(facts({ complete: { '0.6.0': true, '0.6.1': true } }))).toMatchObject({ kind: 'continue', from: '0.6.0' });
    expect(decideUpgradeStart(facts({ complete: { '0.6.1': true } }))).toMatchObject({ kind: 'continue', from: '0.6.1' });
  });

  it('abuse: a patch cannot skip an incomplete .0 (some workspace has not finished 0.6.0) or jump from the previous minor: 65', () => {
    expect(() => decideUpgradeStart(facts({ complete: { '0.6.0': false } }))).toThrow(UpgradeVersionTooOldError);
    // 0.5.0 complete is not an accepted previous version of 0.6.1 (0.6.0's workspace commands would be skipped).
    expect(() => decideUpgradeStart(facts({ complete: { '0.5.0': true } }))).toThrow(UpgradeVersionTooOldError);
    // --force skips only this check, as for any release.
    expect(decideUpgradeStart(facts({ complete: { '0.6.0': false }, force: true })).kind).toBe('forced');
  });

  it('abuse: a patch never adopts an R254 / R256 history (only 0.6.0 does): 65', () => {
    expect(() => decideUpgradeStart(facts({ hasInstanceRows: false, attribution: r256 }))).toThrow(UpgradeVersionTooOldError);
    expect(() => decideUpgradeStart(facts({ ledgerExists: false, hasInstanceRows: false, attribution: r256 }))).toThrow(/only 0\.6\.0 adopts/);
  });

  it('fresh install on 0.6.1: no previous-version check; a workspace created on it starts at 0.6.1_TypeOrmMigrations with nothing pending', () => {
    expect(decideUpgradeStart(facts({ fresh: true, ledgerExists: false, hasInstanceRows: false })).kind).toBe('fresh');
    const sequence = sequenceForVersions([...PREV_061, '0.6.1']);
    const cursor = { name: lastStepOfVersion('0.6.1'), status: 'completed' as const };
    expect(cursor.name).toBe('0.6.1_TypeOrmMigrations');
    expect(names(pendingWorkspaceSteps(sequence, '0.6.1', cursor))).toEqual([]);
    // It counts as having completed every 0.6.0 workspace step (it was built at their level from the current template).
    expect(cursorHasCompleted(sequence, '0.6.1', cursor, LAST_060)).toBe(true);
  });

  it('downgrade 0.6.1 → 0.6.0: today\'s image-rollback rule (nothing recorded, serves), also under --force; /healthz says "ahead"', () => {
    const at060 = (force: boolean) =>
      decideUpgradeStart({ ...facts({ codeVersion: '0.6.0', previousVersions: ['0.4.0', '0.5.0'], complete: { '0.6.0': true } }), newerVersions: ['0.6.1'], force });
    expect(at060(false).kind).toBe('rollback');
    expect(at060(true).kind).toBe('rollback');
    expect(upgradeStateOf({ ledgerExists: true, anyRow: true, newer: true, appComplete: true, appStepFailed: false })).toBe('ahead');
    // A workspace created on 0.6.1 is newer than the 0.6.0 sequence: unknown there (null), counted as past any 0.6.0 step.
    const seq060 = sequenceForVersions(['0.4.0', '0.5.0', '0.6.0']);
    expect(pendingWorkspaceSteps(seq060, '0.6.0', { name: '0.6.1_TypeOrmMigrations', status: 'completed' })).toBeNull();
    expect(cursorHasCompleted(seq060, '0.6.0', { name: '0.6.1_TypeOrmMigrations', status: 'completed' }, LAST_060)).toBe(true);
  });

  it('/healthz on a patch: ok once 0.6.1_TypeOrmMigrations completed, behind before, failed when it failed', () => {
    const state = (over: Partial<Parameters<typeof upgradeStateOf>[0]>) =>
      upgradeStateOf({ ledgerExists: true, anyRow: true, newer: false, appComplete: false, appStepFailed: false, workspaceStepFailed: false, ...over });
    expect(state({ appComplete: true })).toBe('ok');
    expect(state({})).toBe('behind');
    expect(state({ appStepFailed: true })).toBe('failed');
  });
});

describe('0.6.1 → 0.7.0 still runs the 0.7 commands', () => {
  const INSTANCE = { ...UPGRADE_COMMANDS, '0-7': [inst('HwsProbe', 1786900000000)] };
  const WORKSPACE = { ...WORKSPACE_UPGRADE_COMMANDS, '0-7': [wsc('Ws07Structural', 1786900000100, { sql: () => 'SELECT 1', run: undefined, structure: { level: 23, fingerprints: {} } }), wsc('Ws07Data', 1786900000200)] };
  const sequence = sequenceForVersions([...PREV_070, '0.7.0'], INSTANCE, WORKSPACE);

  it('the sequence holds 0.7.0 migrations, its instance command, then its workspace commands; levels 21, 22, 23', () => {
    expect(sequence.filter((s) => s.version === '0.7.0').map((s) => s.name)).toEqual([
      '0.7.0_TypeOrmMigrations',
      '0.7.0_HwsProbe_1786900000000',
      '0.7.0_Ws07Structural_1786900000100',
      '0.7.0_Ws07Data_1786900000200',
    ]);
    expect([...structureLevels(sequence).keys()]).toEqual([21, 22, 23]);
    expect(commandsForVersion('0.7.0', INSTANCE).map((c) => c.name)).toEqual(['HwsProbe']);
    expect(structuralCommands(WORKSPACE).map((s) => s.structure.level)).toEqual([21, 22, 23]);
  });

  it('accepted from 0.6.1; a workspace that finished 0.6.0, or was created on 0.6.1, runs exactly the 0.7.0 workspace commands', () => {
    expect(decideUpgradeStart(facts({ codeVersion: '0.7.0', previousVersions: PREV_070, complete: { '0.6.1': true, '0.6.0': true } }))).toMatchObject({ kind: 'continue', from: '0.6.1' });
    const want = ['0.7.0_Ws07Structural_1786900000100', '0.7.0_Ws07Data_1786900000200'];
    expect(names(pendingWorkspaceSteps(sequence, '0.7.0', { name: LAST_060, status: 'completed' }))).toEqual(want);
    expect(names(pendingWorkspaceSteps(sequence, '0.7.0', { name: '0.6.1_TypeOrmMigrations', status: 'completed' }))).toEqual(want);
  });
});

describe('registering commands for a patch release fails (typed)', () => {
  const patchInstance = { '0-6-1': [inst('Nope', 1786900000000)] };
  const patchWorkspace = { '0-6-1': [wsc('Nope', 1786900000000, { sql: () => 'SELECT 1', run: undefined, structure: { level: 23, fingerprints: {} } })] };

  it('a `<major>-<minor>-<patch>` key is a PatchReleaseCommandsError wherever a registry is read', () => {
    expect(() => registryKeyRelease('0-6-1')).toThrow(PatchReleaseCommandsError);
    expect(() => commandsForVersion('0.6.0', patchInstance)).toThrow(PatchReleaseCommandsError);
    expect(() => commandsForVersion('0.6.1', patchInstance)).toThrow(PatchReleaseCommandsError);
    expect(() => workspaceCommandsForVersion('0.6.1', patchWorkspace)).toThrow(PatchReleaseCommandsError);
    expect(() => sequenceForVersions([...PREV_061, '0.6.1'], { ...UPGRADE_COMMANDS, ...patchInstance })).toThrow(PatchReleaseCommandsError);
    expect(() => sequenceForVersions([...PREV_061, '0.6.1'], UPGRADE_COMMANDS, { ...WORKSPACE_UPGRADE_COMMANDS, ...patchWorkspace })).toThrow(PatchReleaseCommandsError);
    // A lone key never reaches a sort comparator: structuralCommands checks every key itself.
    expect(() => structuralCommands(patchWorkspace)).toThrow(PatchReleaseCommandsError);
    expect(() => codeWorkspaceStructureLevel({ ...WORKSPACE_UPGRADE_COMMANDS, ...patchWorkspace })).toThrow(PatchReleaseCommandsError);
    // An EMPTY patch bundle is refused too: a patch key may not exist at all.
    expect(() => assertRegistryKeys({ '0-6-1': [] })).toThrow(PatchReleaseCommandsError);
  });

  it('any other key shape is an UpgradeRegistryError; PatchReleaseCommandsError is one too; both refuse the start as config (64)', () => {
    for (const bad of ['0-6-0', '0.6', '0-06', 'x', '', '0-6-', '-6', '0_6']) {
      expect(errorName(() => registryKeyRelease(bad))).toBe('UpgradeRegistryError');
    }
    expect(registryKeyRelease('0-6')).toBe('0.6.0');
    expect(registryKeyRelease('10-12')).toBe('10.12.0');
    const patch = (() => {
      try {
        registryKeyRelease('0-6-1');
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(patch).toBeInstanceOf(UpgradeRegistryError);
    expect((patch as Error).name).toBe('PatchReleaseCommandsError');
    expect(outcomeOf(patch)).toBe('config');
    expect(outcomeOf(new UpgradeRegistryError('x'))).toBe('config');
    expect(STARTUP_EXIT_CODES.config).toBe(64);
  });

  it('L-1: UpgradeRun.beforeApply refuses a patch key FIRST, before any database read (fresh / no-ledger starts included)', async () => {
    const queries: string[] = [];
    const session: UpgradeSession = {
      upgradeSession: true,
      query: async (sql: string) => {
        queries.push(sql);
        throw new Error('no query expected');
      },
    };
    const input = { fresh: true, attribution: null, unrestrictedTarget: true };
    const viaWorkspace = new UpgradeRun({ codeVersion: '0.6.1', previousVersions: PREV_061, force: false, log: () => undefined, workspaceRegistry: { ...WORKSPACE_UPGRADE_COMMANDS, ...patchWorkspace } });
    await expect(viaWorkspace.beforeApply(session, input)).rejects.toBeInstanceOf(PatchReleaseCommandsError);
    const viaInstance = new UpgradeRun({ codeVersion: '0.6.0', force: false, log: () => undefined, registry: { ...UPGRADE_COMMANDS, ...patchInstance } });
    await expect(viaInstance.beforeApply(session, input)).rejects.toBeInstanceOf(PatchReleaseCommandsError);
    expect(queries).toEqual([]);
  });

  it("this code's real registries pass the key check", () => {
    expect(() => assertRegistryKeys(UPGRADE_COMMANDS)).not.toThrow();
    expect(() => assertRegistryKeys(WORKSPACE_UPGRADE_COMMANDS)).not.toThrow();
  });

  it('the test-probe seam refuses a patch code version instead of slipping probes into the minor bundle', () => {
    const probe = inst('Probe', 1799999990000);
    expect(() => withProbeCommands(UPGRADE_COMMANDS, '0.6.1', [probe])).toThrow(PatchReleaseCommandsError);
    expect(withProbeCommands(UPGRADE_COMMANDS, '0.6.0', [probe])['0-6']).toEqual([...(UPGRADE_COMMANDS['0-6'] ?? []), probe]);
  });
});

describe('security review of #219: M-1, L-2, I-2', () => {
  it('M-1: a previous patch counts as complete only with its minor .0; 0.7.0 after a --force 0.6.1 that left 0.6.0 unfinished: 65', () => {
    // The caller reads the .0 too (its instance step and every workspace's last 0.6.0 workspace command).
    expect(versionsToCheck('0.7.0', PREV_070)).toEqual(['0.6.1', '0.6.0', '0.7.0']);
    expect(versionsToCheck('0.6.2', [...PREV_070])).toEqual(['0.6.0', '0.6.1', '0.6.2']);
    const at070 = (complete: Record<string, boolean>, force = false) => decideUpgradeStart(facts({ codeVersion: '0.7.0', previousVersions: PREV_070, complete, force }));
    expect(() => at070({ '0.6.1': true, '0.6.0': false })).toThrow(UpgradeVersionTooOldError);
    expect(() => at070({ '0.6.1': true })).toThrow(UpgradeVersionTooOldError); // the .0 not read = not complete
    expect(at070({ '0.6.1': true, '0.6.0': true })).toMatchObject({ kind: 'continue', from: '0.6.1' });
    expect(at070({ '0.6.1': true, '0.6.0': false }, true).kind).toBe('forced');
    // 0.6.2 (accepts 0.6.0 and 0.6.1): the folded 0.6.1 no longer stands in for an unfinished 0.6.0.
    expect(() => decideUpgradeStart(facts({ codeVersion: '0.6.2', previousVersions: PREV_070, complete: { '0.6.1': true, '0.6.0': false } }))).toThrow(UpgradeVersionTooOldError);
  });

  it("M-1: the code version's own entry is never folded: a repeated start of the patch itself still continues", () => {
    expect(effectiveComplete('0.6.1', { '0.6.1': true, '0.6.0': false })).toEqual({ '0.6.1': true, '0.6.0': false });
    expect(effectiveComplete('0.7.0', { '0.6.1': true, '0.6.0': false, '0.7.0': true })).toEqual({ '0.6.1': false, '0.6.0': false, '0.7.0': true });
    expect(decideUpgradeStart(facts({ complete: { '0.6.0': false, '0.6.1': true } }))).toMatchObject({ kind: 'continue', from: '0.6.1' });
    expect(decideUpgradeStart(facts({ codeVersion: '0.7.0', previousVersions: PREV_070, complete: { '0.6.1': false, '0.6.0': false, '0.7.0': true } }))).toMatchObject({
      kind: 'continue',
      from: '0.7.0',
    });
  });

  it('L-2: the published list must be strictly ascending and duplicate-free (AppVersionError, 64), checked first', () => {
    const bad = ['0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.6.2'];
    expect(() => assertPreviousVersions(bad)).toThrow(AppVersionError);
    expect(() => decideUpgradeStart(facts({ codeVersion: '0.8.0', previousVersions: bad, fresh: true }))).toThrow(/strictly ascending/);
    expect(() => versionsToCheck('0.8.0', bad)).toThrow(AppVersionError);
    expect(() => assertPreviousVersions(['0.4.0', '0.5.0', '0.5.0'])).toThrow(AppVersionError);
    expect(() => assertPreviousVersions(['0.4.0', 'x'])).toThrow(AppVersionError);
    expect(() => assertPreviousVersions(CREWFLOW_PREVIOUS_VERSIONS)).not.toThrow();
    expect(() => assertPreviousVersions(PREV_070)).not.toThrow();
  });

  it('I-2: a rollback onto a patch image whose .0 is unpublished refuses (AppVersionError), it is not a rollback', () => {
    expect(() => decideUpgradeStart(facts({ previousVersions: ['0.4.0', '0.5.0'], newerVersions: ['0.7.0'] }))).toThrow(AppVersionError);
    expect(decideUpgradeStart(facts({ newerVersions: ['0.7.0'] })).kind).toBe('rollback');
  });
});
