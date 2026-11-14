// sql-injection-reviewed-file: every interpolated identifier is a constant of WORKSPACE_CORE_FOREIGN_KEYS (table / column names
// parsed from the frozen constraint definitions and checked against /^[a-z_]+$/) or a validated `workspace_<32 hex>` schema name;
// every value is a bound parameter.
import { Client } from 'pg';

import { WORKSPACE_CORE_FOREIGN_KEYS } from '../../../engine/core-modules/upgrade/upgrade-commands/0-6/workspace-core-fk-removal';

/**
 * OWNER-DB-ULTIMATE Part D, decision 0a (DRAFT, WS-COMMANDS.md "FOR OWNER REVIEW — 0a"): the periodic ORPHAN check that replaces
 * the database-enforced half of the dropped workspace → core foreign keys. REPORT-ONLY (owner decision pending on repair): it
 * counts, per READY workspace and per dropped reference, the rows whose value points at no row of the referenced core table (or,
 * for core."user", at a user of ANOTHER organisation, which the old FK did not catch either but the app never writes). It never
 * changes a row, never routes, and logs counts only (no ids, no values).
 *
 * Runs as the provisioner identity (`crewflow`), one short READ ONLY transaction per workspace with its organisation and workspace
 * bound (FORCE RLS on both sides: the workspace tables and core."user" / core.manager_workspace show only that tenant).
 */
export interface CoreReference {
  table: string;
  column: string;
  target: 'core."user"' | 'core.organisation' | 'core.manager_workspace';
}

export interface WorkspaceOrphanFinding {
  workspaceId: string;
  table: string;
  column: string;
  target: CoreReference['target'];
  rows: number;
}

export interface WorkspaceOrphanCycleResult {
  checked: number;
  findings: WorkspaceOrphanFinding[];
  errors: Array<{ workspaceId: string; detail: string }>;
}

const IDENT = /^[a-z_]+$/;
const SCHEMA = /^workspace_[0-9a-f]{32}$/;
const PAGE = 100;

/** Pure: the (table, column, target) of every dropped reference, parsed from the frozen definitions (fail closed). */
export function coreReferences(): CoreReference[] {
  const out: CoreReference[] = [];
  for (const [table, fks] of Object.entries(WORKSPACE_CORE_FOREIGN_KEYS)) {
    for (const [, def] of fks) {
      const m = /^FOREIGN KEY \(([a-z_]+)\) REFERENCES (core\."user"|core\.organisation|core\.manager_workspace)\(id\)/.exec(def);
      if (!m || !IDENT.test(table) || !IDENT.test(m[1]!)) throw new Error(`unexpected reference definition on ${table}: ${def}`);
      out.push({ table, column: m[1]!, target: m[2] as CoreReference['target'] });
    }
  }
  return out;
}

/** One count query per workspace: a UNION ALL of one probe per reference. */
export function orphanCountSql(schema: string, refs: readonly CoreReference[] = coreReferences()): string {
  if (!SCHEMA.test(schema)) throw new Error('invalid workspace schema name');
  return refs
    .map(
      (r, i) =>
        `SELECT ${i} AS i, pg_catalog.count(*)::int AS n FROM ${schema}.${r.table} t ` +
        `WHERE t.${r.column} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${r.target} c WHERE c.id = t.${r.column}` +
        (r.target === 'core."user"' ? ` AND c.organisation_id = t.organisation_id)` : ')'),
    )
    .join('\nUNION ALL\n');
}

export async function checkWorkspaceCoreOrphans(client: Client): Promise<WorkspaceOrphanCycleResult> {
  const refs = coreReferences();
  const result: WorkspaceOrphanCycleResult = { checked: 0, findings: [], errors: [] };
  let after: string | null = null;
  for (;;) {
    const page: { rows: Array<{ workspace_id: string; organisation_id: string }> } = await client.query('SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1, $2)', [after, PAGE]);
    for (const ws of page.rows) {
      const schema = `workspace_${ws.workspace_id.replace(/-/g, '')}`;
      try {
        await client.query('BEGIN READ ONLY');
        await client.query(`SELECT pg_catalog.set_config('rab.organisation_id', $1, true), pg_catalog.set_config('rab.workspace_id', $2, true)`, [ws.organisation_id, ws.workspace_id]);
        const reg = await client.query<{ status: string }>('SELECT status FROM core.workspace_schema_registry WHERE workspace_id = $1', [ws.workspace_id]);
        if (reg.rows[0]?.status !== 'READY') {
          await client.query('ROLLBACK');
          continue;
        }
        const { rows } = await client.query<{ i: number; n: number }>(orphanCountSql(schema, refs));
        await client.query('COMMIT');
        result.checked += 1;
        for (const r of rows) if (Number(r.n) > 0) result.findings.push({ workspaceId: ws.workspace_id, ...refs[Number(r.i)]!, rows: Number(r.n) });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        result.errors.push({ workspaceId: ws.workspace_id, detail: `orphan check failed (SQLSTATE ${(error as { code?: string }).code ?? 'none'})` });
      }
    }
    if (page.rows.length < PAGE) break;
    after = page.rows[page.rows.length - 1]!.workspace_id;
  }
  return result;
}
