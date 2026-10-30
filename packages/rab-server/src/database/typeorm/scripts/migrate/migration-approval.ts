/**
 * Final review F5: the per-release migration approval is bound to the EXACT set of migrations it approves.
 *
 * Before: CREWFLOW_MIGRATION_APPROVED=apply-pending-migrations, a constant. A value left in .env.migrate (or a pipeline
 * variable) silently approved whatever was pending at the next release, so "approved" stopped meaning that anyone had
 * looked at what would run.
 *
 * Now the approval is a token derived from the ordered names of the pending migrations:
 *   pending-<count>-<sha256 hex>   sha256 over "crewflow-migration-approval-v1\n" + the pending names in RUN ORDER (TypeORM's
 *                                  MigrationExecutor order: the 13-digit timestamp suffix ascending; ties by name), joined
 *                                  by "\n" (a migration name never contains a newline). The order the migration files
 *                                  happen to load in never changes the token: it names a set, executed in the code's order.
 * The flow (deploy-prepare.ts; setup-db.ts with DB_TARGET=production uses the same gate):
 *   1. a check run (no approval) takes the migration lock, reads the pending set ON THE LOCKED SESSION, prints every
 *      pending name and the token for exactly that set, and exits 3 (nothing applied);
 *   2. the operator reviews the list and runs again with CREWFLOW_MIGRATION_APPROVED=<that token>;
 *   3. the apply run recomputes the token from the set pending NOW, after taking the lock (so no other run can change the
 *      ledger between this comparison and the apply), and refuses (exit 1, nothing applied) unless the two are equal.
 * A token can therefore approve one pending set only: left in a file, it approves nothing later (the next release has a
 * different set) and is refused, with the token that release needs.
 *
 * The retired constant `apply-pending-migrations` (and any value that is not a token) is REFUSED, never treated as "not
 * approved": a run that names an approval intends to apply, and a stale or mistyped approval must fail loudly rather than
 * quietly become a check. The refusal prints the pending names and the token to use. No compatibility path exists.
 *
 * The token is not a secret (anyone who can read the release's migration list can compute it); it records a decision, it
 * does not authenticate one. Who may run rab-migrate with the migration credential is the deployment platform's control.
 */
import { createHash } from 'crypto';

export const MIGRATION_APPROVAL_VAR = 'CREWFLOW_MIGRATION_APPROVED';
/** The retired standing approval. Refused with the token to use instead. */
export const LEGACY_MIGRATION_APPROVAL = 'apply-pending-migrations';
/** Domain separation: a hash of the same names for any other purpose never equals an approval token. */
const TOKEN_DOMAIN = 'crewflow-migration-approval-v1';
const TOKEN_SHAPE = /^pending-(0|[1-9]\d{0,5})-[0-9a-f]{64}$/;
/** How many pending names a refusal message spells out (the check run's log lists every one). */
const NAMES_IN_MESSAGE = 10;

export class MigrationApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationApprovalError';
  }
}

/**
 * The pending names in the order MigrationExecutor runs them (typeorm/migration/MigrationExecutor.js getMigrations: the
 * 13-digit timestamp suffix, ascending), ties broken by name so the order is total. Pure; returns a new array.
 */
export function pendingInRunOrder(pendingNames: readonly string[]): string[] {
  const timestampOf = (name: string) => Number(/(\d{13})$/.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return [...pendingNames].sort((a, b) => timestampOf(a) - timestampOf(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The approval token for exactly this pending set (hashed in run order). Pure. */
export function migrationApprovalToken(pendingNames: readonly string[]): string {
  for (const name of pendingNames) {
    if (!name || /[\r\n]/.test(name)) throw new MigrationApprovalError('a pending migration has an empty or multi-line name. Refusing.');
  }
  if (new Set(pendingNames).size !== pendingNames.length) throw new MigrationApprovalError('a pending migration name appears twice. Refusing.');
  const digest = createHash('sha256')
    .update([TOKEN_DOMAIN, ...pendingInRunOrder(pendingNames)].join('\n'))
    .digest('hex');
  return `pending-${pendingNames.length}-${digest}`;
}

/** Whether the value has the token's shape (it may still be for another pending set). */
export function isMigrationApprovalToken(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

/** The approval from the process environment: the trimmed value, or null when unset or blank (a check run). */
export function readMigrationApproval(env: Record<string, string | undefined>): string | null {
  const value = env[MIGRATION_APPROVAL_VAR]?.trim();
  return value ? value : null;
}

/** `N pending: a, b, … (+M more)` — names only, never a URL or credential. */
export function describePendingSet(pendingNames: readonly string[]): string {
  if (pendingNames.length === 0) return 'nothing is pending';
  const shown = pendingInRunOrder(pendingNames).slice(0, NAMES_IN_MESSAGE).join(', ');
  const more = pendingNames.length > NAMES_IN_MESSAGE ? `, … (+${pendingNames.length - NAMES_IN_MESSAGE} more; the check run lists them all)` : '';
  return `${pendingNames.length} pending: ${shown}${more}`;
}

/**
 * The apply-run gate, on the pending set read on the locked session. Throws MigrationApprovalError (nothing has been applied
 * yet) unless `approval` is the token of exactly `pendingNames`. With nothing pending, a well-formed token approves nothing
 * and passes (an identical second run that waited behind the first stays a no-op); the retired constant and a malformed
 * value are refused whatever is pending, so a standing value is surfaced at the first run that sees it.
 */
export function assertMigrationApproval(approval: string, pendingNames: readonly string[]): void {
  const token = migrationApprovalToken(pendingNames);
  const howTo =
    pendingNames.length === 0
      ? `Nothing is pending: remove ${MIGRATION_APPROVAL_VAR}.`
      : `Review them; to apply exactly this set, set ${MIGRATION_APPROVAL_VAR}=${token} for this one run.`;
  if (approval === LEGACY_MIGRATION_APPROVAL) {
    throw new MigrationApprovalError(
      `${MIGRATION_APPROVAL_VAR}=${LEGACY_MIGRATION_APPROVAL} is no longer accepted: a standing approval approved every later release ` +
        `(final review F5). An approval now names the exact pending set. ${describePendingSet(pendingNames)}. ${howTo} Nothing was applied. Refusing.`,
    );
  }
  if (!isMigrationApprovalToken(approval)) {
    throw new MigrationApprovalError(
      `${MIGRATION_APPROVAL_VAR} is not a migration approval token (pending-<count>-<sha256>; value not shown). ${describePendingSet(pendingNames)}. ` +
        `${howTo} Nothing was applied. Refusing.`,
    );
  }
  if (pendingNames.length === 0) return;
  if (approval !== token) {
    throw new MigrationApprovalError(
      `${MIGRATION_APPROVAL_VAR} approves a different set of migrations than the one pending now (a stale approval from an ` +
        `earlier release, or the set changed since the check run). ${describePendingSet(pendingNames)}. ${howTo} Nothing was applied. Refusing.`,
    );
  }
}
