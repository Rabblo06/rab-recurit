/**
 * OWNER-DB-ULTIMATE Part C3, fail-closed routing (security review H-1(b) + re-check N-1 / N-2, lead decisions 2026-11-15).
 *
 * The gate and the state both live in the DATABASE, so they are one-way and cannot be switched off by code:
 *   - core.hws_cutover_activation: the "cutover active" sentinel, written once by the cutover command on its first run with
 *     HWS on and never removed (no UPDATE / DELETE policy) — pruning the command from upgrade-commands/registry.ts later
 *     cannot turn enforcement off (re-check N-2);
 *   - core.hws_cutover_state: 'started' / 'verified' per workspace, written only by the cutover (role crewflow) and, for a
 *     workspace created after activation, by the AFTER INSERT trigger on core.manager_workspace — never by an application call
 *     (re-check N-1: an UPDATE that fakes a new workspace's columns cannot mark it).
 * Rule (resolver + isWorkspaceUpgradeBlocked, read in the same statement as the registry row): 'started' → refused always;
 * once active, anything that is not 'verified' — a missing row included → refused (503 "workspace is being upgraded"). This
 * holds even when the cutover never got as far as writing a block marker (e.g. its very first query failed), so an uncopied
 * workspace is never served from an empty schema. A database without the tables fails the query → refused (fail closed).
 */

/** The SQL fragment both routing points add to their registry read (columns `cutover_state`, `cutover_active`). */
export const CUTOVER_ROUTING_COLUMNS_SQL = `(SELECT s.state FROM core.hws_cutover_state s WHERE s.workspace_id = r.workspace_id) AS cutover_state,
       EXISTS (SELECT 1 FROM core.hws_cutover_activation) AS cutover_active`;

/** Pure: must a workspace with this cutover state be refused, given whether the cutover is active? */
export function cutoverStateRefused(state: string | null | undefined, active: boolean | null | undefined): boolean {
  if (state === 'started') return true;
  return active === true && state !== 'verified';
}
