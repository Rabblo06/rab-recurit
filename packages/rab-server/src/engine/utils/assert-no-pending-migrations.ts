import { DataSource } from 'typeorm';

import {
  checkSchemaCompatibility,
  CompatibilityProcess,
  SchemaCompatibilityAssessment,
} from '../../database/boot-checks/schema-compatibility';

/** Every refusal is a SchemaCompatibilityError; the old name is kept for callers that catch it by name. */
export { SchemaCompatibilityError as PendingMigrationsError } from '../../database/boot-checks/schema-compatibility';

export interface AssertNoPendingMigrationsOptions {
  /** Policy row of src/database/boot-checks/schema-compatibility.ts (default 'api'). */
  process?: CompatibilityProcess;
  /** Production as the process declares it (decides "refuse in production" findings). Default false. */
  production?: boolean;
  /** Also read core.provision_workspace(uuid)'s body (default: whatever the process policy checks). */
  provisionFunction?: boolean;
  /** Fleet scan of READY workspaces (provisioner only: needs crewflow). */
  workspaces?: boolean;
}

/**
 * Fail closed at startup (Twenty-parity Phase 7, Phase B schema compatibility): the API never migrates on its own, and it
 * refuses to serve against a schema that is behind its code. A migration that failed (rolled back, so still unrecorded) or
 * one that is pending without approval both land here. The only ways forward are the explicit, approved steps: the
 * one-shot `rab-migrate` service (deploy:prepare). The api prestart (`packages/rab-docker/rab/api-prestart.sh`) only checks;
 * it refuses to start when CREWFLOW_MIGRATION_APPROVED or any migration credential reaches the API.
 *
 * Phase B: also refuses a ledger holding migrations this code does not know that are NOT all newer than its newest one
 * (another branch / wrong database), and — per process policy — a ledger AHEAD of the code (image rollback: the API, the
 * Worker and the CLI warn and run; the provisioner refuses) and an incompatible `core.provision_workspace` body. See
 * src/database/boot-checks/schema-compatibility.ts for the whole matrix.
 *
 * Runs as the restricted runtime role, read-only: `crewflow_app` has SELECT (only) on `core.migrations`, and pg_proc is
 * world-readable. The list of migrations the code expects is the runtime DataSource's own loaded migration set (the same
 * glob the migration runner uses), compared by name with the ledger. Returns the assessment (its `warnings` are for the
 * caller to log).
 */
export async function assertNoPendingMigrations(
  dataSource: DataSource,
  processName: string,
  options: AssertNoPendingMigrationsOptions = {},
): Promise<SchemaCompatibilityAssessment> {
  return checkSchemaCompatibility((sql, params) => dataSource.query(sql, params) as Promise<unknown[]>, {
    process: options.process ?? 'api',
    production: options.production ?? false,
    expected: dataSource.migrations.map((m) => m.name ?? m.constructor.name),
    label: processName,
    provisionFunction: options.provisionFunction,
    workspaces: options.workspaces,
  });
}
