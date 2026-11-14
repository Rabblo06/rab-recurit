// TEMPORARY: one level-21 workspace (TypeScript provisioner, default template) for the posture goldens; prints its fingerprints.
import { Client } from 'pg';
import { selectWorkspaceFingerprintsForServer } from '../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { provisionServerPath, provisionTypeScript, seedWorkspace } from '../__tests__/integration/helpers/workspace-fixtures';
async function main(): Promise<void> {
  const url = process.env.TEST_DATABASE_ADMIN_URL!;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    await selectWorkspaceFingerprintsForServer(async (sql) => (await admin.query(sql)).rows);
    const a = await seedWorkspace(admin, `wsgold-a-${Date.now().toString(36)}`);
    const ts = await provisionTypeScript(url, a);
    const b = await seedWorkspace(admin, `wsgold-b-${Date.now().toString(36)}`);
    const sql = process.argv.includes('--sql') ? await provisionServerPath(process.env.TEST_DATABASE_URL!, b) : 'skipped';
    const f = async (id: string) => (await admin.query('SELECT core.workspace_schema_fingerprint($1) AS v1, core.workspace_schema_fingerprint_v2($1) AS v2, (SELECT module_version FROM core.workspace_schema_registry WHERE workspace_id = $1) AS mv', [id])).rows[0];
    console.log(JSON.stringify({ ts, tsFp: await f(a.id), sql, sqlFp: process.argv.includes('--sql') ? await f(b.id) : null }, null, 2));
  } finally {
    await admin.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? `${e.name}: ${e.message}` : 'error'); process.exit(1); });
