/**
 * Owner-login architecture: what the migrate-on-start child decides after a FAILED upgrade, under CREWFLOW_UPGRADE_FAILURE
 * (parsed by runtime-db-config.ts readUpgradeFailurePolicy; default `continue`, owner decision C3 2026-11-05, "exactly like
 * Twenty": "completed with errors ... continuing startup").
 *
 *   fresh install (the run started EMPTY / BOOTSTRAP-PARTIAL, or a proven fresh CHAIN-PARTIAL)  never serves: the child keeps
 *                                                                                                its failure exit code;
 *   refuse                                                                                       never serves (the previous
 *                                                                                                behaviour, unchanged);
 *   continue (default)                                                                           serves (exit 70) after an
 *     UPGRADE MIGRATION failure, logged as an ERROR naming the migration and the reason, never as success. The caller
 *     (migrate-on-start.ts) offers only a migration failure (outcome migrationFailed) here: configuration, identity, lock
 *     timeout, approval (behind) and post-check failures stay fail-closed under every policy.
 *
 * Under continue every check below still runs and is reported (the operator sees the whole picture), but only ONE gates the
 * start: deployment-identity (fail closed on identity). The others are diagnostics of the degraded state:
 *   ledger-compatible     schema-compatibility.ts for process 'api': after a failed upgrade it normally reports the pending
 *                         migrations (the API's boot gate 7 is relaxed for that by api-prestart's signal, Agent 2).
 *   no-partial-migration  the failed migration (if any) is not one of the `transaction = false` migrations, which can
 *                         leave partial DDL without a ledger row.
 *   post-checks           deploy-post-checks.ts deployPostCheckProblems(): secure-owner invariants, RLS enabled on every
 *                         tenant table, the login owns nothing, schema compatibility (function + READY workspaces).
 *   required-functions    the functions the API and the Worker call exist and the login may EXECUTE them.
 *   deployment-identity   the caller's hook: the deployment identity check the API boot performs (marker, id, host). GATES.
 *   posture               the caller's hook: Agent 3's posture / drift monitor (absent = reported as not wired).
 *
 * Importing this module has no side effects (no environment read, no connection).
 */
import { assessSchemaCompatibility, readLedgerNames } from '../../../../boot-checks/schema-compatibility';
import { readProvisionFunctionState } from '../../../workspace-schema/provision-function-versions';
import { deployPostCheckProblems } from '../deploy-post-checks';
import type { Query } from '../locked-migration-runner';
import { readUpgradeFailurePolicy, UpgradeFailurePolicy } from '../../../../owner-login/runtime-db-config';

export type { UpgradeFailurePolicy };

/** CREWFLOW_UPGRADE_FAILURE (+ its deprecated alias), parsed by the ONE runtime config module (default continue; invalid = exit 64). */
export function parseUpgradeFailurePolicy(env: Record<string, string | undefined>): UpgradeFailurePolicy {
  return readUpgradeFailurePolicy(env);
}

/**
 * The `transaction = false` migrations (M0: the runner comment said six). + the index fix (2026-11-06): 1786721440000 and
 * 1786721450000 (CREATE INDEX CONCURRENTLY; a failed build leaves an INVALID index that their re-run drops). + Phase X U-1
 * (SU-03 / XD-04, 2026-11-11): 1786721430000 WorkspaceGrantParityGuards, which commits one transaction per workspace schema
 * and so may keep part of its work after a failure; it was missing, so its failure was reported as "rolled back with its
 * ledger row". Diagnostics only (the no-partial-migration check): the serve decision of C3 is unchanged. The spec derives
 * this list from the migration sources and compares.
 */
export const NON_TRANSACTIONAL_MIGRATIONS: readonly number[] = [
  1786676100000, 1786719810000, 1786719920000, 1786719950000, 1786720110000, 1786721090000, 1786721320000, 1786721430000, 1786721440000,
  1786721450000,
];

/** Called by the API and the Worker; the owner login reaches each through its role memberships. */
export const REQUIRED_FUNCTIONS: readonly string[] = [
  'core.current_org()',
  'core.current_uid()',
  'core.current_workspace()',
  'core.provision_workspace(uuid)',
  'core.deployment_identity_check()',
  'core.worker_claim_due_work(text,integer,integer)',
  'core.worker_complete_due_work(uuid,uuid)',
  'core.worker_reschedule_due_work(uuid,uuid,timestamp with time zone)',
  'core.worker_claim_email_dispatch(integer)',
  'core.worker_release_dispatch_claim(text,uuid,uuid,integer)',
];

export interface UpgradeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface UpgradeVerdict {
  serve: boolean;
  policy: UpgradeFailurePolicy;
  reason: string;
  checks: UpgradeCheck[];
}

export interface AssessUpgradeFailureInput {
  policy: UpgradeFailurePolicy;
  /** The run started on a fresh install: a failure never serves. */
  freshInstall: boolean;
  /** The migration that failed, when one did (null: the failure was elsewhere). */
  failedMigration: string | null;
  /** The code's loaded migration names. */
  expectedMigrations: readonly string[];
  /** A fresh session of the same login. */
  query: Query;
  production: boolean;
  /** Returns null when the deployment identity is OK, else the problem. Required: absent = FAIL. */
  deploymentIdentityCheck?: (query: Query) => Promise<string | null>;
  /** Agent 3's posture / drift monitor: the problems found (empty = OK). Absent = FAIL until it exists. */
  postureCheck?: (query: Query) => Promise<string[]>;
}

