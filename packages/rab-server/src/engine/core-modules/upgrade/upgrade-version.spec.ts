import { ADOPTION_VERSION_BY_RELEASE, AppVersionError, compareVersions, CREWFLOW_PREVIOUS_VERSIONS, majorMinorKey, readAppVersion, upgradeFromVersions } from './upgrade-version';

describe('upgrade-version (OWNER-DB-ULTIMATE Part B3)', () => {
  it('compares MAJOR.MINOR.PATCH numerically and refuses anything else', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.6.0', '0.6.0')).toBe(0);
    expect(compareVersions('0.5.0', '0.6.0')).toBe(-1);
    for (const bad of ['0.06.0', '1.2', 'v1.2.3', '1.2.3-rc1', '']) expect(() => compareVersions(bad, '0.1.0')).toThrow(AppVersionError);
  });

  it('records R254 = 0.4.0 and R256 = 0.5.0 as the previous versions', () => {
    expect(CREWFLOW_PREVIOUS_VERSIONS).toEqual(['0.4.0', '0.5.0']);
    expect(ADOPTION_VERSION_BY_RELEASE).toEqual({ R254: '0.4.0', R256: '0.5.0' });
  });

  it('0.6.0 (adoption) upgrades from 0.4.0 or 0.5.0; later releases only from the immediately previous one', () => {
    expect(upgradeFromVersions('0.6.0')).toEqual(['0.4.0', '0.5.0']);
    expect(upgradeFromVersions('0.7.0', ['0.4.0', '0.5.0', '0.6.0'])).toEqual(['0.6.0']);
  });

  it('majorMinorKey names the upgrade-commands folder', () => {
    expect(majorMinorKey('0.6.3')).toBe('0-6');
  });

  it('reads CREWFLOW_APP_VERSION when set (strictly), else the root package.json', () => {
    expect(readAppVersion({ CREWFLOW_APP_VERSION: '0.6.0' })).toBe('0.6.0');
    expect(() => readAppVersion({ CREWFLOW_APP_VERSION: '0.6' })).toThrow(AppVersionError);
    expect(readAppVersion({})).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
