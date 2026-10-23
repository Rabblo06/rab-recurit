/**
 * Production migration approval (finding N1, 2026-10-22). Which migrations a PRODUCTION-target run may apply.
 *
 * Every migration in core/migrations/ is loaded by the one migration glob (core.datasource.ts), so a migration written and
 * approved for the development database only (for example 1786719500000's crewflow_app EXECUTE grant, gate G1, or
 * 1786719520000's one-off privileged copy) would otherwise be applied by the next authorised production run. This module is
 * the explicit, reviewed list of what production may run. The guarded runner (GuardedMigrationDataSource.runMigrations)
 * checks it before any DDL and refuses the WHOLE run when any pending migration is not on it, so nothing is applied
 * partially. Local and test targets are not affected.
 *
 * Approving a migration for production is a deliberate, reviewed code change:
 *   - PRODUCTION_APPROVED_THROUGH covers the reviewed release baseline. 1786719300000 is the last of the 186 migrations in
 *     the release on origin/main 5968fc52 (docs/PRODUCTION_RELEASE_RUNBOOK_2026-10-22.md, section 0). Do not move it.
 *   - Anything later goes into PRODUCTION_APPROVED_MIGRATIONS by its exact migration name, with the owner gate that
 *     approved it, in the same change that updates the runbook.
 * A migration whose name has no 13-digit timestamp suffix is never covered by the baseline (fail closed).
 */
import type { DbTarget } from './database-target';

/** Last migration timestamp of the reviewed production release baseline (inclusive). */
export const PRODUCTION_APPROVED_THROUGH = 1786719300000;

/**
 * Migrations after the baseline that the owner has approved for production, by exact name. Empty: as of 2026-10-22 none
 * of 1786719400000..1786719620000 is approved for production (G1-prod is not approved; the privileged copy is dev-only).
 */
export const PRODUCTION_APPROVED_MIGRATIONS: ReadonlySet<string> = new Set<string>([]);

/** Targets that apply migrations without the production approval list. Anything else is checked (fail closed). */
const UNRESTRICTED_TARGETS: ReadonlySet<DbTarget> = new Set<DbTarget>(['local', 'test']);

export class UnapprovedProductionMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnapprovedProductionMigrationError';
  }
}

/** The 13-digit timestamp suffix of a migration name, or null when it has none. */
export function migrationTimestamp(name: string): number | null {
  const match = /(\d{13})$/.exec(name);
  return match ? Number(match[1]) : null;
}

export function isApprovedForProduction(
  name: string,
  approvedThrough: number = PRODUCTION_APPROVED_THROUGH,
  approved: ReadonlySet<string> = PRODUCTION_APPROVED_MIGRATIONS,
): boolean {
  if (approved.has(name)) return true;
  const timestamp = migrationTimestamp(name);
  return timestamp !== null && timestamp <= approvedThrough;
}

/**
 * Pure decision. `target` is undefined when the runner could not establish it; that is treated as restricted. Throws
 * UnapprovedProductionMigrationError naming every unapproved pending migration; never returns a partial allow-list.
 */
export function assertProductionMigrationApproval(input: {
  target: DbTarget | undefined;
  pendingMigrationNames: readonly string[];
  approvedThrough?: number;
  approved?: ReadonlySet<string>;
}): void {
  const { target, pendingMigrationNames } = input;
  if (target !== undefined && UNRESTRICTED_TARGETS.has(target)) return;
  const unapproved = pendingMigrationNames.filter((name) => !isApprovedForProduction(name, input.approvedThrough, input.approved));
  if (unapproved.length === 0) return;
  throw new UnapprovedProductionMigrationError(
    `Refusing to run migrations against DB_TARGET=${target ?? '<unknown>'}: ${unapproved.length} pending migration(s) are not approved for ` +
      `production: ${unapproved.join(', ')}. Nothing was applied. Approve each one by name in ` +
      `production-migration-approval.ts (PRODUCTION_APPROVED_MIGRATIONS) through a reviewed change, or deploy a release that ` +
      `does not contain them.`,
  );
}
