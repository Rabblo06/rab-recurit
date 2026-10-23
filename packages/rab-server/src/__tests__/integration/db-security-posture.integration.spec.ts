import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { compareWithGolden } from '../../database/typeorm/core/security-posture';

/**
 * G-03 / CF-09 / CF-41 / CF-48: the test database must have exactly the ownership and grant model a database built from
 * migrations alone produces (the committed golden snapshot). A hand-applied grant on a long-lived test database once hid a
 * fresh-install outage (every cookie request 503). Any drift, in either direction, fails here with the exact lines.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('database security posture (integration)', () => {
  const { adminUrl, appUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);

  it('matches the golden snapshot produced by a migrations-only build (core, and EVERY workspace schema against the template)', async () => {
    const expected = readFileSync(join(__dirname, '../../database/typeorm/core/security-posture.golden.txt'), 'utf8').split('\n').filter(Boolean);
    const report = await compareWithGolden(adminUrl, expected);
    expect(report.core).toEqual({ missing: [], unexpected: [] });
    // F4: each physical workspace_<32 hex> schema on its own. A drifted one is named here with its exact lines.
    expect(report.workspaces).toEqual([]);
  });

  it('CF-09: the restricted runtime role can resolve a web session and cannot run provisioner-only or ledger writes', async () => {
    const client = new Client({ connectionString: appUrl });
    await client.connect();
    try {
      const [who] = (await client.query(`SELECT current_user AS u, r.rolsuper AS s, r.rolbypassrls AS b FROM pg_roles r WHERE r.rolname = current_user`)).rows;
      expect(who).toEqual({ u: 'crewflow_app', s: false, b: false });
      // A real call, not only a catalog check: an unknown hash resolves to no row (and no permission error).
      expect((await client.query(`SELECT * FROM core.auth_find_session_by_web_token_hash($1)`, ['0'.repeat(64)])).rows).toEqual([]);
      await expect(client.query(`SELECT core.register_workspace_schema(gen_random_uuid())`)).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(`UPDATE core.permission SET key = key WHERE false`)).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(`DELETE FROM core.migrations WHERE false`)).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(`DELETE FROM core.audit_log WHERE false`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
  });
});
