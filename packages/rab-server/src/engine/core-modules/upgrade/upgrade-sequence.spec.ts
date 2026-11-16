import { createHash } from 'node:crypto';
import { commandStepName, instanceStepsForVersion, lastStepOfVersion, migrationsStepName, STEP_NAME_PATTERN, stepsForVersion, versionOfStep } from './upgrade-sequence';
import { PUBLISHED_VERSION_STEPS } from './upgrade-commands/published-steps';
import { CREWFLOW_PREVIOUS_VERSIONS, readAppVersion } from './upgrade-version';
import type { UpgradeCommand } from './upgrade-commands/upgrade-command';
import { UPGRADE_COMMANDS } from './upgrade-commands/registry';

const cmd = (name: string, timestamp: number): UpgradeCommand => ({ name, timestamp, run: async () => undefined });

describe('upgrade-sequence (Twenty upgrade-command-registry naming)', () => {
  it('names the migrations step and commands <version>_<Class>[_<ts>]', () => {
    expect(migrationsStepName('0.6.0')).toBe('0.6.0_TypeOrmMigrations');
    expect(commandStepName('0.6.0', cmd('FixThing', 1786721480000))).toBe('0.6.0_FixThing_1786721480000');
    expect(() => commandStepName('0.6.0', cmd('bad name', 1786721480000))).toThrow();
    expect(versionOfStep('0.6.0_FixThing_1786721480000')).toBe('0.6.0');
    expect(STEP_NAME_PATTERN.test('drop table')).toBe(false);
  });

  it('a version is its migrations step then its commands by timestamp; the last step decides completeness', () => {
    const registry = { '0-7': [cmd('Second', 1786721490000), cmd('First', 1786721480000)] };
    // Instance commands only here (no workspace registry): 0.7.0's real workspace command is covered by workspace-command-runner.spec.
    expect(stepsForVersion('0.7.0', registry, {})).toEqual(['0.7.0_TypeOrmMigrations', '0.7.0_First_1786721480000', '0.7.0_Second_1786721490000']);
    expect(lastStepOfVersion('0.7.0', registry, {})).toBe('0.7.0_Second_1786721490000');
    expect(lastStepOfVersion('0.4.0', registry, {})).toBe('0.4.0_TypeOrmMigrations');
  });

  it('every registered command has a valid, unique name and timestamp', () => {
    for (const [key, list] of Object.entries(UPGRADE_COMMANDS)) {
      expect(key).toMatch(/^\d+-\d+$/);
      const names = list.map((c) => commandStepName('0.6.0', c));
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe('published versions keep their steps (security review of the 0.7.0 release PR, L1)', () => {
  it('every previous version and the code version produce exactly their pinned, append-only steps', () => {
    const code = readAppVersion({});
    for (const v of [...CREWFLOW_PREVIOUS_VERSIONS, code]) {
      expect([v, PUBLISHED_VERSION_STEPS[v]]).toEqual([v, expect.any(Array)]);
      expect([v, stepsForVersion(v)]).toEqual([v, [...PUBLISHED_VERSION_STEPS[v]!]]);
    }
  });

  it('re-check R2: the steps of the PUBLISHED versions match a second, independent pin (sha256), so editing them needs two reviewed changes', () => {
    // Update this hash ONLY when a release is published (its version appended to CREWFLOW_PREVIOUS_VERSIONS); never to edit an
    // already published version's steps. (No CODEOWNERS file exists in this repository; adding one changes review rules for the
    // whole repository and is a lead / owner decision, so the second pin lives here.)
    const published = CREWFLOW_PREVIOUS_VERSIONS.map((v) => [v, PUBLISHED_VERSION_STEPS[v]]);
    expect(createHash('sha256').update(JSON.stringify(published)).digest('hex')).toBe('a04747d5d4aee8904252735c6e32f6ea3d9c5f16f49078bafba72f1642a192b8');
  });

  it('the HWS cutover stays registered while 0.7.0 is the code version or a previous one', () => {
    if ([...CREWFLOW_PREVIOUS_VERSIONS, readAppVersion({})].includes('0.7.0')) {
      expect((UPGRADE_COMMANDS['0-7'] ?? []).map((c) => c.name)).toContain('HwsCutover');
      expect(instanceStepsForVersion('0.7.0')).toContain('0.7.0_HwsCutover_1786721540100');
    }
  });
});
