import { Client, ClientConfig } from 'pg';

import {
  checkWorkspaceSchemaDrift,
  selectDriftFingerprintsForServer,
  WorkspaceDriftCycleResult,
} from '@rab/server/database/typeorm/workspace-schema/workspace-schema-drift';

export type { WorkspaceDriftCycleResult, WorkspaceDriftFinding } from '@rab/server/database/typeorm/workspace-schema/workspace-schema-drift';

/**
 * Wave 2 lane S2 (B4): the scheduled, ALERT-ONLY workspace-schema drift detector (registered by the Worker's in-process
 * provisioning loops, workspace-provisioning.loops.ts, daily; the separate provisioner process was removed in X5.1).
 * The detection logic is shared with the CLI and lives in
 * `@rab/server/database/typeorm/workspace-schema/workspace-schema-drift.ts` (see its header for the findings).
 *
 * Runs on the in-process provisioner's identity (a session acting as `crewflow`). Uses its OWN short-lived connection per
 * cycle, never the provisioning client: that client runs BEGIN/COMMIT pairs, and two loops sharing one connection would
 * interleave transactions. It never changes routing state (SchemaResolverService is unaffected by drift — gate G3).
 *
 * Phase B: takes a pg ClientConfig from the connection factory (`pgClientConfig(pg, { endpoint, purpose: 'drift',
 * sessionAffinity: true, statementTimeoutMs: 60_000 })`: explicit target, TLS object, application_name), never a URL. The
 * 60 s statement timeout is also set here (a startup parameter, applied after the `options` switches).
 */
export async function runWorkspaceSchemaDriftCycle(
  config: ClientConfig,
  /** Owner-login architecture: the in-process provisioner's session identity (workspace-provisioning.loops.ts). */
  onConnect?: (client: Client) => Promise<void>,
): Promise<WorkspaceDriftCycleResult> {
  const client = new Client({ ...config, connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10_000, statement_timeout: 60_000 });
  // W6-E2E-05: a session dropped mid-cycle (database restart) must fail this cycle, never emit an unhandled 'error' that
  // exits the provisioner process. The in-flight query still rejects, so the cycle is recorded as failed.
  client.on('error', () => undefined);
  await client.connect();
  try {
    if (onConnect) await onConnect(client);
    // PG17/18 fix: the second-opinion comparison reads the fingerprints of this server's major (the boot gates selected the
    // same one for this process; a different major throws, so the cycle fails instead of reporting false drift).
    await selectDriftFingerprintsForServer(client);
    return await checkWorkspaceSchemaDrift(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
