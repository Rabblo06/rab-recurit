// TEMPORARY (not committed): measures the level-21 fingerprints on a throwaway ci-db. Admin URL from the harness env only.
import { Client } from 'pg';

import { selectWorkspaceFingerprintsForServer } from '../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { STAFF_PROFILE_MEMBER_SELECT } from '../engine/core-modules/upgrade/upgrade-commands/0-6/staff-profile-member-select';
import { FROZEN_TEMPLATE_REGISTRY, provisionTypeScript, seedWorkspace } from '../__tests__/integration/helpers/workspace-fixtures';

async function main(): Promise<void> {
  const url = process.env.TEST_DATABASE_ADMIN_URL!;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    const major = await selectWorkspaceFingerprintsForServer(async (sql) => (await admin.query(sql)).rows);
    const out: Record<string, string> = { major: String(major) };
    for (const n of ['a', 'b']) {
      const ws = await seedWorkspace(admin, `wsfp-${n}-${Date.now().toString(36)}`);
      const res = await provisionTypeScript(url, ws, { workspaceRegistry: FROZEN_TEMPLATE_REGISTRY });
      const v20 = (await admin.query('SELECT core.workspace_schema_fingerprint($1) AS v1, core.workspace_schema_fingerprint_v2($1) AS v2', [ws.id])).rows[0];
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE crewflow');
      await admin.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
      await admin.query(STAFF_PROFILE_MEMBER_SELECT.sql!(ws.schema));
      // idempotent: a second run changes nothing
      await admin.query(STAFF_PROFILE_MEMBER_SELECT.sql!(ws.schema));
      const v21 = (await admin.query('SELECT core.workspace_schema_fingerprint($1) AS v1, core.workspace_schema_fingerprint_v2($1) AS v2, (SELECT count(*) FROM core.workspace_schema_fingerprint_v2_lines($1)) AS n', [ws.id])).rows[0];
      const pol = (await admin.query('SELECT count(*)::int AS n FROM pg_catalog.pg_policies WHERE schemaname = $1', [ws.schema])).rows[0].n;
      await admin.query('ROLLBACK');
      out[`${n}.provision`] = res;
      out[`${n}.v20.v1`] = v20.v1;
      out[`${n}.v20.v2`] = v20.v2;
      out[`${n}.v21.v1`] = v21.v1;
      out[`${n}.v21.v2`] = v21.v2;
      out[`${n}.v21.v2lines`] = String(v21.n);
      out[`${n}.v21.policies`] = String(pol);
    }
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await admin.end();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : 'error');
  process.exit(1);
});
