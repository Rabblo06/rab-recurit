/**
 * Runs pending core migrations: the developer/CI/e2e entrypoint (`nx run rab-server:migration:run`, the `migrate`
 * compose services). Production deploys run deploy-prepare.ts, which adds the approval gate and post-checks around the
 * same runner.
 *
 * Phase B (P7): the run is serialised by the migration advisory lock taken on the migration session itself, and every gate
 * (DB_TARGET, N1 production approval, CF-41 identity) is re-checked after the lock, on that session
 * (migrate/locked-migration-runner.ts). The connection is PG_DATABASE_URL, the migration-only credential of this one-off
 * process (legacy DATABASE_URL_UNPOOLED / DATABASE_URL accepted outside production with a warning; migrate/
 * migration-database-url.ts). Failure exits non-zero, so nothing that depends on this run starts on a partially migrated
 * schema. Policy: docs/architecture/MIGRATION-EXECUTION-POLICY.md.
 *
 * Security review L-2: this script ships in the image, so with DB_TARGET=production it now requires the same per-release
 * approval as deploy-prepare (CREWFLOW_MIGRATION_APPROVED, from the process environment, never a .env file) and refuses
 * before any connection without it. Final review F5: the approval is the token of the exact pending set
 * (migrate/migration-approval.ts; deploy-prepare's check run prints it), checked again on the locked session against the
 * set pending at that moment; the retired constant `apply-pending-migrations` is refused. N1 (production-migration-approval.ts) is unchanged and still
 * limits WHAT may apply; local / test runs are unchanged. L-2 follow-up: "a .env file" means EVERY dotenv source that can
 * reach this process — the working directory's .env (dotenv/config's default), the file DOTENV_CONFIG_PATH (or a
 * `dotenv_config_path=` argument) points dotenv/config at, and packages/rab-server/.env with every other dotenv file Nx
 * loads (final review F6: .env.local, .env.<target>, the repository root's .env, ...; nx-dotenv-files.ts), which Nx injects into
 * `nx run rab-server:migration:run` without dotenv ever seeing it (database-target.ts PRODUCTION_AUTHORITY_VARS refuses it
 * there too).
 */
import 'dotenv/config';

import * as fs from 'fs';
import * as path from 'path';

import { parse as parseDotenv } from 'dotenv';

import { readDotenvValues } from '../core/database-target';
import { redactConnectionStrings, runLockedMigrations } from './migrate/locked-migration-runner';
import {
  assertMigrationApproval,
  isMigrationApprovalToken,
  LEGACY_MIGRATION_APPROVAL,
  MIGRATION_APPROVAL_VAR,
  readMigrationApproval,
} from './migrate/migration-approval';

export { MIGRATION_APPROVAL_VAR };

/**
 * The production approval gate of setup-db. Pure. `dotenvValues` is the working directory's .env as data (what
 * `dotenv/config` loaded into process.env): an approval found there is refused, because the approval is a per-release
 * decision of the deployment environment, never a standing file entry. Returns the refusal message, or null to proceed.
 */
export function setupDbApprovalRefusal(env: Record<string, string | undefined>, dotenvValues: Record<string, string> = {}): string | null {
  if (env.DB_TARGET?.trim() !== 'production') return null;
  if (dotenvValues[MIGRATION_APPROVAL_VAR] !== undefined) {
    return `${MIGRATION_APPROVAL_VAR} is present in a .env file. A production approval comes only from the deployment environment of the one approved run. Nothing was run. Refusing.`;
  }
  const approval = readMigrationApproval(env);
  if (approval === null) {
    return (
      `setup-db with DB_TARGET=production applies pending migrations only with ${MIGRATION_APPROVAL_VAR}=<approval token> set for this one ` +
      "approved release: the token deploy-prepare's check run prints for the exact pending set (production deploys should run " +
      'deploy-prepare / rab-migrate). Nothing was run. Refusing.'
    );
  }
  // F5: the retired constant and anything that is not a token are refused before any connection; a well-formed token is
  // compared with the set pending after the lock (runLockedMigrations approvePending).
  if (approval === LEGACY_MIGRATION_APPROVAL || !isMigrationApprovalToken(approval)) {
    const legacy = approval === LEGACY_MIGRATION_APPROVAL ? ` (${LEGACY_MIGRATION_APPROVAL} is no longer accepted: final review F5)` : '';
    return (
      `${MIGRATION_APPROVAL_VAR} is not a migration approval token${legacy}. Run deploy-prepare without an approval to list the pending ` +
      'migrations and print the token for exactly that set. Nothing was run. Refusing.'
    );
  }
  return null;
}

function readDotenvFile(filePath: string): Record<string, string> {
  return fs.existsSync(filePath) ? parseDotenv(fs.readFileSync(filePath)) : {};
}

/**
 * The dotenv files whose values can reach this process (security review L-2 follow-up), as data only: the working
 * directory's .env, the DOTENV_CONFIG_PATH / `dotenv_config_path=` file dotenv/config loads instead, and
 * every dotenv file Nx injects (database-target.ts readDotenvValues; final review F6). A key present in ANY of them counts as
 * "from a .env file". `readServerDotenv`
 * is a test seam.
 */
export function readSetupDbDotenvSources(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
  cwd: string = process.cwd(),
  readServerDotenv: () => Record<string, string> = () => readDotenvValues(),
): Record<string, string> {
  const files = new Set<string>([path.resolve(cwd, '.env')]);
  const configured = [env.DOTENV_CONFIG_PATH, ...argv.filter((a) => a.startsWith('dotenv_config_path=')).map((a) => a.slice('dotenv_config_path='.length))];
  for (const file of configured) if (file?.trim()) files.add(path.resolve(cwd, file.trim()));
  const merged: Record<string, string> = { ...readServerDotenv() };
  for (const file of files) Object.assign(merged, readDotenvFile(file));
  return merged;
}

async function main(): Promise<void> {
  const refusal = setupDbApprovalRefusal(process.env, readSetupDbDotenvSources());
  if (refusal) throw new Error(refusal);
  const approval = process.env.DB_TARGET?.trim() === 'production' ? readMigrationApproval(process.env) : null;
  const result = await runLockedMigrations({
    label: 'setup-db',
    // F5: production only (setupDbApprovalRefusal required a token); local / test runs are unchanged.
    approvePending: approval === null ? undefined : (pending) => assertMigrationApproval(approval, pending),
  });
  // eslint-disable-next-line no-console
  console.log(`Migrations applied: ${result.applied.length === 0 ? 'none pending' : result.applied.join(', ')}`);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
      // eslint-disable-next-line no-console
      console.error(`Migration run failed: ${redactConnectionStrings(message)}`);
      process.exit(1);
    },
  );
}
