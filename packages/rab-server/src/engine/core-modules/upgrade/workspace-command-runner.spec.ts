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
import { assertOnlyTargetSchema, cursorHasCompleted, increasedCounters, metadataWriteProblems, pendingWorkspaceSteps, WorkspaceCommandRunner, WorkspaceRunFault, structureLevels, WorkspaceStepRefused, workspaceSchemaOf } from './workspace-command-runner';
import { LATEST_WORKSPACE_MODULE_VERSION, MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION, WORKSPACE_SCHEMA_MODULES } from '../../../database/typeorm/workspace-schema/workspace-schema-modules';
import { KNOWN_RAB_SETTINGS } from './workspace-step-checks-sql';
import { parseProvisionFunctionSource } from '../../../database/typeorm/workspace-schema/provision-function-versions';
import { assessSchemaCompatibility } from '../../../database/boot-checks/schema-compatibility';
import { codeWorkspaceStructureLevel, declaredFingerprint, declaredProvisionLiterals, structuralCommandsThrough } from './workspace-structure-level';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

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
const WORKSPACE = { '0-7': [wsc('WsB', 1786721490100), wsc('WsA', 1786721490000)], '0-8': [wsc('WsC', 1786721600000)] };
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

  it('0.6.0 has three workspace commands (level 21, 0b; level 22, 0a; then the M1 standard-object sync, data only): a new workspace starts after them, an adopted one before them', () => {
    expect(WORKSPACE_UPGRADE_COMMANDS['0-6'].map((c) => [c.name, c.timestamp, c.structure?.level, c.structure?.mayDrop === true, c.writesWorkspaceMetadata])).toEqual([
      ['StaffProfileMemberSelect', 1786721480000, 21, false, undefined],
      ['DropWorkspaceCoreForeignKeys', 1786721530000, 22, true, undefined],
      ['SyncStandardObjects', 1786721900000, undefined, false, true],
    ]);
    expect(lastStepOfVersion('0.6.0')).toBe('0.6.0_SyncStandardObjects_1786721900000');
    expect(lastInstanceStepOfVersion('0.6.0')).toBe('0.6.0_TypeOrmMigrations');
  });

  it('0.7.0 has two workspace commands (level 23, C3 Q3 DRAFT; level 24, #205 DRAFT), after the instance command of the release (the HWS cutover)', () => {
    expect(WORKSPACE_UPGRADE_COMMANDS['0-7'].map((c) => [c.name, c.timestamp, c.structure?.level, c.structure?.mayDrop === true, Boolean(c.precheck)])).toEqual([
      ['ValidateStaffProfileWorkspaceRequired', 1786721595000, 23, false, false],
      ['ShiftTeamSelectMultiRole', 1786721600000, 24, false, false],
    ]);
    expect(lastInstanceStepOfVersion('0.7.0')).toBe('0.7.0_HwsCutover_1786721540100');
    expect(lastStepOfVersion('0.7.0')).toBe('0.7.0_ShiftTeamSelectMultiRole_1786721600000');
  });

  it('the level-21 to level-24 commands declare a v2 fingerprint for every supported PostgreSQL major (16, 17, 18)', () => {
    for (const command of [...WORKSPACE_UPGRADE_COMMANDS['0-6'], ...WORKSPACE_UPGRADE_COMMANDS['0-7']].filter((c) => c.structure)) {
      const fps = command.structure!.fingerprints;
      expect(Object.keys(fps).sort()).toEqual(['16', '17', '18']);
      for (const v of Object.values(fps)) expect(v).toMatch(/^[0-9a-f]{64}$/);
      expect(new Set(Object.values(fps)).size).toBe(3);
    }
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

  it('only up to the code version runs: 0.8.0 commands are not run by a 0.7.0 image', () => {
    expect(names(pendingWorkspaceSteps(seq, '0.7.0', { name: '0.5.0_TypeOrmMigrations', status: 'completed' }))).toEqual(['0.7.0_WsA_1786721490000', '0.7.0_WsB_1786721490100']);
  });

  it("M4: an earlier version's failed step (e.g. after --force) runs again first, before the code version's steps", () => {
    expect(names(pendingWorkspaceSteps(seq, '0.8.0', { name: '0.7.0_WsA_1786721490000', status: 'failed' }))).toEqual([
      '0.7.0_WsA_1786721490000',
      '0.7.0_WsB_1786721490100',
      '0.8.0_WsC_1786721600000',
    ]);
    expect(names(pendingWorkspaceSteps(seq, '0.8.0', { name: '0.7.0_WsB_1786721490100', status: 'completed' }))).toEqual(['0.8.0_WsC_1786721600000']);
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


describe('Part D (review M3): the code structure level drives the gates', () => {
  const probe = (level: number, extra: Partial<WorkspaceUpgradeCommand['structure']> = {}): WorkspaceUpgradeCommand =>
    wsc(`Level${level}`, 1786721490000 + level, { sql: (x) => `SELECT '${x}'`, run: undefined, structure: { level, fingerprints: { 16: `fp${level}` }, ...extra } });

  it('20 with no structural command; 21, 22 with probes; a gap is refused', () => {
    expect(codeWorkspaceStructureLevel({})).toBe(20);
    expect(codeWorkspaceStructureLevel()).toBe(24);
    const reg = { '0-7': [probe(21, { provisionFunctionLiteral: 'db:provision_workspace@Probe1799999999991' })], '0-8': [probe(22)] };
    expect(codeWorkspaceStructureLevel(reg)).toBe(22);
    expect(structuralCommandsThrough(21, reg).map((s) => s.structure.level)).toEqual([21]);
    expect(declaredFingerprint(22, 16, reg)).toBe('fp22');
    expect(declaredFingerprint(22, 18, reg)).toBeUndefined();
    expect(declaredProvisionLiterals(reg)).toEqual({ 'db:provision_workspace@Probe1799999999991': 21 });
    expect(() => codeWorkspaceStructureLevel({ '0-7': [probe(22)] })).toThrow(/expected 21/);
  });

  it('the provision literal of a structural command maps to its level; the frozen literals keep theirs', () => {
    const extra = { 'db:provision_workspace@Probe1799999999991': 21 };
    expect(parseProvisionFunctionSource(`x 'db:provision_workspace@Probe1799999999991' y`, extra)).toMatchObject({ state: 'known', moduleVersion: 21 });
    expect(parseProvisionFunctionSource(`x 'db:provision_workspace@Probe1799999999991' y`)).toMatchObject({ state: 'unknown' });
    expect(parseProvisionFunctionSource(`'db:provision_workspace@WorkspaceGrantParityGuards1786721430000'`, extra)).toMatchObject({ moduleVersion: 20 });
  });

  it('a fleet at the code level is neither behind nor ahead; the start floor lets the runner bring 20 up to the code level', () => {
    const facts = { expected: [], applied: [], provisionFunction: { state: 'known' as const, literal: 'l', moduleVersion: 21 }, workspaces: [{ workspaceId: 'a', moduleVersion: 21 }] };
    expect(assessSchemaCompatibility('migrate-apply', facts, { production: false, latestModuleVersion: 21 }).refusals).toEqual([]);
    expect(assessSchemaCompatibility('migrate-apply', facts, { production: false, latestModuleVersion: 20 }).refusals.map((r) => r.finding)).toContain('workspace-ahead');
    const behind = { ...facts, workspaces: [{ workspaceId: 'a', moduleVersion: 20 }] };
    expect(assessSchemaCompatibility('migrate-apply', behind, { production: false, latestModuleVersion: 21 }).refusals.map((r) => r.finding)).toContain('workspace-behind');
    expect(assessSchemaCompatibility('migrate-apply', behind, { production: false, latestModuleVersion: 21, floorModuleVersion: 20 }).refusals).toEqual([]);
  });
});

/**
 * Metadata engine M1 / E2: the reviewed, I/O-free modules a command file may value-import besides its siblings (the standard
 * object sync reaches the database only through the `ctx.query` it is handed). Each one is scanned below with the same rules
 * (plus `node:crypto`, used to derive universal identifiers and row ids). Paths relative to rab-server/src.
 */
const SRC_ROOT = join(__dirname, '..', '..', '..');
const APPROVED_COMMAND_MODULES = [
  'engine/metadata/standard-objects/standard-object-sync.ts',
  'engine/metadata/standard-objects/standard-object-plan.ts',
  'engine/metadata/standard-objects/standard-universal-identifier.ts',
  'engine/metadata/standard-objects/standard-object-definition.ts',
  'database/typeorm/workspace-schema/standard-objects/standard-object-definitions.ts',
  'database/typeorm/workspace-schema/workspace-tables.ts',
];
const approved = (fromFile: string, spec: string) =>
  APPROVED_COMMAND_MODULES.includes(relative(SRC_ROOT, resolve(dirname(fromFile), `${spec}.ts`)).replace(/\\/g, '/'));

/** Review Info / N4: the source guard's scanner (pure; fixtures below). `file` resolves the approved non-sibling imports. */
function commandFileOffences(src: string, file?: string, allowedNode: readonly string[] = [], strict = false): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\s+from\s+['"]([^'"]+)['"]/gm)) {
    const isType = Boolean(m[2]);
    const spec = m[3]!;
    if (allowedNode.includes(spec)) continue;
    if (m[1] === 'export' && !isType) out.push(`re-export of ${spec}`);
    // strict (#166 F3, the approved modules themselves): EVERY value import must resolve into the approved list, siblings too.
    else if (!isType && (strict || !spec.startsWith('./')) && !(file && approved(file, spec))) out.push(`value import of ${spec}`);
    if (/^(pg|typeorm|@nestjs\/|node:|child_process|fs)/.test(spec)) out.push(`imports ${spec}`);
  }
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(`side-effect import of ${m[1]}`);
  if (/\bimport\s*\(/.test(src)) out.push('dynamic import()');
  if (/\brequire\s*\(/.test(src)) out.push('require()');
  if (/\b(DataSource|createQueryRunner|QueryRunner|new\s+Client\b|new\s+Pool\b|getConnection)\b/.test(src)) out.push('names a connection API');
  return out;
}

describe('Part D (review Info / N4): source guard on upgrade-commands/**', () => {
  const root = join(__dirname, 'upgrade-commands');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) && !/\.spec\.ts$/.test(n) ? [p] : [];
    });

  it('the scanner fires on every fixture (static, re-export, side-effect, dynamic import, require, connection APIs)', () => {
    expect(commandFileOffences(`import { Client } from 'pg';`)).toEqual(expect.arrayContaining(['value import of pg', 'imports pg']));
    expect(commandFileOffences(`export { x } from '../somewhere';`)).toEqual(['re-export of ../somewhere']);
    expect(commandFileOffences(`export * from 'typeorm';`)).toEqual(expect.arrayContaining(['re-export of typeorm', 'imports typeorm']));
    expect(commandFileOffences(`import 'pg';`)).toEqual(['side-effect import of pg']);
    expect(commandFileOffences(`const pg = await import('pg');`)).toEqual(['dynamic import()']);
    expect(commandFileOffences(`const pg = require('pg');`)).toEqual(['require()']);
    expect(commandFileOffences(`const r = ds.createQueryRunner();`)).toEqual(['names a connection API']);
    expect(commandFileOffences(`import type { Query } from '../upgrade-migration.service';\nimport { A } from './0-6';`)).toEqual([]);
  });

  it('command files import only types (or sibling command folders, or the approved pure modules) and never reach a connection, a driver or Nest', () => {
    const offenders = files(root).flatMap((f) => commandFileOffences(readFileSync(f, 'utf8'), f).map((o) => `${f}: ${o}`));
    expect(offenders).toEqual([]);
  });

  it('M1 / E2: a non-sibling value import is allowed only for the approved modules', () => {
    const cmd = join(root, '0-6', 'x.ts');
    expect(commandFileOffences(`import { syncStandardObjects } from '../../../../metadata/standard-objects/standard-object-sync';`, cmd)).toEqual([]);
    expect(commandFileOffences(`import { x } from '../../../../metadata/standard-objects/other';`, cmd)).toEqual(['value import of ../../../../metadata/standard-objects/other']);
  });

  it('M1 / E2: the approved modules are themselves pure (value imports only of each other and node:crypto; no driver, Nest, fs or connection)', () => {
    const offenders = APPROVED_COMMAND_MODULES.flatMap((rel) => {
      const f = join(SRC_ROOT, rel);
      return commandFileOffences(readFileSync(f, 'utf8'), f, ['node:crypto'], true).map((o) => `${rel}: ${o}`);
    });
    expect(offenders).toEqual([]);
  });

  it('#166 F3: in strict mode a sibling value import outside the approved list is an offence (fixture)', () => {
    const mod = join(SRC_ROOT, 'engine/metadata/standard-objects/standard-object-sync.ts');
    expect(commandFileOffences(`import { x } from './standard-object-plan';`, mod, ['node:crypto'], true)).toEqual([]);
    expect(commandFileOffences(`import { y } from './standard-objects-new-workspace';`, mod, ['node:crypto'], true)).toEqual(['value import of ./standard-objects-new-workspace']);
    expect(commandFileOffences(`import { Pool } from 'pg';`, mod, ['node:crypto'], true)).toEqual(expect.arrayContaining(['value import of pg', 'imports pg']));
    expect(commandFileOffences(`import { readFileSync } from 'node:fs';`, mod, ['node:crypto'], true)).toEqual(expect.arrayContaining(['imports node:fs']));
  });
});

