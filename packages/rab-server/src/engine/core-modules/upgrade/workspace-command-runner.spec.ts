import type { UpgradeCommand } from './upgrade-commands/upgrade-command';
import type { WorkspaceUpgradeCommand } from './upgrade-commands/workspace-upgrade-command';
import { UPGRADE_COMMANDS, WORKSPACE_UPGRADE_COMMANDS } from './upgrade-commands/registry';
import {
  commandStepName,
  lastInstanceStepOfVersion,
  lastStepOfVersion,
  lastWorkspaceStepOfVersion,
  sequenceForVersions,
  stepsForVersion,
} from './upgrade-sequence';
import { upgradeStateOf } from './upgrade-status.service';
import { assertOnlyTargetSchema, cursorHasCompleted, pendingWorkspaceSteps, structureLevels, WorkspaceStepRefused, workspaceSchemaOf } from './workspace-command-runner';
import { LATEST_WORKSPACE_MODULE_VERSION, WORKSPACE_SCHEMA_MODULES } from '../../../database/typeorm/workspace-schema/workspace-schema-modules';

/** OWNER-DB-ULTIMATE Part D: the pure parts of the workspace command runner and the sequence (no database). */
const inst = (name: string, timestamp: number): UpgradeCommand => ({ name, timestamp, run: async () => undefined });
const wsc = (name: string, timestamp: number, extra: Partial<WorkspaceUpgradeCommand> = {}): WorkspaceUpgradeCommand => ({
  kind: 'workspace',
  name,
  timestamp,
  run: async () => undefined,
  ...extra,
});

const INSTANCE = { '0-7': [inst('InstA', 1786721480000)] };
const WORKSPACE = { '0-7': [wsc('WsB', 1786721490100), wsc('WsA', 1786721490000)], '0-8': [wsc('WsC', 1786721590000)] };
const VERSIONS = ['0.5.0', '0.6.0', '0.7.0', '0.8.0'];

describe('Part D: workspace upgrade commands in the sequence (Twenty upgrade-sequence-reader.service.ts:39-60)', () => {
  it('a version is migrations, instance commands, then workspace commands, each by timestamp', () => {
    expect(stepsForVersion('0.7.0', INSTANCE, WORKSPACE)).toEqual([
      '0.7.0_TypeOrmMigrations',
      '0.7.0_InstA_1786721480000',
      '0.7.0_WsA_1786721490000',
      '0.7.0_WsB_1786721490100',
    ]);
    expect(lastStepOfVersion('0.7.0', INSTANCE, WORKSPACE)).toBe('0.7.0_WsB_1786721490100');
    expect(lastInstanceStepOfVersion('0.7.0', INSTANCE)).toBe('0.7.0_InstA_1786721480000');
    expect(lastWorkspaceStepOfVersion('0.7.0', WORKSPACE)).toBe('0.7.0_WsB_1786721490100');
    expect(lastWorkspaceStepOfVersion('0.6.0', WORKSPACE)).toBeNull();
  });

  it('0.6.0 has no workspace command: its last step is still the migrations step (Part B behaviour unchanged)', () => {
    expect(WORKSPACE_UPGRADE_COMMANDS['0-6']).toEqual([]);
    expect(lastStepOfVersion('0.6.0')).toBe('0.6.0_TypeOrmMigrations');
    expect(lastInstanceStepOfVersion('0.6.0')).toBe('0.6.0_TypeOrmMigrations');
  });

  it('every registered workspace command has a valid, unique name; no name collides with an instance command', () => {
    for (const [key, list] of Object.entries(WORKSPACE_UPGRADE_COMMANDS)) {
      expect(key).toMatch(/^\d+-\d+$/);
      const names = [...(UPGRADE_COMMANDS[key] ?? []), ...list].map((c) => commandStepName('0.6.0', c));
      expect(new Set(names).size).toBe(names.length);
      for (const c of list) {
        expect(c.kind).toBe('workspace');
        expect(Boolean(c.sql) !== Boolean(c.run)).toBe(true);
      }
    }
    expect(() => structureLevels(sequenceForVersions(['0.6.0']))).not.toThrow();
  });

  it('the workspace-module list is FROZEN at 20: new workspace DDL ships as a workspace upgrade command', () => {
    expect(WORKSPACE_SCHEMA_MODULES).toHaveLength(20);
    expect(LATEST_WORKSPACE_MODULE_VERSION).toBe(20);
    expect(WORKSPACE_SCHEMA_MODULES[19]!.id).toBe('v1.020-grant-parity-guards');
  });

  it('a duplicate step name across versions is refused', () => {
    expect(() => sequenceForVersions(['0.7.0'], { '0-7': [inst('X', 1786721480000)] }, { '0-7': [wsc('X', 1786721480000)] })).toThrow(/duplicate/);
  });
});

