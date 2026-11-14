/**
 * Phase B (P7): the cheap, read-only checks deploy-prepare.ts runs on the locked migration session after the migrations,
 * before it reports success (and before any cache flush). The full golden posture comparison (check-db-security-posture.ts)
 * needs the committed snapshot, which is not shipped in the image; the API/Worker boot gates carry the runtime checks.
 *
 *   1. Phase 0b secure-owner invariants (core/secure-owner-invariants.ts), once SecureOwnerCoreSchemaAndHelpers is applied.
 *   2. RLS spot check: every `core` table with an `organisation_id` column has row level security ENABLED. (FORCE and the
 *      NOT-FORCE allow-list stay with tools/check-rls-coverage.ts in CI; this catches a table shipped with RLS off.)
 *   3. The migration identity owns no table, view, sequence or function in `core` or a `workspace_*` schema (extension
 *      members excluded). An object it owned would escape every policy that is not FORCEd for its owner. Skipped for a
 *      superuser, which is only a disposable/local bootstrap identity.
 *   4. Phase B schema compatibility (src/database/boot-checks/schema-compatibility.ts, process 'migrate-apply'):
 *      `core.provision_workspace(uuid)` carries an app_version literal this code knows, at exactly
 *      LATEST_WORKSPACE_MODULE_VERSION; and every READY workspace is at exactly LATEST (enumerated with
 *      core.worker_list_workspaces, each registry row read with its organisation bound — the migration identity reaches
 *      both through its crewflow membership). A release whose migrations left a workspace behind is not promoted.
 */
import { assessSchemaCompatibility, readReadyWorkspaceModuleLevels } from '../../../boot-checks/schema-compatibility';
import { secureOwnerInvariantViolations } from '../../core/secure-owner-invariants';
import { readProvisionFunctionState } from '../../workspace-schema/provision-function-versions';
import type { Query } from './locked-migration-runner';
import type { WorkspaceUpgradeCommand } from '../../../../engine/core-modules/upgrade/upgrade-commands/workspace-upgrade-command';
import { codeWorkspaceStructureLevel, declaredProvisionLiterals } from '../../../../engine/core-modules/upgrade/workspace-structure-level';
import { LATEST_WORKSPACE_MODULE_VERSION } from '../../workspace-schema/workspace-schema-modules';

/**
 * Part D (security review M3): the workspace upgrade registry the gates derive the code's structure level and the
 * provision-function literals from. Production passes nothing (WORKSPACE_UPGRADE_COMMANDS); only the in-process start
 * spec passes a probe registry and restricts the fleet scan to its own workspaces (no environment variable maps to either).
 */
export interface PostCheckOptions {
  workspaceRegistry?: Readonly<Record<string, readonly WorkspaceUpgradeCommand[]>>;
  workspaceIds?: readonly string[];
}

export const PHASE_0B_MIGRATION = 'SecureOwnerCoreSchemaAndHelpers1786721100000';

export async function deployPostCheckProblems(query: Query, options: PostCheckOptions = {}): Promise<string[]> {
  const problems: string[] = [];
  const [{ hasLedger }] = (await query(`SELECT to_regclass('core.migrations') IS NOT NULL AS "hasLedger"`)) as Array<{ hasLedger: boolean }>;
  const phase0b = hasLedger && ((await query('SELECT 1 FROM core.migrations WHERE name = $1', [PHASE_0B_MIGRATION])) as unknown[]).length > 0;
  if (phase0b) {
    for (const v of await secureOwnerInvariantViolations(async (sql) => (await query(sql)) as Array<Record<string, unknown>>)) {
      problems.push(`secure-owner-invariant ${v}`);
    }
  }

  const rlsOff = (await query(
    `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'core' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organisation_id' AND NOT a.attisdropped)
      ORDER BY 1`,
  )) as Array<{ relname: string }>;
  for (const r of rlsOff) problems.push(`rls-disabled core.${r.relname}`);

  const [{ superuser }] = (await query('SELECT rolsuper AS "superuser" FROM pg_catalog.pg_roles WHERE rolname = current_user')) as Array<{ superuser: boolean }>;
  if (!superuser) {
    const owned = (await query(
      `SELECT n.nspname || '.' || c.relname AS "name" FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
          AND (n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$')
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       UNION ALL
       SELECT n.nspname || '.' || p.proname || '()' FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
          AND (n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$')
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
       ORDER BY 1`,
    )) as Array<{ name: string }>;
    for (const o of owned) problems.push(`owned-by-migration-identity ${o.name}`);
  }

  problems.push(...(await schemaCompatibilityPostCheckProblems(query, options)));
  return problems;
}

/** Check 4 alone (exported for the integration spec). The ledger was already compared by the runner, before applying. */
export async function schemaCompatibilityPostCheckProblems(query: Query, options: PostCheckOptions = {}): Promise<string[]> {
  const assessment = assessSchemaCompatibility(
    'migrate-apply',
    {
      expected: [],
      applied: [],
      provisionFunction: await readProvisionFunctionState(query, declaredProvisionLiterals(options.workspaceRegistry)),
      workspaces: await readReadyWorkspaceModuleLevels(query, 100, options.workspaceIds),
    },
    // Ahead = above the code's structure level; behind = below the frozen template (20): 20..code level is brought up by the
    // workspace command runner right after these post-checks, in the same locked run (D-RUNNER.md §6).
    { production: false, latestModuleVersion: codeWorkspaceStructureLevel(options.workspaceRegistry), floorModuleVersion: LATEST_WORKSPACE_MODULE_VERSION },
  );
  return assessment.refusals.map((r) => `schema-compatibility ${r.finding}: ${r.message}`);
}