describe('Part D (review N4): a structural command cannot land unreviewed', () => {
  /** Raise ONLY together with a review of MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION (D-RUNNER.md §5.3 step 4). */
  // 21 since StaffProfileMemberSelect (0b), 22 since DropWorkspaceCoreForeignKeys (0a), 23 since
  // ValidateStaffProfileWorkspaceRequired (C3 Q3, DRAFT), 24 since ShiftTeamSelectMultiRole (#205, DRAFT). Reviewed floor: 20 —
  // this code reads nothing level 21-24 creates (a member policy that fails closed when absent; dropped constraints; a CHECK
  // that is enforced on every write either way; below 24 the shift-team policy still matches single-role staff and shows a
  // multi-role caller only their own row, fail closed), and a workspace below the code level is BLOCKED by the runner
  // (review P1). The pair is pinned explicitly, never derived.
  const REVIEWED_STRUCTURE_LEVEL = 24;
  const REVIEWED_ROUTING_FLOOR = 20;
  it('the code structure level and the routing floor equal their reviewed values', () => {
    expect(codeWorkspaceStructureLevel()).toBe(REVIEWED_STRUCTURE_LEVEL);
    expect(MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION).toBe(REVIEWED_ROUTING_FLOOR);
    expect(MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION).toBeLessThanOrEqual(REVIEWED_STRUCTURE_LEVEL);
  });
});

