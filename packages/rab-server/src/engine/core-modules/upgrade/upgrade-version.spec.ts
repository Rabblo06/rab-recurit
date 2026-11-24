import { ADOPTION_VERSION_BY_RELEASE, AppVersionError, compareVersions, CREWFLOW_PREVIOUS_VERSIONS, CREWFLOW_UPGRADE_FROM_VERSIONS, isPatchRelease, majorMinorKey, minorReleaseOf, readAppVersion, upgradeFromVersions } from './upgrade-version';

describe('upgrade-version (OWNER-DB-ULTIMATE Part B3)', () => {
  it('compares MAJOR.MINOR.PATCH numerically and refuses anything else', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.6.0', '0.6.0')).toBe(0);
    expect(compareVersions('0.5.0', '0.6.0')).toBe(-1);
    for (const bad of ['0.06.0', '1.2', 'v1.2.3', '1.2.3-rc1', '']) expect(() => compareVersions(bad, '0.1.0')).toThrow(AppVersionError);
  });

  it('records R254 = 0.4.0, R256 = 0.5.0 and the adoption release 0.6.0 as the previous versions (0.7.0: C3 switched on)', () => {
    expect(CREWFLOW_PREVIOUS_VERSIONS).toEqual(['0.4.0', '0.5.0', '0.6.0']);
    expect(readAppVersion({})).toBe('0.7.0');
    // From 0.7.0 on, strict: only a database that completed 0.6.0.
    expect(upgradeFromVersions(readAppVersion({}))).toEqual(['0.6.0']);
    expect(ADOPTION_VERSION_BY_RELEASE).toEqual({ R254: '0.4.0', R256: '0.5.0' });
  });

  it('0.6.0 (adoption) upgrades from 0.4.0 or 0.5.0; a later minor release only from the versions on its reviewed list', () => {
    expect(upgradeFromVersions('0.6.0')).toEqual(['0.4.0', '0.5.0']);
    expect(CREWFLOW_UPGRADE_FROM_VERSIONS).toEqual({ '0.6.0': ['0.4.0', '0.5.0'], '0.7.0': ['0.6.0'] });
    expect(upgradeFromVersions('0.7.0', ['0.4.0', '0.5.0', '0.6.0'], { '0.7.0': ['0.6.0'] })).toEqual(['0.6.0']);
    // No reviewed list for the release: refused (config, 64), never a guessed default.
    expect(() => upgradeFromVersions('0.7.0', ['0.4.0', '0.5.0', '0.6.0'], { '0.6.0': ['0.4.0', '0.5.0'] })).toThrow(/CREWFLOW_UPGRADE_FROM_VERSIONS\['0\.7\.0'\] is missing/);
  });

  it('release 0.7.0: the shipped list accepts an upgrade from 0.6.0 (every published 0.6.x) and nothing older', () => {
    expect(CREWFLOW_UPGRADE_FROM_VERSIONS['0.7.0']).toEqual(['0.6.0']);
    // The shipped defaults (CREWFLOW_PREVIOUS_VERSIONS + CREWFLOW_UPGRADE_FROM_VERSIONS): no AppVersionError (exit 64).
    expect(upgradeFromVersions('0.7.0')).toEqual(['0.6.0']);
    expect(upgradeFromVersions('0.7.0')).not.toContain('0.5.0');
    expect(upgradeFromVersions('0.7.0')).not.toContain('0.4.0');
  });

  it('a patch release (0.6.1) upgrades from the earlier published versions of its own minor line only; its .0 must be published', () => {
    expect(upgradeFromVersions('0.6.1', ['0.4.0', '0.5.0', '0.6.0'])).toEqual(['0.6.0']);
    expect(upgradeFromVersions('0.6.2', ['0.4.0', '0.5.0', '0.6.0', '0.6.1'])).toEqual(['0.6.0', '0.6.1']);
    expect(() => upgradeFromVersions('0.6.1', ['0.4.0', '0.5.0'])).toThrow(AppVersionError);
    expect([isPatchRelease('0.6.1'), isPatchRelease('0.7.0'), minorReleaseOf('0.6.1')]).toEqual([true, false, '0.6.0']);
  });

  it('majorMinorKey names the upgrade-commands folder', () => {
    expect(majorMinorKey('0.6.3')).toBe('0-6');
  });

  it('reads CREWFLOW_APP_VERSION when set (strictly), else the root package.json', () => {
    const shipped = readAppVersion({});
    expect(shipped).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readAppVersion({ CREWFLOW_APP_VERSION: shipped })).toBe(shipped);
    expect(() => readAppVersion({ CREWFLOW_APP_VERSION: '0.6' })).toThrow(AppVersionError);
  });

  it('review R3: CREWFLOW_APP_VERSION set but no root package.json to verify it against refuses (fail closed)', () => {
    const nowhere = require('node:os').tmpdir() as string;
    expect(() => readAppVersion({ CREWFLOW_APP_VERSION: '0.6.0' }, nowhere)).toThrow(/root package.json was not found, so the value cannot be verified/);
    expect(() => readAppVersion({}, nowhere)).toThrow(AppVersionError);
  });

  it('security review I3: a CREWFLOW_APP_VERSION that differs from the shipped package.json refuses (config, 64)', () => {
    expect(() => readAppVersion({ CREWFLOW_APP_VERSION: '9.9.9' })).toThrow(/differs from this code's release version/);
    expect(() => readAppVersion({ CREWFLOW_APP_VERSION: '9.9.9' })).toThrow(AppVersionError);
  });
});
