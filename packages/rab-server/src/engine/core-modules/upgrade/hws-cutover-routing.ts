/**
 * OWNER-DB-ULTIMATE Part C3, fail-closed routing (security review H-1(b), lead decision 2026-11-15).
 *
 * Once the HWS cutover command is part of this code (registered in a release of upgrade-commands/registry.ts), a workspace is
 * routed to its schema ONLY when core.hws_cutover_state says 'verified' for it:
 *   - written by the cutover when it copied and verified the workspace, or found nothing of it in core;
 *   - written at creation for every NEW workspace (no core data by construction), in the creating transaction, through the
 *     definer core.hws_cutover_mark_new_workspace (only for a workspace created in that same transaction).
 * A missing or 'started' state → refused like a blocked workspace (503 "workspace is being upgraded"). This holds even when the
 * cutover never got far enough to write a block marker (e.g. its very first query failed), so an uncopied workspace is never
 * served from an empty schema. Unreadable state → the resolver's query fails → refused (fail closed).
 *
 * The gate is a code fact (a cached constant: is the command registered?), so HWS-on development and CI keep routing every
 * workspace exactly as before until the release that activates the cutover. Before activation only 'started' is refused.
 */
import { UPGRADE_COMMANDS } from './upgrade-commands/registry';
import type { UpgradeCommand } from './upgrade-commands/upgrade-command';

/** Must equal HWS_CUTOVER_NAME in upgrade-commands/0-7/hws-cutover.ts (hws-cutover.spec.ts proves it). */
export const HWS_CUTOVER_COMMAND_NAME = 'HwsCutover';

/** Whether the HWS cutover command is registered in any release of the given registry (pure). */
export function hwsCutoverRegisteredIn(registry: Readonly<Record<string, readonly UpgradeCommand[]>>): boolean {
  return Object.values(registry).some((commands) => commands.some((c) => c.name === HWS_CUTOVER_COMMAND_NAME));
}

/** The process-wide gate: computed once (the registry is a frozen code constant). */
export const HWS_CUTOVER_ROUTING_ENFORCED: boolean = hwsCutoverRegisteredIn(UPGRADE_COMMANDS);

/** Nest injection token: an explicit override of the gate (integration specs only; production never provides it). */
export const HWS_CUTOVER_ROUTING_GATE = Symbol('HWS_CUTOVER_ROUTING_GATE');

/** Pure: must a workspace with this cutover state be refused? */
export function cutoverStateRefused(state: string | null | undefined, enforced: boolean): boolean {
  if (state === 'started') return true;
  return enforced && state !== 'verified';
}

type Query = (sql: string, parameters?: unknown[]) => Promise<unknown[]>;

export class HwsCutoverMarkError extends Error {
  constructor() {
    super('the new workspace could not be marked as cut over (core.hws_cutover_mark_new_workspace); nothing was created');
    this.name = 'HwsCutoverMarkError';
  }
}

/**
 * Creation hook: in the transaction that inserted the workspace, mark it 'verified' — only when this process routes to the
 * workspace schemas (HWS on) and the cutover is active. With HWS off the new workspace's data goes to the core copies, so it
 * must stay unmarked (the cutover copies it later). A refusal throws, so the create rolls back (fail closed).
 */
export async function markNewWorkspaceCutoverVerified(
  query: Query,
  workspaceId: string,
  opts: { hwsRuntimeEnabled: boolean; enforced?: boolean },
): Promise<boolean> {
  if (!opts.hwsRuntimeEnabled || !(opts.enforced ?? HWS_CUTOVER_ROUTING_ENFORCED)) return false;
  const [row] = (await query('SELECT core.hws_cutover_mark_new_workspace($1) AS marked', [workspaceId])) as Array<{ marked: boolean }>;
  if (row?.marked !== true) throw new HwsCutoverMarkError();
  return true;
}