describe('Part D: pending commands from the cursor (Twenty getPendingWorkspaceCommands :155-173)', () => {
  const seq = sequenceForVersions(VERSIONS, INSTANCE, WORKSPACE);
  const names = (steps: ReturnType<typeof pendingWorkspaceSteps>) => steps?.map((s) => s.name) ?? null;

  it('an adopted / new workspace at the previous version runs all of this version, completed after the cursor, failed from it', () => {
    expect(names(pendingWorkspaceSteps(seq, '0.7.0', { name: '0.6.0_TypeOrmMigrations', status: 'completed' }))).toEqual(['0.7.0_WsA_1786721490000', '0.7.0_WsB_1786721490100']);
    expect(names(pendingWorkspaceSteps(seq, '0.7.0', { name: '0.7.0_WsA_1786721490000', status: 'completed' }))).toEqual(['0.7.0_WsB_1786721490100']);
    expect(names(pendingWorkspaceSteps(seq, '0.7.0', { name: '0.7.0_WsA_1786721490000', status: 'failed' }))).toEqual(['0.7.0_WsA_1786721490000', '0.7.0_WsB_1786721490100']);
    expect(names(pendingWorkspaceSteps(seq, '0.7.0', { name: '0.7.0_WsB_1786721490100', status: 'completed' }))).toEqual([]);
  });

  it('a new workspace created on 0.7.0 starts at the last step and runs none of 0.7.0', () => {
    expect(names(pendingWorkspaceSteps(seq, '0.7.0', { name: lastStepOfVersion('0.7.0', INSTANCE, WORKSPACE), status: 'completed' }))).toEqual([]);
  });

  it('only the code version runs: 0.8.0 commands are not run by a 0.7.0 image', () => {
    expect(names(pendingWorkspaceSteps(seq, '0.7.0', { name: '0.5.0_TypeOrmMigrations', status: 'completed' }))).toEqual(['0.7.0_WsA_1786721490000', '0.7.0_WsB_1786721490100']);
  });

  it('a cursor this code does not know returns null (refused or rollback, decided by the runner)', () => {
    expect(pendingWorkspaceSteps(seq, '0.7.0', { name: '0.9.0_Future_1799999999999', status: 'completed' })).toBeNull();
    expect(pendingWorkspaceSteps(seq, '0.7.0', { name: '0.7.0_Unknown_1786721499999', status: 'completed' })).toBeNull();
  });

  it('cursorHasCompleted: by position (a workspace created later counts), a failed cursor at the step does not', () => {
    const last07 = '0.7.0_WsB_1786721490100';
    expect(cursorHasCompleted(seq, '0.8.0', { name: last07, status: 'completed' }, last07)).toBe(true);
    expect(cursorHasCompleted(seq, '0.8.0', { name: last07, status: 'failed' }, last07)).toBe(false);
    expect(cursorHasCompleted(seq, '0.8.0', { name: '0.7.0_WsA_1786721490000', status: 'completed' }, last07)).toBe(false);
    expect(cursorHasCompleted(seq, '0.8.0', { name: '0.8.0_TypeOrmMigrations', status: 'completed' }, last07)).toBe(true);
    expect(cursorHasCompleted(seq, '0.8.0', undefined, last07)).toBe(false);
    expect(cursorHasCompleted(seq, '0.8.0', { name: '0.9.0_Future_1799999999999', status: 'completed' }, last07)).toBe(true);
  });
});

describe('Part D: structure levels and isolation (pure)', () => {
  it('structural commands must declare level 21, 22, … in sequence order', () => {
    const ok = { '0-7': [wsc('S1', 1786721490000, { structure: { level: 21, fingerprints: { 16: 'a' } } }), wsc('D1', 1786721490100)] };
    expect([...structureLevels(sequenceForVersions(['0.7.0'], {}, ok)).keys()]).toEqual([21]);
    const gap = { '0-7': [wsc('S1', 1786721490000, { structure: { level: 22, fingerprints: {} } })] };
    expect(() => structureLevels(sequenceForVersions(['0.7.0'], {}, gap))).toThrow(/expected 21/);
  });

  it('layer 1: SQL naming another workspace schema is refused before it runs (any case), the target is allowed', () => {
    const a = workspaceSchemaOf('11111111-1111-4111-8111-111111111111');
    const b = workspaceSchemaOf('22222222-2222-4222-8222-222222222222');
    expect(() => assertOnlyTargetSchema(`ALTER TABLE ${a}.shift ADD COLUMN IF NOT EXISTS x int`, a)).not.toThrow();
    expect(() => assertOnlyTargetSchema(`UPDATE ${b}.shift SET notes = ''`, a)).toThrow(WorkspaceStepRefused);
    expect(() => assertOnlyTargetSchema(`UPDATE "${b.toUpperCase()}".shift SET notes = ''`, a)).toThrow(/FOREIGN_SCHEMA_NAME/);
    expect(() => workspaceSchemaOf('not-a-uuid')).toThrow();
  });
});

describe('Part D: status (Twenty per-workspace upgrade status)', () => {
  const base = { ledgerExists: true, anyRow: true, newer: false, appComplete: true, appStepFailed: false };
  it('a failed workspace step of the app version turns ok into failed; without it Part B is unchanged', () => {
    expect(upgradeStateOf(base)).toBe('ok');
    expect(upgradeStateOf({ ...base, workspaceStepFailed: true })).toBe('failed');
    expect(upgradeStateOf({ ...base, appComplete: false })).toBe('behind');
    expect(upgradeStateOf({ ...base, newer: true, workspaceStepFailed: true })).toBe('ahead');
  });
});
