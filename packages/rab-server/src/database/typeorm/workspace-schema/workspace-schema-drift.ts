import { Client } from 'pg';

import { EXPECTED_WORKSPACE_FINGERPRINTS } from './v1/expected-fingerprints';
import { codeWorkspaceStructureLevel } from '../../../engine/core-modules/upgrade/workspace-structure-level';

/**
 * Wave 2 lane S2 (B4): workspace-schema drift detector (shared by the worker job and the CLI
 * `scripts/check-workspace-schema-drift.ts`). ALERT-ONLY by owner default ("report, never block"):
 * it records each READY workspace's observed structural fingerprint and a drift status in
 * `core.workspace_schema_registry` (through `core.record_workspace_schema_drift`) and logs a warning per finding. It never
 * changes `status` or `schema_version`, so `SchemaResolverService` keeps routing a drifted workspace exactly as before —
 * fail-closed routing on drift is gate G3, not enabled here.
 *
 * Must run as the provisioner/migration identity (`crewflow`): the runtime role `crewflow_app` cannot execute the
 * recorder or the fingerprint function.
 *
 * Findings per workspace:
 *  - DRIFTED   — the structure differs from the fingerprint recorded when the migrator/provisioner last brought it to its
 *                module version, or core.verify_workspace_schema_v1 reports a problem, or (second opinion) the observed
 *                fingerprint differs from the code's expected fingerprint for that module version;
 *  - MISSING   — the registry says READY but the schema does not exist;
 *  - UNVERIFIED — READY with no recorded fingerprint (created by an older image, not yet baselined by the migrator);
 *  - BEHIND    — module_version < this code's structure level (not drift; the migrator / runner has not run yet).
 *  - AHEAD     — module_version > this code's structure level (Phase B: an image rollback after a module migration or a
 *                structural workspace command; this code has no expected fingerprint for it and must not count it OK).
 */
export interface WorkspaceDriftFinding {
  workspaceId: string;
  status: 'DRIFTED' | 'MISSING' | 'UNVERIFIED' | 'BEHIND' | 'AHEAD' | 'ERROR';
  moduleVersion: number | null;
  detail: string;
}

export interface WorkspaceDriftCycleResult {
  checked: number;
  ok: number;
  notReady: number;
  findings: WorkspaceDriftFinding[];
}

const PAGE = 100;

/** One pass over every workspace on an already-connected client (the caller owns the connection). */
export async function checkWorkspaceSchemaDrift(client: Client): Promise<WorkspaceDriftCycleResult> {
  const result: WorkspaceDriftCycleResult = { checked: 0, ok: 0, notReady: 0, findings: [] };
  let after: string | null = null;
  for (;;) {
    const page: { rows: Array<{ workspace_id: string; organisation_id: string }> } = await client.query<{ workspace_id: string; organisation_id: string }>(
      'SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1, $2)',
      [after, PAGE],
    );
    for (const ws of page.rows) {
      await checkOne(client, ws.workspace_id, ws.organisation_id, result);
    }
    if (page.rows.length < PAGE) break;
    after = page.rows[page.rows.length - 1]!.workspace_id;
  }
  return result;
}

async function checkOne(client: Client, workspaceId: string, organisationId: string, result: WorkspaceDriftCycleResult): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
    const reg = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM core.workspace_schema_registry WHERE workspace_id = $1', [
      workspaceId,
    ]);
    if (reg.rows[0]!.n === 0) {
      // Not provisioned yet (no registry row): nothing to fingerprint.
      await client.query('ROLLBACK');
      result.notReady += 1;
      return;
    }
    const { rows } = await client.query<{ r_status: string; r_detail: string | null; r_module_version: number; r_fingerprint: string | null }>(
      'SELECT r_status, r_detail, r_module_version, r_fingerprint FROM core.record_workspace_schema_drift($1)',
      [workspaceId],
    );
    await client.query('COMMIT');
    const row = rows[0]!;
    result.checked += 1;
    if (row.r_status === 'NOT_READY') {
      result.notReady += 1;
      return;
    }
    const version = Number(row.r_module_version);
    // Part D: the code's structure level (20 frozen modules + the structural workspace commands this code knows), not the
    // module ceiling 20: a level-21 workspace is current, not ahead.
    const codeLevel = codeWorkspaceStructureLevel();
    if (row.r_status === 'OK' && version > codeLevel) {
      result.findings.push({ workspaceId, status: 'AHEAD', moduleVersion: version, detail: `module ${version} is above this code's ${codeLevel}` });
      return;
    }
    // Second opinion from the v1 tables for levels 14..20 only; a level above 20 is declared in fingerprint v2 (checked by the
    // runner and the provisioners), and the recorder above still compares the v1 value recorded when it reached that level.
    const expected = EXPECTED_WORKSPACE_FINGERPRINTS[version];
    if (row.r_status === 'OK' && expected !== undefined && row.r_fingerprint !== expected) {
      result.findings.push({
        workspaceId,
        status: 'DRIFTED',
        moduleVersion: version,
        detail: `fingerprint differs from the expected fingerprint for module version ${version}`,
      });
      return;
    }
    if (row.r_status !== 'OK') {
      result.findings.push({ workspaceId, status: row.r_status as WorkspaceDriftFinding['status'], moduleVersion: version, detail: row.r_detail ?? '' });
      return;
    }
    if (version < codeLevel) {
      result.findings.push({ workspaceId, status: 'BEHIND', moduleVersion: version, detail: `module ${version} of ${codeLevel}` });
      return;
    }
    result.ok += 1;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const code = (error as { code?: string }).code ?? 'no-sqlstate';
    result.findings.push({ workspaceId, status: 'ERROR', moduleVersion: null, detail: `drift check failed (SQLSTATE ${code})` });
  }
}
