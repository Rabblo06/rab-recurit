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

/**
 * Phase 1, one query per workspace: every DISTINCT referenced id per reference, with its row count. Reading the workspace's own
 * small tables only; no join into core (an anti-join against core."user" under its RLS was measured at seconds per workspace).
 */
export function referencedIdsSql(schema: string, refs: readonly CoreReference[] = coreReferences()): string {
  if (!SCHEMA.test(schema)) throw new Error('invalid workspace schema name');
  // ONE branch per TABLE (its FORCE RLS policies are expanded once per table, not once per column: planning 72 branches over
  // the policy-heavy tables cost seconds per workspace), every reference column of that table unpivoted with VALUES.
  const byTable = new Map<string, Array<{ i: number; column: string }>>();
  refs.forEach((r, i) => byTable.set(r.table, [...(byTable.get(r.table) ?? []), { i, column: r.column }]));
  return [...byTable]
    .map(
      ([table, cols]) =>
        `SELECT v.i, v.id, pg_catalog.count(*)::int AS n FROM ${schema}.${table} t CROSS JOIN LATERAL (VALUES ${cols.map((c) => `(${c.i}, t.${c.column}::text)`).join(', ')}) AS v(i, id) WHERE v.id IS NOT NULL GROUP BY v.i, v.id`,
    )
    .join('\nUNION ALL\n');
}

/** Phase 2: which of the referenced ids exist (primary-key lookups; a user must also be of the workspace's organisation). */
export const EXISTING_IDS_SQL: Readonly<Record<CoreReference['target'], string>> = Object.freeze({
  'core."user"': 'SELECT u.id::text AS id FROM core."user" u WHERE u.id = ANY ($1::uuid[]) AND u.organisation_id = $2',
  'core.organisation': 'SELECT o.id::text AS id FROM core.organisation o WHERE o.id = ANY ($1::uuid[]) AND $2::uuid IS NOT NULL',
  'core.manager_workspace': 'SELECT w.id::text AS id FROM core.manager_workspace w WHERE w.id = ANY ($1::uuid[]) AND w.organisation_id = $2',
});

export async function checkWorkspaceCoreOrphans(client: Client, only?: readonly string[]): Promise<WorkspaceOrphanCycleResult> {
  const refs = coreReferences();
  const result: WorkspaceOrphanCycleResult = { checked: 0, findings: [], errors: [] };
  let after: string | null = null;
  for (;;) {
    const page: { rows: Array<{ workspace_id: string; organisation_id: string }> } = await client.query('SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1, $2)', [after, PAGE]);
    for (const ws of page.rows) {
      if (only && !only.includes(ws.workspace_id)) continue;
      const schema = `workspace_${ws.workspace_id.replace(/-/g, '')}`;
      try {
        await client.query('BEGIN READ ONLY');
        // The Worker's per-workspace scan identity: FORCE RLS shows crewflow only the rows a policy branch admits, and the
        // `rab.actor_type = 'worker'` branches exist on staff_profile, payroll_record, payroll_run, payroll_run_line and
        // shift_staff_review only. DRAFT LIMIT (owner decision 0a-Q5): the other 16 tables are not covered until a reviewed
        // read path exists (worker read branches, or a narrow definer); their rows are invisible here, never "clean".
        await client.query(
          `SELECT pg_catalog.set_config('rab.organisation_id', $1, true), pg_catalog.set_config('rab.workspace_id', $2, true), pg_catalog.set_config('rab.actor_type', 'worker', true)`,
          [ws.organisation_id, ws.workspace_id],
        );
        const reg = await client.query<{ status: string }>('SELECT status FROM core.workspace_schema_registry WHERE workspace_id = $1', [ws.workspace_id]);
        if (reg.rows[0]?.status !== 'READY') {
          await client.query('ROLLBACK');
          continue;
        }
        const { rows } = await client.query<{ i: number; id: string; n: number }>(referencedIdsSql(schema, refs));
        const existing = new Map<CoreReference['target'], Set<string>>();
        for (const target of ['core."user"', 'core.organisation', 'core.manager_workspace'] as const) {
          const ids = [...new Set(rows.filter((r) => refs[Number(r.i)]!.target === target).map((r) => r.id))];
          const found = ids.length ? (await client.query<{ id: string }>(EXISTING_IDS_SQL[target], [ids, ws.organisation_id])).rows.map((r) => r.id) : [];
          existing.set(target, new Set(found));
        }
        await client.query('COMMIT');
        result.checked += 1;
        const missing = new Map<number, number>();
        for (const r of rows) {
          const ref = refs[Number(r.i)]!;
          if (!existing.get(ref.target)!.has(r.id)) missing.set(Number(r.i), (missing.get(Number(r.i)) ?? 0) + Number(r.n));
        }
        for (const [i, n] of [...missing].sort((x, y) => x[0] - y[0])) result.findings.push({ workspaceId: ws.workspace_id, ...refs[i]!, rows: n });
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
