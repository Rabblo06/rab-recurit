import { Client } from 'pg';

import { PREAUTH_DEFINER_POLICY_SQL } from '../../database/boot-checks/owner-login-posture';
import { readSemanticPosture } from '../../database/posture-drift/semantic-posture';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';

/**
 * Restore drill (M9, RESTORE-DRILL.md, MEDIUM): after pg_dump / restore onto a new cluster the semantic-posture boot gate
 * reported drift on a database that had not changed, because a policy's role list was aggregated with `ORDER BY 1` (inside
 * an aggregate: the constant 1, so the list followed pg_policy.polroles, i.e. the order the roles were stored in, which
 * the restore changes). The renderers now sort the role names. Here the SAME policy is created twice with its roles stored
 * in opposite orders (polroles keeps the order of the TO list) and both renderers must give identical output.
 * Everything runs in ONE transaction that is rolled back; the probe table never survives.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const TBL = 'zz_role_order_probe';
const POLICY = `${TBL}_secure_owner_definer`;

describeIfDb('posture renderers: policy role lists do not depend on role storage (OID) order (rolled back)', () => {
  const { adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : { adminUrl: '' };
  let c: Client;

  beforeAll(async () => {
    c = new Client({ connectionString: adminUrl });
    await c.connect();
  });
  afterAll(async () => {
    await c?.end();
  });

  const createPolicy = async (roles: string) => {
    await c.query(`DROP POLICY IF EXISTS ${POLICY} ON core.${TBL}`);
    await c.query(`CREATE POLICY ${POLICY} ON core.${TBL} AS PERMISSIVE FOR ALL TO ${roles} USING (true) WITH CHECK (true)`);
    const [{ stored }] = (await c.query(`SELECT array(SELECT pg_get_userbyid(r) FROM unnest(polroles) WITH ORDINALITY u(r, i) ORDER BY i)::text[] AS stored
                                           FROM pg_policy WHERE polname = $1`, [POLICY])).rows as Array<{ stored: string[] }>;
    return stored;
  };
  const semanticLine = async () => {
    const posture = await readSemanticPosture(async (sql, params) => (await c.query(sql, params as unknown[] | undefined)).rows, { ownTransaction: false });
    const lines = posture.core.filter((l) => l.startsWith(`policy|${TBL}|${POLICY}|`));
    expect(lines).toHaveLength(1);
    return lines[0]!;
  };
  const definerRoles = async () => {
    const rows = (await c.query(PREAUTH_DEFINER_POLICY_SQL, [[TBL]])).rows as Array<{ roles: string[] }>;
    expect(rows).toHaveLength(1);
    return rows[0]!.roles;
  };

  it('the same policy with its roles stored in opposite orders renders identically (semantic posture and owner-login check)', async () => {
    await c.query('BEGIN');
    try {
      await c.query(`CREATE TABLE core.${TBL} (id integer)`);

      // Stored in reverse-alphabetical order.
      expect(await createPolicy('crewflow_worker, crewflow_app, crewflow')).toEqual(['crewflow_worker', 'crewflow_app', 'crewflow']);
      const reversedLine = await semanticLine();
      const reversedRoles = await definerRoles();

      // The same policy, stored in alphabetical order: the storage order really differs, the rendering must not.
      expect(await createPolicy('crewflow, crewflow_app, crewflow_worker')).toEqual(['crewflow', 'crewflow_app', 'crewflow_worker']);
      const forwardLine = await semanticLine();
      const forwardRoles = await definerRoles();

      expect(forwardLine).toBe(reversedLine);
      expect(forwardLine).toContain(`|PERMISSIVE|crewflow,crewflow_app,crewflow_worker|*|`);
      expect(forwardRoles).toEqual(reversedRoles);
      expect(forwardRoles).toEqual(['crewflow', 'crewflow_app', 'crewflow_worker']);
    } finally {
      await c.query('ROLLBACK');
    }
  });
});
