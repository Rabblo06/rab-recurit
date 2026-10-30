/**
 * Phase B (schema-version compatibility gates): migration names a database's ledger (`core.migrations`) may legitimately
 * hold although this code no longer ships the migration class — a migration RETIRED from core/migrations/ (moved to a
 * draft, folded into another, or renamed) after some databases had already applied it.
 *
 * The compatibility assessment (src/database/boot-checks/schema-compatibility.ts) ignores these names when it looks for
 * ledger rows the code does not know. Any OTHER unknown name whose 13-digit timestamp is not newer than the code's newest
 * migration is "interleaved" (another branch's migration, a wrong database, a forked chain) and refused everywhere.
 *
 * Append-only, one entry per retired migration, each with the decision that retired it. Empty today: the owner has not
 * decided whether HwsHistoricalRowsPrivilegedCopy1786719520000 moves out of core/migrations/ (proposal 1); when it does,
 * its name is added here in the same change.
 */
export const RETIRED_MIGRATIONS: readonly string[] = Object.freeze([]);