describe('Part D (review N3): the session checks know every rab.* setting the code uses', () => {
  const SRC = join(__dirname, '..', '..', '..');
  const all = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return n === 'node_modules' || n === 'dist' ? [] : all(p);
      return /\.ts$/.test(n) ? [p] : [];
    });
  it('every literal rab.<name> in packages/rab-server/src is in KNOWN_RAB_SETTINGS', () => {
    const seen = new Set<string>();
    for (const f of all(SRC)) for (const m of readFileSync(f, 'utf8').matchAll(/'(rab\.[a-z_]+)'/g)) seen.add(m[1]!);
    const known = new Set<string>(KNOWN_RAB_SETTINGS);
    // 'rab.com' is an e-mail / host name in fixtures, not a setting.
    expect([...seen].filter((n) => !known.has(n) && n !== 'rab.com').sort()).toEqual([]);
  });
});

describe('Part D (review N1): no write counters, no workspace steps', () => {
  it('track_counts = off is a run-level fault before anything runs', async () => {
    const seen: string[] = [];
    const session = {
      upgradeSession: true as const,
      query: async (sql: string) => {
        seen.push(sql);
        return sql.includes('track_counts') ? [{ track_counts: 'off' }] : [];
      },
    };
    const runner = new WorkspaceCommandRunner({ codeVersion: '0.6.0', versions: ['0.4.0', '0.5.0'], force: false, adopt: true, log: () => undefined });
    await expect(runner.run(session)).rejects.toBeInstanceOf(WorkspaceRunFault);
    expect(seen).toHaveLength(1);
  });
});