const timestampOf = (name: string) => Number(/(\d{13})$/.exec(name)?.[1] ?? Number.NaN);

async function guarded(name: string, fn: () => Promise<UpgradeCheck>): Promise<UpgradeCheck> {
  try {
    return await fn();
  } catch (error) {
    const code = (error as { code?: string })?.code;
    return { name, ok: false, detail: `the check itself failed (${error instanceof Error ? error.name : 'error'}${code ? `, SQLSTATE ${code}` : ''}): fail closed` };
  }
}

/** Runs every check (even after one fails, so the operator sees the whole picture), then decides. */
export async function assessUpgradeFailure(input: AssessUpgradeFailureInput): Promise<UpgradeVerdict> {
  const { policy } = input;
  if (input.freshInstall) {
    return { serve: false, policy, reason: 'a first-install failure never serves (the API must not become healthy on a half-installed database)', checks: [] };
  }
  if (policy === 'refuse') {
    return { serve: false, policy, reason: 'CREWFLOW_UPGRADE_FAILURE=refuse: the API stays unready', checks: [] };
  }
  const q = input.query;
  const checks: UpgradeCheck[] = [];
  checks.push(
    await guarded('ledger-compatible', async () => {
      const applied = await readLedgerNames(q, 'upgrade-failure assessment');
      const assessment = assessSchemaCompatibility(
        'api',
        { expected: input.expectedMigrations, applied, provisionFunction: await readProvisionFunctionState(q) },
        { production: input.production },
      );
      return {
        name: 'ledger-compatible',
        ok: assessment.refusals.length === 0,
        detail: assessment.refusals.length ? assessment.refusals.map((r) => r.finding).join(', ') : `api compatibility passes (${assessment.warnings.length} warning(s))`,
      };
    }),
  );
  checks.push({
    name: 'no-partial-migration',
    ok: input.failedMigration === null || !NON_TRANSACTIONAL_MIGRATIONS.includes(timestampOf(input.failedMigration)),
    detail:
      input.failedMigration === null
        ? 'no migration failed'
        : NON_TRANSACTIONAL_MIGRATIONS.includes(timestampOf(input.failedMigration))
          ? `${input.failedMigration} runs with transaction = false and may have left partial DDL`
          : `${input.failedMigration} is transactional (rolled back with its ledger row)`,
  });
  checks.push(
    await guarded('post-checks', async () => {
      const problems = await deployPostCheckProblems(q);
      return { name: 'post-checks', ok: problems.length === 0, detail: problems.length ? problems.slice(0, 10).join('; ') : 'none' };
    }),
  );
  checks.push(
    await guarded('required-functions', async () => {
      const rows = (await q(
        `SELECT s.sig, pg_catalog.to_regprocedure(s.sig) IS NOT NULL AS "exists",
                CASE WHEN pg_catalog.to_regprocedure(s.sig) IS NULL THEN false ELSE pg_catalog.has_function_privilege(pg_catalog.to_regprocedure(s.sig), 'EXECUTE') END AS "exec"
           FROM pg_catalog.unnest($1::text[]) AS s(sig)`,
        [[...REQUIRED_FUNCTIONS]],
      )) as Array<{ sig: string; exists: boolean; exec: boolean }>;
      const bad = rows.filter((r) => !r.exists || !r.exec).map((r) => `${r.sig}${r.exists ? ' (no EXECUTE)' : ' (missing)'}`);
      return { name: 'required-functions', ok: bad.length === 0, detail: bad.length ? bad.join(', ') : `${rows.length} present and executable` };
    }),
  );
  checks.push(
    input.deploymentIdentityCheck
      ? await guarded('deployment-identity', async () => {
          const problem = await input.deploymentIdentityCheck!(q);
          return { name: 'deployment-identity', ok: problem === null, detail: problem ?? 'OK' };
        })
      : { name: 'deployment-identity', ok: false, detail: 'no deployment identity check supplied: fail closed' },
  );
  checks.push(
    input.postureCheck
      ? await guarded('posture', async () => {
          const problems = await input.postureCheck!(q);
          return { name: 'posture', ok: problems.length === 0, detail: problems.length ? problems.slice(0, 10).join('; ') : 'OK' };
        })
      : { name: 'posture', ok: false, detail: 'the posture / drift monitor is not wired yet (Agent 3): fail closed' },
  );
  const failed = checks.filter((c) => !c.ok);
  const identity = checks.find((c) => c.name === 'deployment-identity');
  if (!identity?.ok) {
    return { serve: false, policy, reason: `continue: the deployment identity check failed (${identity?.detail ?? 'missing'}); fail closed on identity, the API stays unready`, checks };
  }
  const what = input.failedMigration ?? 'unknown migration';
  const diagnostics = failed.length ? `; ${failed.length} diagnostic check(s) failed (${failed.map((c) => c.name).join(', ')})` : '';
  return { serve: true, policy, reason: `continue: the upgrade FAILED at ${what}; continuing startup on the previous schema (exit 70)${diagnostics}`, checks };
}
