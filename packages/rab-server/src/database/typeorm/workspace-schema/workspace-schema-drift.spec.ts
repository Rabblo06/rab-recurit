import { Client } from 'pg';

import { EXPECTED_WORKSPACE_FINGERPRINTS } from './v1/expected-fingerprints';
import { checkWorkspaceSchemaDrift } from './workspace-schema-drift';
import { LATEST_WORKSPACE_MODULE_VERSION } from './workspace-schema-modules';

/** Phase B: the drift detector reports a workspace above this code's newest module as AHEAD, never as OK. Fake client. */
function fakeClient(rows: Array<{ id: string; status: string; version: number; fingerprint: string | null }>): Client {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('core.worker_list_workspaces')) return { rows: rows.map((r) => ({ workspace_id: r.id, organisation_id: `org-${r.id}` })) };
      if (sql.includes('count(*)::int AS n FROM core.workspace_schema_registry')) return { rows: [{ n: 1 }] };
      if (sql.includes('core.record_workspace_schema_drift')) {
        const r = rows.find((x) => x.id === params?.[0])!;
        return { rows: [{ r_status: r.status, r_detail: null, r_module_version: r.version, r_fingerprint: r.fingerprint }] };
      }
      return { rows: [] };
    },
  } as unknown as Client;
}

describe('checkWorkspaceSchemaDrift: AHEAD (Phase B schema-version compatibility)', () => {
  it('counts a workspace at LATEST as OK, one above LATEST as AHEAD, one below as BEHIND', async () => {
    const latestFp = EXPECTED_WORKSPACE_FINGERPRINTS[LATEST_WORKSPACE_MODULE_VERSION] ?? null;
    const result = await checkWorkspaceSchemaDrift(
      fakeClient([
        { id: 'current', status: 'OK', version: LATEST_WORKSPACE_MODULE_VERSION, fingerprint: latestFp },
        { id: 'ahead', status: 'OK', version: LATEST_WORKSPACE_MODULE_VERSION + 1, fingerprint: 'f'.repeat(64) },
        { id: 'behind', status: 'OK', version: 15, fingerprint: EXPECTED_WORKSPACE_FINGERPRINTS[15] ?? null },
      ]),
    );
    expect(result.ok).toBe(1);
    expect(result.findings).toEqual([
      { workspaceId: 'ahead', status: 'AHEAD', moduleVersion: LATEST_WORKSPACE_MODULE_VERSION + 1, detail: `module ${LATEST_WORKSPACE_MODULE_VERSION + 1} is above this code's ${LATEST_WORKSPACE_MODULE_VERSION}` },
      { workspaceId: 'behind', status: 'BEHIND', moduleVersion: 15, detail: `module 15 of ${LATEST_WORKSPACE_MODULE_VERSION}` },
    ]);
  });
});