describe('Part D (review M1): write counters are compared as a delta', () => {
  it('only an increase counts (earlier, unflushed transactions are a constant offset)', () => {
    const before = [{ relid: '1', what: 'core.a', n: '5' }];
    expect(increasedCounters(before, [{ relid: '1', what: 'core.a', n: '5' }])).toEqual([]);
    expect(increasedCounters(before, [{ relid: '1', what: 'core.a', n: '6' }])).toEqual(['core.a']);
    expect(increasedCounters(before, [{ relid: '1', what: 'core.a', n: '5' }, { relid: '2', what: 'core.b', n: '1' }])).toEqual(['core.b']);
  });
});

describe('#166 F2: only data steps may write metadata', () => {
  it('the flagged commands across every release are exactly [SyncStandardObjects]', () => {
    const flagged = Object.values(WORKSPACE_UPGRADE_COMMANDS).flat().filter((c) => c.writesWorkspaceMetadata).map((c) => c.name);
    expect(flagged).toEqual(['SyncStandardObjects']);
    expect(Object.values(WORKSPACE_UPGRADE_COMMANDS).flat().filter((c) => c.writesWorkspaceMetadata && c.structure)).toEqual([]);
  });
  it('a command declaring both a structure level and writesWorkspaceMetadata is refused before any statement', async () => {
    const runner = new WorkspaceCommandRunner({ codeVersion: '0.7.0', versions: ['0.6.0'], force: false, adopt: false, log: () => undefined });
    const query = jest.fn(async () => []);
    const both = wsc('Both', 1786721999000, { structure: { level: 22, fingerprints: {} }, writesWorkspaceMetadata: true });
    const run = (runner as unknown as { runStep: (...a: unknown[]) => Promise<void> }).runStep(
      { query },
      { workspaceId: 'w', organisationId: 'o', schemaName: 'workspace_' + '0'.repeat(32), moduleVersion: 21 },
      '0.7.0_Both_1786721999000',
      both,
      new Map(),
    );
    await expect(run).rejects.toMatchObject({ errorClass: 'METADATA_WRITE_IN_STRUCTURAL_STEP' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('M1 / E2: metadata writes of a writesWorkspaceMetadata step must be the target workspace\'s own rows', () => {
  const row = (name: string, ins: number, upd: number, del: number, relid: string | null = name.length.toString()) => ({ name, relid, ins: String(ins), upd: String(upd), del: String(del) });
  const at = (o: number, f: number, opt: number, s: number, d = 0) => [row('object_metadata', 7 + o, 1, 0), row('field_metadata', f, 3, d), row('field_metadata_option', opt, 0, 0), row('workspace_metadata_state', 2, s, 0)];
  const before = at(0, 0, 0, 0);
  it('counter deltas equal to the rows visible in the target: allowed (an earlier unflushed offset does not count)', () => {
    expect(metadataWriteProblems(before, at(25, 340, 80, 1), { object_metadata: '25', field_metadata: '340', field_metadata_option: '80', workspace_metadata_state: '1' })).toEqual([]);
    expect(metadataWriteProblems(before, before, { object_metadata: '0', field_metadata: '0', field_metadata_option: '0', workspace_metadata_state: '0' })).toEqual([]);
  });
  it('a write the target binding cannot see (another workspace\'s row) is refused', () => {
    expect(metadataWriteProblems(before, at(26, 340, 80, 1), { object_metadata: '25', field_metadata: '340', field_metadata_option: '80', workspace_metadata_state: '1' })).toEqual([
      'core.object_metadata: 26 row write(s), 25 visible in this workspace',
    ]);
  });
  it('any delete is refused, and a missing table is refused', () => {
    expect(metadataWriteProblems(before, at(0, 0, 0, 0, 1), { object_metadata: '0', field_metadata: '0', field_metadata_option: '0', workspace_metadata_state: '0' })).toEqual(['core.field_metadata: 1 row(s) deleted']);
    expect(metadataWriteProblems([...before.slice(0, 3), row('workspace_metadata_state', 0, 0, 0, null)], before, {})).toEqual(['core.workspace_metadata_state missing']);
    const noState = [...before.slice(0, 3), row('workspace_metadata_state', 0, 0, 0, null)];
    expect(metadataWriteProblems(noState, noState, { object_metadata: '0', field_metadata: '0', field_metadata_option: '0' })).toEqual([]);
    const noObjects = [row('object_metadata', 0, 0, 0, null), ...before.slice(1)];
    expect(metadataWriteProblems(noObjects, noObjects, {})).toEqual(['core.object_metadata missing']);
  });
});

describe('Part D test hooks cannot be enabled in a production build (review)', () => {
  it('runMigrateOnStart refuses deps.testWorkspace unless NODE_ENV=test (exit 64, before any connection)', async () => {
    const { runMigrateOnStart } = await import('../../../database/typeorm/scripts/migrate/owner-login/migrate-on-start');
    const lines: string[] = [];
    const result = await runMigrateOnStart(
      { migrationApprovalMode: 'none' },
      { env: { NODE_ENV: 'production' }, log: (l) => lines.push(l), testWorkspace: { registry: {}, workspaceIds: [] } },
    );
    expect(result.outcome).toBe('config');
    expect(lines.join('\n')).toMatch(/testWorkspace hook is a test seam/);
  });

  it('the TypeScript provisioner refuses options.workspaceRegistry unless NODE_ENV=test, before touching the database', async () => {
    const { provisionWorkspaceSchema, WorkspaceSchemaProvisioningError } = await import('../../../database/typeorm/workspace-schema/provision-workspace-schema');
    const before = process.env.NODE_ENV;
    const client = { query: jest.fn() };
    process.env.NODE_ENV = 'production';
    try {
      await expect(provisionWorkspaceSchema(client as never, '11111111-1111-4111-8111-111111111111', { workspaceRegistry: {} })).rejects.toBeInstanceOf(WorkspaceSchemaProvisioningError);
    } finally {
      process.env.NODE_ENV = before;
    }
    expect(client.query).not.toHaveBeenCalled();
  });

  it('no environment / configuration path reaches either hook: only specs pass them', () => {
    const SRC = join(__dirname, '..', '..', '..');
    const all = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) return n === 'node_modules' || n === 'dist' ? [] : all(p);
        return /\.ts$/.test(n) && !/\.spec\.ts$/.test(n) && !p.includes('__tests__') ? [p] : [];
      });
    const offenders: string[] = [];
    for (const f of all(SRC)) {
      const src = readFileSync(f, 'utf8');
      const rel = f.split(String.fromCharCode(92)).join('/');
      if (/testWorkspace/.test(src) && !rel.endsWith('migrate/owner-login/migrate-on-start.ts')) offenders.push(`${rel}: testWorkspace`);
      if (/workspaceRegistry\s*:/.test(src) && /provisionWorkspaceSchema\(/.test(src) && !rel.endsWith('workspace-schema/provision-workspace-schema.ts')) offenders.push(`${rel}: workspaceRegistry`);
      if (/process\.env\.[A-Z_]*(TEST_WORKSPACE|WORKSPACE_REGISTRY)/.test(src)) offenders.push(`${rel}: env`);
    }
    expect(offenders).toEqual([]);
  });
});
