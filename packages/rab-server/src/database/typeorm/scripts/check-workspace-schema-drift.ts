/**
 * Wave 2 lane S2 (B4): one drift pass from the command line (CI, operators). Same detector as the provisioner's daily job.
 *
 *   DRIFT_DATABASE_URL=postgres://crewflow:…@host/db ts-node --transpile-only -P packages/rab-server/tsconfig.app.json \
 *     packages/rab-server/src/database/typeorm/scripts/check-workspace-schema-drift.ts
 *
 * The URL is read ONLY from DRIFT_DATABASE_URL (never `.env`). It must be the provisioner identity (`crewflow`): the
 * runtime role cannot execute the recorder. Records observed fingerprints / drift status (alert-only; routing unaffected).
 * Exit 1 on any DRIFTED / MISSING / UNVERIFIED / ERROR finding (BEHIND alone exits 0 with a warning).
 */
import { Client } from 'pg';

import { checkWorkspaceSchemaDrift } from '../workspace-schema/workspace-schema-drift';

async function main(): Promise<void> {
  const url = process.env.DRIFT_DATABASE_URL?.trim();
  if (!url) throw new Error('DRIFT_DATABASE_URL is required. There is no fallback.');
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const r = await checkWorkspaceSchemaDrift(client);
    for (const f of r.findings) console.log(`${f.status} workspace=${f.workspaceId} module=${f.moduleVersion ?? '?'} ${f.detail}`);
    console.log(`workspace schema drift: checked=${r.checked} ok=${r.ok} notReady=${r.notReady} findings=${r.findings.length}`);
    if (r.findings.some((f) => f.status !== 'BEHIND')) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error: Error) => {
  console.error(`drift check failed: ${error.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`);
  process.exit(2);
});
