import { SEMANTIC_GOLDEN_BY_MAJOR } from '../posture-drift/semantic-golden';
import { readSecurityPostureGoldens, selectSecurityPostureGolden } from '../typeorm/core/security-posture';
import {
  assertSupportedPostgresMajor,
  missingFingerprintVersions,
  SUPPORTED_FINGERPRINT_MAJORS,
  UnsupportedPostgresVersionError,
} from '../typeorm/workspace-schema/v1/expected-fingerprints';
import { structuralCommands } from '../../engine/core-modules/upgrade/workspace-structure-level';
import {
  isSupportedPostgresMajor,
  postgresMajorFromVersionNum,
  SUPPORTED_POSTGRES_MAJORS,
  SUPPORTED_POSTGRES_RANGE,
  unsupportedPostgresMessage,
} from './supported-majors';

describe('supported PostgreSQL majors: one list, every reviewed artefact present', () => {
  it('is 16, 17 and 18, and the fingerprint selector reads the same list', () => {
    expect([...SUPPORTED_POSTGRES_MAJORS]).toEqual([16, 17, 18]);
    expect(SUPPORTED_FINGERPRINT_MAJORS).toBe(SUPPORTED_POSTGRES_MAJORS);
    expect(SUPPORTED_POSTGRES_RANGE).toBe('16-18');
  });

  it.each([...SUPPORTED_POSTGRES_MAJORS])('PostgreSQL %d has every module fingerprint, every structure-level fingerprint and both goldens', (major) => {
    expect(missingFingerprintVersions(major)).toEqual([]);
    for (const s of structuralCommands()) expect([s.structure.level, s.structure.fingerprints[major]]).toEqual([s.structure.level, expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(SEMANTIC_GOLDEN_BY_MAJOR[major]?.length ?? 0).toBeGreaterThan(0);
    expect(selectSecurityPostureGolden(readSecurityPostureGoldens(), major).length).toBeGreaterThan(0);
  });

  it('refuses 14, 15, 19 and 20 with the supported range (the text every gate starts with)', () => {
    for (const major of [14, 15, 19, 20]) {
      expect(isSupportedPostgresMajor(major)).toBe(false);
      expect(() => assertSupportedPostgresMajor(major)).toThrow(UnsupportedPostgresVersionError);
      expect(() => assertSupportedPostgresMajor(major)).toThrow(`PostgreSQL ${major} is not supported; use 16-18 (PostgreSQL 16, 17 or 18).`);
    }
    for (const major of [16, 17, 18]) expect(isSupportedPostgresMajor(major)).toBe(true);
    expect(unsupportedPostgresMessage(null)).toBe('This PostgreSQL version is not supported; use 16-18 (PostgreSQL 16, 17 or 18).');
  });

  it('reads the major from server_version_num, and nothing from anything else', () => {
    expect(postgresMajorFromVersionNum(140011)).toBe(14);
    expect(postgresMajorFromVersionNum('160015')).toBe(16);
    expect(postgresMajorFromVersionNum(180001)).toBe(18);
    expect(postgresMajorFromVersionNum(190000)).toBe(19);
    for (const bad of [Number.NaN, '', null, undefined, '16.4', 90624, 1.5e6 + 0.5]) expect(postgresMajorFromVersionNum(bad)).toBeNull();
  });
});
