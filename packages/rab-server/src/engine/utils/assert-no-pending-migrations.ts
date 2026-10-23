import { DataSource } from 'typeorm';

export class PendingMigrationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PendingMigrationsError';
  }
}

/**
 * Fail closed at API startup (Twenty-parity Phase 7): the API never migrates on its own, and it refuses to serve against
 * a schema that is behind its code. A migration that failed (rolled back, so still unrecorded) or one that is pending
 * without approval both land here. The only ways forward are the explicit, approved steps: the one-shot `rab-migrate`
 * service, or the api prestart (`packages/rab-docker/rab/api-prestart.sh`) with CREWFLOW_MIGRATION_APPROVED set for that
 * one deploy.
 *
 * Runs as the restricted runtime role, read-only: `crewflow_app` has SELECT (only) on `core.migrations`. The list of
 * migrations the code expects is the runtime DataSource's own loaded migration set (the same glob the migration runner
 * uses), compared by name with the ledger. A ledger AHEAD of the code (an image rollback) is not refused here.
 */
export async function assertNoPendingMigrations(dataSource: DataSource, processName: string): Promise<void> {
  const expected = dataSource.migrations.map((m) => m.name ?? m.constructor.name);
  if (expected.length === 0) {
    throw new PendingMigrationsError(`Refusing to start the ${processName}: no migrations are loaded, so the schema version cannot be checked.`);
  }
  let applied: Set<string>;
  try {
    const rows = (await dataSource.query('SELECT name FROM core.migrations')) as Array<{ name: string }>;
    applied = new Set(rows.map((r) => r.name));
  } catch (error) {
    const code = (error as { code?: string })?.code ?? 'no-sqlstate';
    throw new PendingMigrationsError(`Refusing to start the ${processName}: the migration ledger could not be read (SQLSTATE ${code}).`);
  }
  const pending = expected.filter((name) => !applied.has(name));
  if (pending.length > 0) {
    const shown = pending.slice(0, 5).join(', ') + (pending.length > 5 ? `, ... (+${pending.length - 5})` : '');
    throw new PendingMigrationsError(
      `Refusing to start the ${processName}: ${pending.length} migration(s) are not applied: ${shown}. ` +
        'The API never migrates on its own. Apply them through the approved migration step (rab-migrate, or the api prestart with ' +
        'CREWFLOW_MIGRATION_APPROVED=apply-pending-migrations for one deploy), then start again.',
    );
  }
}
