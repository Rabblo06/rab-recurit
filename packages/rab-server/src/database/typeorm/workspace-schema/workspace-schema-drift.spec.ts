import { Client } from 'pg';

import { EXPECTED_WORKSPACE_FINGERPRINTS } from './v1/expected-fingerprints';
import { checkWorkspaceSchemaDrift } from './workspace-schema-drift';
import { codeWorkspaceStructureLevel } from '../../../engine/core-modules/upgrade/workspace-structure-level';

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

describe('checkWorkspaceSchemaDrift: AHEAD (Phase B schema-version compatibility; Part D structure level)', () => {
  it('counts a workspace at the code structure level as OK, one above it as AHEAD, one below as BEHIND (20 included, since level 21)', async () => {
    const L = codeWorkspaceStructureLevel();
    expect(L).toBe(21);
    const result = await checkWorkspaceSchemaDrift(
      fakeClient([
        { id: 'current', status: 'OK', version: L, fingerprint: 'a'.repeat(64) },
        { id: 'ahead', status: 'OK', version: L + 1, fingerprint: 'f'.repeat(64) },
        { id: 'at20', status: 'OK', version: 20, fingerprint: EXPECTED_WORKSPACE_FINGERPRINTS[20] ?? null },
        { id: 'behind', status: 'OK', version: 15, fingerprint: EXPECTED_WORKSPACE_FINGERPRINTS[15] ?? null },
      ]),
    );
    expect(result.ok).toBe(1);
    expect(result.findings).toEqual([
      { workspaceId: 'ahead', status: 'AHEAD', moduleVersion: L + 1, detail: `module ${L + 1} is above this code's ${L}` },
      { workspaceId: 'at20', status: 'BEHIND', moduleVersion: 20, detail: `module 20 of ${L}` },
      { workspaceId: 'behind', status: 'BEHIND', moduleVersion: 15, detail: `module 15 of ${L}` },
    ]);
  });
});
