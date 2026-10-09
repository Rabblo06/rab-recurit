import { Client } from 'pg';

import { WORKSPACE_TABLES } from '../provision-workspace-schema';

/**
 * The workspace→workspace edges of the Workspace Schema V1 FK graph (HWS backfill tool, Part 1/13).
 *
 * Of the 89 total FKs in V1 (see `V1_EXPECTED` in `provision-workspace-schema.ts`), 54 point from a
 * workspace table to a `core` table (never need copy ordering — the core row already exists and is
 * authoritative) and 35 point from one workspace table to another (these ARE the copy-order
 * constraint: the target row must exist in the destination schema before the source row can be
 * inserted). This list holds the 21 distinct TABLE-level edges that produce those 35 column-level
 * FKs (several table pairs have more than one FK column between them, e.g. `attendance` → `shift`
 * and `attendance` → `shift_assignment` and `attendance` → `staff_profile`).
 *
 * Derived from the live catalog, not hand-guessed (Part 1's own requirement): queried directly
 * against `workspace_659b27b6d54742de8b6bf842a32ba58a` (proof Workspace A, READY, schema version 1,
 * `rab_crewflow_hyper_workspace`) via `information_schema.table_constraints` /
 * `key_column_usage` / `constraint_column_usage`, grouped to table pairs. `deriveEdgesFromCatalog`
 * below re-runs that exact query against any live, READY workspace schema, so this hardcoded list
 * can be diffed against reality at any time — it is not a second, competing source of truth, it's a
 * cached, reviewable copy of one.
 */
export interface TableEdge {
  /** The table that has the foreign key (must be copied AFTER `to`). */
  readonly from: string;
  /** The table it references (must be copied BEFORE `from`). */
  readonly to: string;
}

export const WORKSPACE_FK_EDGES: readonly TableEdge[] = [
  { from: 'staff_profile', to: 'job_role' },
  { from: 'venue_role_rate', to: 'job_role' },
  { from: 'venue_role_rate', to: 'venue' },
  { from: 'shift', to: 'job_role' },
  { from: 'shift', to: 'venue' },
  { from: 'manager_venue', to: 'venue' },
  { from: 'shift_assignment', to: 'shift' },
  { from: 'shift_assignment', to: 'staff_profile' },
  { from: 'shift_request_staff', to: 'shift' },
  { from: 'shift_request_staff', to: 'staff_profile' },
  { from: 'venue_manager_staff', to: 'staff_profile' },
  { from: 'job_offer', to: 'shift_assignment' },
  { from: 'job_offer', to: 'staff_profile' },
  { from: 'attendance', to: 'shift' },
  { from: 'attendance', to: 'shift_assignment' },
  { from: 'attendance', to: 'staff_profile' },
  { from: 'attendance_correction', to: 'attendance' },
  { from: 'shift_report', to: 'shift' },
  { from: 'replacement_request', to: 'job_offer' },
  { from: 'replacement_request', to: 'shift' },
  { from: 'replacement_request', to: 'shift_assignment' },
  // replacement_request → staff_profile exists too, but adds no new ordering constraint beyond
  // the ones above (staff_profile is already forced earlier by shift_assignment's own dependency).
  { from: 'replacement_request', to: 'staff_profile' },
] as const;

export class FkGraphCycleError extends Error {
  constructor(readonly cycle: readonly string[]) {
    super(`Workspace table FK graph has a cycle: ${cycle.join(' -> ')}. Refusing to guess a copy order.`);
    this.name = 'FkGraphCycleError';
  }
}

/**
 * Deterministic topological sort (Kahn's algorithm, alphabetical tie-break within each "ready" set
 * so the output never depends on object/array iteration order) over the 15 workspace tables plus
 * the edges above. `user_note` has no workspace→workspace FK (only workspace→core, to `core.user`
 * and `core.manager_workspace` — see `user-note-mapping.ts`), so it has no incoming constraint and
 * sorts into the first level alongside the other true roots.
 *
 * Throws `FkGraphCycleError` naming every table still unresolved if the graph isn't acyclic — Part
 * 1 explicitly forbids silently disabling constraints to work around a cycle; this graph is in fact
 * acyclic (verified: this function returns all 15 tables with zero left over), but the check stays
 * in so a future V1 template change that introduced a real cycle would fail loudly here, at the one
 * place that would otherwise silently guess a wrong order.
 */
export function computeWorkspaceTableCopyOrder(tables: readonly string[], edges: readonly TableEdge[] = WORKSPACE_FK_EDGES): string[] {
  const remaining = new Set(tables);
  const dependsOn = new Map<string, Set<string>>();
  for (const table of tables) dependsOn.set(table, new Set());
  for (const edge of edges) {
    if (!remaining.has(edge.from) || !remaining.has(edge.to)) continue; // edge references a table outside this call's set
    dependsOn.get(edge.from)!.add(edge.to);
  }

  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((t) => ![...dependsOn.get(t)!].some((dep) => remaining.has(dep))).sort();
    if (ready.length === 0) throw new FkGraphCycleError([...remaining].sort());
    for (const table of ready) {
      order.push(table);
      remaining.delete(table);
    }
  }
  return order;
}

/** The canonical order for all 15 workspace tables, computed once at module load — the single source every caller uses. */
export const WORKSPACE_TABLE_COPY_ORDER: readonly string[] = computeWorkspaceTableCopyOrder(WORKSPACE_TABLES as readonly string[]);

/**
 * Re-derives the table-level edge list from a LIVE, READY workspace schema's actual catalog —
 * the ground truth `WORKSPACE_FK_EDGES` above is a reviewable snapshot of. Used by the backfill
 * tool's own startup self-check (never trust the hardcoded list blindly) and by this module's own
 * drift test. `schemaName` must already be the trusted, resolved physical schema name — never a
 * caller-supplied string interpolated without validation elsewhere in this codebase; here it is
 * parameterised directly into `information_schema` predicates, never string-concatenated into SQL.
 */
export async function deriveEdgesFromCatalog(client: Client, schemaName: string): Promise<TableEdge[]> {
  const rows = await client.query<{ from_table: string; to_table: string }>(
    `SELECT DISTINCT tc.table_name AS from_table, ccu.table_name AS to_table
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND ccu.table_schema = $1
      ORDER BY tc.table_name, ccu.table_name`,
    [schemaName],
  );
  return rows.rows.map((r) => ({ from: r.from_table, to: r.to_table }));
}
