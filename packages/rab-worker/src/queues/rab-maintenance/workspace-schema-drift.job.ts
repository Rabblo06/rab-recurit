import { Client } from 'pg';

import {
  checkWorkspaceSchemaDrift,
  WorkspaceDriftCycleResult,
} from '@rab/server/database/typeorm/workspace-schema/workspace-schema-drift';

export type { WorkspaceDriftCycleResult, WorkspaceDriftFinding } from '@rab/server/database/typeorm/workspace-schema/workspace-schema-drift';

/**
 * Wave 2 lane S2 (B4): the scheduled, ALERT-ONLY workspace-schema drift detector (registered in
 * workspace-provisioner.main.ts, daily). The detection logic is shared with the CLI and lives in
 * `@rab/server/database/typeorm/workspace-schema/workspace-schema-drift.ts` (see its header for the findings).
 *
 * Runs in the workspace-provisioner process (the `crewflow` provisioner identity). Uses its OWN short-lived connection per
 * cycle, never the provisioning client: that client runs BEGIN/COMMIT pairs, and two loops sharing one connection would
 * interleave transactions. It never changes routing state (SchemaResolverService is unaffected by drift — gate G3).
 */
export async function runWorkspaceSchemaDriftCycle(connectionString: string): Promise<WorkspaceDriftCycleResult> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 60_000 });
  await client.connect();
  try {
    return await checkWorkspaceSchemaDrift(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
