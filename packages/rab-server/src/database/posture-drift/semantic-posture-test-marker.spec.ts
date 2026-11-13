import { assertDeploymentIdentity, DeploymentIdentityError, MARKER_PRESENT_SQL, MARKER_READ_SQL, Query } from '../deployment-identity/deployment-identity';
import { SEMANTIC_GOLDEN_PG16 } from './semantic-golden.pg16';
import { SEMANTIC_GOLDEN_PG17 } from './semantic-golden.pg17';
import { SEMANTIC_GOLDEN_PG18 } from './semantic-golden.pg18';
import { POSTURE_EXCLUDED_SETTING, SEMANTIC_OBJECT_SQL } from './semantic-posture';

/**
 * Hotfix fix/posture-test-marker (2026-11-05, HIGH availability): both semantic goldens carried
 * "setting|*|this|crewflow.disposable_test_database=true", captured from CI's disposable databases, so the boot gate
 * refused every REAL database (a fresh install restart-looped on "semantic-posture refused"). The reader now excludes that
 * one setting by exact name, and production on a marked database is refused by the identity gate instead.
 */
const PROD_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

function fakeQuery(disposableTest: boolean): Query {
  return async (sql: string) => {
    if (sql === MARKER_PRESENT_SQL) return [{ present: false, database: 'crewflow', disposable_test: disposableTest }];
    if (sql === MARKER_READ_SQL) return [];
    throw new Error(`unexpected SQL: ${sql.slice(0, 40)}`);
  };
}

describe('the disposable-test marker is not part of the semantic posture', () => {
  it('no golden line names crewflow.disposable_test_database (PG16, PG17 and PG18)', () => {
    for (const golden of [SEMANTIC_GOLDEN_PG16, SEMANTIC_GOLDEN_PG17, SEMANTIC_GOLDEN_PG18]) {
      expect(golden.filter((l) => l.includes('disposable_test_database'))).toEqual([]);
    }
  });

  it('the reader excludes exactly that setting name (whatever its value), never a crewflow.* wildcard', () => {
    expect(POSTURE_EXCLUDED_SETTING).toBe('crewflow.disposable_test_database');
    expect(SEMANTIC_OBJECT_SQL).toContain(`pg_catalog.split_part(c.cfg, '=', 1) <> 'crewflow.disposable_test_database'`);
    expect(SEMANTIC_OBJECT_SQL).not.toMatch(/crewflow\.%|crewflow\.\*|LIKE 'crewflow/);
    // Every other database / role setting still reaches the posture (e.g. a planted crewflow.dispatch_notify).
    expect(SEMANTIC_OBJECT_SQL).toContain(`'setting|'`);
  });
});

describe('fail closed: production never runs on a database marked disposable', () => {
  it('production + marker → refused by the identity gate, with an actionable message', async () => {
    const run = assertDeploymentIdentity(fakeQuery(true), {
      processLabel: 'api process',
      production: true,
      connectionHost: 'db',
      env: { NODE_ENV: 'production', CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production', CREWFLOW_DEPLOYMENT_ID: PROD_ID },
    });
    await expect(run).rejects.toBeInstanceOf(DeploymentIdentityError);
    await expect(
      assertDeploymentIdentity(fakeQuery(true), { processLabel: 'worker process', production: true, connectionHost: 'db', env: { NODE_ENV: 'production' } }),
    ).rejects.toThrow(/production worker process refuses to run: database "crewflow" is marked as a disposable TEST database.*RESET crewflow\.disposable_test_database/);
  });

  it('test + marker → allowed (the CI and local test databases)', async () => {
    await expect(
      assertDeploymentIdentity(fakeQuery(true), { processLabel: 'api process', production: false, connectionHost: 'db', env: { NODE_ENV: 'test' } }),
    ).resolves.toMatchObject({ summary: 'absent' });
  });

  it('production without the marker is not refused by this rule (the other identity rules still apply)', async () => {
    await expect(
      assertDeploymentIdentity(fakeQuery(false), { processLabel: 'api process', production: true, connectionHost: 'db', env: { NODE_ENV: 'production' } }),
    ).resolves.toBeDefined();
  });
});
