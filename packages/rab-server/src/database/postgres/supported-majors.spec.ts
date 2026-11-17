import { readFileSync } from 'fs';
import { join } from 'path';

import { SEMANTIC_GOLDEN_BY_MAJOR } from '../posture-drift/semantic-golden';
import { readSecurityPostureGoldens, selectSecurityPostureGolden } from '../typeorm/core/security-posture';
import {
  assertSupportedPostgresMajor,
  missingFingerprintVersions,
  resetWorkspaceFingerprintSelectionForTests,
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

  it('I3: the selection reset is a test seam, refused outside NODE_ENV=test', () => {
    const before = process.env.NODE_ENV;
    try {
      for (const env of ['production', 'development', '']) {
        process.env.NODE_ENV = env;
        expect(() => resetWorkspaceFingerprintSelectionForTests()).toThrow(/test seam: only NODE_ENV=test/);
      }
    } finally {
      process.env.NODE_ENV = before;
    }
    expect(() => resetWorkspaceFingerprintSelectionForTests()).not.toThrow();
  });

  it('L2: both provider-admin psql scripts refuse outside the same range, before CREATE ROLE', () => {
    const dir = join(__dirname, '..', '..', '..', '..', 'rab-docker', 'postgres-init', 'owner-login');
    for (const file of ['01-crewflow-owner.sql', 'transition-from-separated.sql']) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const guard = sql.indexOf(`/ 10000 BETWEEN ${SUPPORTED_POSTGRES_MAJORS[0]} AND ${SUPPORTED_POSTGRES_MAJORS[SUPPORTED_POSTGRES_MAJORS.length - 1]} AS crewflow_pg_supported \\gset`);
      expect([file, guard > 0]).toEqual([file, true]);
      expect(sql.indexOf('SELECT 1 / 0 AS refused_unsupported_postgresql_version')).toBeGreaterThan(guard);
      expect(sql.indexOf('CREATE ROLE crewflow_owner')).toBeGreaterThan(sql.indexOf('refused_unsupported_postgresql_version'));
      expect(sql).toContain(`is not supported; use ${SUPPORTED_POSTGRES_RANGE} (PostgreSQL 16, 17 or 18). Nothing was created.`);
    }
  });
});
