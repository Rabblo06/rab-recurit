import type { Client } from 'pg';

import {
  checkWorkspaceCoreOrphans,
  WorkspaceOrphanCycleResult,
} from '@rab/server/database/typeorm/workspace-schema/workspace-core-orphans';

export type { WorkspaceOrphanCycleResult, WorkspaceOrphanFinding } from '@rab/server/database/typeorm/workspace-schema/workspace-core-orphans';

/**
 * OWNER-DB-ULTIMATE Part D, decision 0a (owner approved 2026-11-15): the daily, REPORT-ONLY orphan check that replaces the
 * database-enforced half of the dropped workspace → core."user" / core.organisation / core.manager_workspace foreign keys.
 * Logic and findings: `@rab/server/database/typeorm/workspace-schema/workspace-core-orphans.ts`. One short-lived connection per
 * cycle, built by the caller through the connection factory (`createPgClient`, Phase B: no connection is opened outside it),
 * acting as crewflow through `onConnect`; it never writes a row and never changes routing.
 */
export async function runWorkspaceCoreOrphanCycle(createClient: () => Client, onConnect?: (client: Client) => Promise<void>): Promise<WorkspaceOrphanCycleResult> {
  const client = createClient();
  client.on('error', () => undefined);
  await client.connect();
  try {
    if (onConnect) await onConnect(client);
    return await checkWorkspaceCoreOrphans(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
