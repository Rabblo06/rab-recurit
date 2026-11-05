/**
 * Phase B: "the API and the Worker must refuse incompatible schema versions" (proposal 03). ONE assessment, used by
 *
 *   API / Worker jobs / CLI   database-boot-gates.ts gate 7 (via assertNoPendingMigrations) and the API prestart
 *                             (scripts/check-pending-migrations.ts)
 *   Provisioner child         rab-worker/src/workspace-provisioner.main.ts (boot gates + before every provisioning cycle)
 *   rab-migrate               scripts/migrate/locked-migration-runner.ts (ledger, before applying) and
 *                             scripts/migrate/deploy-post-checks.ts (provision function + READY workspaces, after applying)
 *
 * What it compares (all reads, no new SQL object):
 *   ledger      the code's loaded migrations vs `core.migrations`:
 *                 pending      expected, not applied                                     (a)
 *                 newer        applied, unknown to the code, every one with a 13-digit timestamp newer than the code's
 *                              newest migration: a pure image rollback                    (b1)
 *                 interleaved  applied, unknown, not in RETIRED_MIGRATIONS and NOT all newer (another branch, a wrong
 *                              database, a forked chain); a name without a timestamp counts here (fail closed)  (b2)
 *   function    `core.provision_workspace(uuid)`'s app_version literal (pg_proc.prosrc) through the frozen map in
 *               workspace-schema/provision-function-versions.ts, vs LATEST_WORKSPACE_MODULE_VERSION   (d1 unknown,
 *               d2 behind, d3 ahead)
 *   workspaces  READY workspaces' `module_version` vs LATEST (provisioner and rab-migrate only; the API/Worker check
 *               the module version per request in SchemaResolverService instead)   (c1 behind, c2 ahead)
 *
 * The policy per process is the table below (POLICIES). Principle: refuse whatever can corrupt data, attest a wrong
 * structure or write with the wrong shape; WARN what an expand-only release history makes safe, so an image rollback
 * stays possible for the API and the Worker. A DB-side compatibility floor (b3) needs new SQL and is not implemented.
 */
import { RETIRED_MIGRATIONS } from '../typeorm/core/retired-migrations';
import { describeProvisionFunctionState, ProvisionFunctionState, readProvisionFunctionState } from '../typeorm/workspace-schema/provision-function-versions';
import { LATEST_WORKSPACE_MODULE_VERSION } from '../typeorm/workspace-schema/workspace-schema-modules';

export type CompatibilityProcess = 'api' | 'worker' | 'cli' | 'provisioner' | 'migrate-apply' | 'migrate-check';
/** 'refuse-in-production': refuse when the process is production, warn otherwise. */
export type Verdict = 'refuse' | 'warn' | 'ignore' | 'refuse-in-production';

export interface CompatibilityPolicy {
  /** (a) migrations the ledger lacks. rab-migrate ignores it here: applying them is its job. */
  pending: Verdict;
  /** (b1) unknown ledger names, all newer than the code's newest migration. */
  ledgerAhead: Verdict;
  /** (b2) unknown ledger names not all newer, and not retired. */
  ledgerInterleaved: Verdict;
  /** (d1) provision function missing or carrying an unknown literal. */
  functionUnknown: Verdict;
  /** (d2) known (or pre-ledger) body below LATEST. */
  functionBehind: Verdict;
  /** (d3) known body above LATEST. */
  functionAhead: Verdict;
  /** (c1) a READY workspace below LATEST (fleet scan). */
  workspaceBehind: Verdict;
  /** (c2) a READY workspace above LATEST (fleet scan). */
  workspaceAhead: Verdict;
}

export const POLICIES: Readonly<Record<CompatibilityProcess, CompatibilityPolicy>> = Object.freeze({
  api: {
    pending: 'refuse',
    ledgerAhead: 'warn',
    ledgerInterleaved: 'refuse',
    functionUnknown: 'refuse-in-production',
    functionBehind: 'refuse',
    functionAhead: 'warn',
    workspaceBehind: 'ignore',
    workspaceAhead: 'ignore',
  },
  worker: {
    pending: 'refuse',
    ledgerAhead: 'warn',
    ledgerInterleaved: 'refuse',
    functionUnknown: 'refuse-in-production',
    functionBehind: 'refuse',
    functionAhead: 'warn',
    workspaceBehind: 'ignore',
    workspaceAhead: 'ignore',
  },
  // CLI: ledger only. Operator commands (bootstrap-admin, secret rotation) must stay usable on a rolled-back image.
  cli: {
    pending: 'refuse',
    ledgerAhead: 'warn',
    ledgerInterleaved: 'refuse',
    functionUnknown: 'ignore',
    functionBehind: 'ignore',
    functionAhead: 'ignore',
    workspaceBehind: 'ignore',
    workspaceAhead: 'ignore',
  },
  // The TypeScript provisioner builds schemas at ITS OWN LATEST: on a database at a newer level it would create a mixed
  // fleet its verifier cannot check, so every "ahead" refuses. Behind workspaces are the migrator's job, not a refusal.
  provisioner: {
    pending: 'refuse',
    ledgerAhead: 'refuse',
    ledgerInterleaved: 'refuse',
    functionUnknown: 'refuse',
    functionBehind: 'refuse',
    functionAhead: 'refuse',
    workspaceBehind: 'ignore',
    workspaceAhead: 'refuse',
  },
  // deploy-prepare without approval: reports; an older image must still be able to look at a newer ledger.
  'migrate-check': {
    pending: 'ignore',
    ledgerAhead: 'warn',
    ledgerInterleaved: 'refuse',
    functionUnknown: 'ignore',
    functionBehind: 'ignore',
    functionAhead: 'ignore',
    workspaceBehind: 'ignore',
    workspaceAhead: 'ignore',
  },
  // setup-db / deploy-prepare apply: an older migration set never applies against a newer ledger, and after the run
  // the function and every READY workspace must be exactly at LATEST.
  'migrate-apply': {
    pending: 'ignore',
    ledgerAhead: 'refuse',
    ledgerInterleaved: 'refuse',
    functionUnknown: 'refuse',
    functionBehind: 'refuse',
    functionAhead: 'refuse',
    workspaceBehind: 'refuse',
    workspaceAhead: 'refuse',
  },
});

export type CompatibilityFinding =
  | 'pending'
  | 'ledger-ahead'
  | 'ledger-interleaved'
  | 'provision-function-unknown'
  | 'provision-function-behind'
  | 'provision-function-ahead'
  | 'workspace-behind'
  | 'workspace-ahead';

export class SchemaCompatibilityError extends Error {
  constructor(
    /** The boot gate the refusal belongs to: 'pending-migrations' for (a) and an unreadable ledger, else 'schema-compatibility'. */
    readonly gate: 'pending-migrations' | 'schema-compatibility',
    readonly findings: readonly CompatibilityFinding[],
    message: string,
  ) {
    super(message);
    this.name = 'SchemaCompatibilityError';
  }
}

export interface WorkspaceModuleLevel {
  workspaceId: string;
  moduleVersion: number;
}

export interface SchemaCompatibilityFacts {
  /** The code's migration names (the DataSource's loaded set). */
  expected: readonly string[];
  /** `core.migrations` names. */
  applied: readonly string[];
  /** undefined: not checked by this caller. */
  provisionFunction?: ProvisionFunctionState;
  /** READY workspaces only. undefined: not checked by this caller. */
  workspaces?: readonly WorkspaceModuleLevel[];
  /**
   * C3: true only when Agent 1's classifier says CHAIN-PARTIAL and its physical fresh-install proof says NOT fresh (an
   * upgrade that stopped). Absent or false — EMPTY, BOOTSTRAP-PARTIAL, an interrupted first install, FOREIGN, unknown —
   * no C3 relaxation applies (API or Worker): a failed first install never serves and never starts the Worker.
   */
  upgradeEvidence?: boolean;
}

export interface AssessOptions {
  production: boolean;
  retired?: readonly string[];
  latestModuleVersion?: number;
  /**
   * C3 (owner decision 2026-11-05, "EXACTLY LIKE TWENTY"): the migration api-prestart reported as the failed upgrade step
   * (CREWFLOW_UPGRADE_INCOMPLETE). Honoured for the API only. See UPGRADE_INCOMPLETE_VAR.
   */
  upgradeIncomplete?: string;
}

/**
 * C3 (owner decision 2026-11-05, like Twenty): api-prestart sets CREWFLOW_UPGRADE_INCOMPLETE=<migration> on the API's
 * environment ONLY after the migrate child exits 70 with "policy":"continue" on a database that is NOT a first install, and
 * strips any inherited value otherwise. With it, and only for the API, and only when the FIRST pending migration is exactly
 * that named one, gate 7 downgrades two findings to warnings:
 *   - `pending` (the ledger is behind the code because that upgrade step failed);
 *   - `provision-function-behind` (the failed step may be the one that rewrites core.provision_workspace).
 * Everything else keeps its verdict: interleaved / unknown ledger names, an unknown provision function in production, a
 * ledger ahead for the provisioner, every CLI / provisioner verdict, and every case where the first pending migration is not
 * the named one. Unset: nothing changes for the API.
 *
 * The WORKER (owner decision changed 2026-11-05: "the Worker starts too, like Twenty") cannot see that variable (another
 * container): it decides from the database alone. When the pending set is a contiguous, in-order TAIL of this code's chain
 * (isInOrderPendingTail: no unknown / foreign / interleaved / ahead / retired name), `pending` and
 * `provision-function-behind` are loud warnings naming the first pending migration; anything else refuses as before.
 *
 * In both relaxed cases the semantic-posture golden comparison is skipped with a WARNING (the boot snapshot is still the
 * runtime baseline): database-boot-gates.ts reads `upgradeIncomplete` from the assessment.
 */
export const UPGRADE_INCOMPLETE_VAR = 'CREWFLOW_UPGRADE_INCOMPLETE';

/**
 * C3, Worker: the ledger is exactly a PREFIX of this code's chain and everything pending is the contiguous rest of it.
 * Every applied name is a code migration (no unknown / foreign / interleaved / ahead / retired name), and every pending
 * migration sorts after the last applied one in chain order (timestamp, then name). Anything else is not a failed upgrade
 * of this release and keeps its refusal.
 */
export function isInOrderPendingTail(
  expected: readonly string[],
  ledger: Pick<ReturnType<typeof compareLedger>, 'pending' | 'unknownNewer' | 'unknownInterleaved' | 'retiredPresent'>,
): boolean {
  if (ledger.pending.length === 0) return false;
  // An empty ledger (nothing of this chain applied) is a first install, never an upgrade tail.
  if (ledger.pending.length >= new Set(expected).size) return false;
  if (ledger.unknownNewer.length || ledger.unknownInterleaved.length || ledger.retiredPresent.length) return false;
  const chain = [...expected].sort(chainOrder);
  const pending = new Set(ledger.pending);
  const firstPendingIndex = chain.findIndex((name) => pending.has(name));
  return chain.slice(firstPendingIndex).every((name) => pending.has(name));
}

const chainOrder = (a: string, b: string) => (migrationTimestamp(a) ?? 0) - (migrationTimestamp(b) ?? 0) || a.localeCompare(b);

/** The first pending migration in chain order (timestamp, then name), or undefined. */
export function firstPendingMigration(pending: readonly string[]): string | undefined {
  return [...pending].sort((a, b) => (migrationTimestamp(a) ?? 0) - (migrationTimestamp(b) ?? 0) || a.localeCompare(b))[0];
}

export interface SchemaCompatibilityAssessment {
  process: CompatibilityProcess;
  pending: string[];
  unknownNewer: string[];
  unknownInterleaved: string[];
  /** Ledger names this code retired (ignored). */
  retiredPresent: string[];
  refusals: Array<{ finding: CompatibilityFinding; message: string }>;
  warnings: string[];
  /** C3: the named failed migration when the relaxation applied (API, first pending == named), else null. */
  upgradeIncomplete: string | null;
}

/** The 13-digit millisecond suffix of a migration name, or null (no suffix: counted as interleaved, fail closed). */
export function migrationTimestamp(name: string): number | null {
  const m = /(\d{13})$/.exec(name);
  return m ? Number(m[1]) : null;
}

const show = (names: readonly string[], n = 5) => names.slice(0, n).join(', ') + (names.length > n ? `, ... (+${names.length - n})` : '');

/** Ledger comparison only. Pure. */
export function compareLedger(expected: readonly string[], applied: readonly string[], retired: readonly string[] = RETIRED_MIGRATIONS) {
  const expectedSet = new Set(expected);
  const appliedSet = new Set(applied);
  const retiredSet = new Set(retired);
  const pending = expected.filter((name) => !appliedSet.has(name));
  const unknown = [...appliedSet].filter((name) => !expectedSet.has(name));
  const retiredPresent = unknown.filter((name) => retiredSet.has(name)).sort();
  const candidates = unknown.filter((name) => !retiredSet.has(name));
  const newestCode = Math.max(...expected.map((name) => migrationTimestamp(name) ?? -1), -1);
  const isNewer = (name: string) => {
    const ts = migrationTimestamp(name);
    return ts !== null && ts > newestCode;
  };
  const byTimestamp = (a: string, b: string) => (migrationTimestamp(a) ?? 0) - (migrationTimestamp(b) ?? 0) || a.localeCompare(b);
  // Every unknown name newer than the code's newest one = a pure rollback. Otherwise the whole unknown set is interleaved:
  // a newer name next to an interleaved one is not evidence of a rollback.
  if (candidates.every(isNewer)) return { pending, unknownNewer: candidates.sort(byTimestamp), unknownInterleaved: [] as string[], retiredPresent };
  return { pending, unknownNewer: [] as string[], unknownInterleaved: candidates.sort(byTimestamp), retiredPresent };
}

/** The whole decision. Pure: facts in, refusals and warnings out. */
export function assessSchemaCompatibility(process: CompatibilityProcess, facts: SchemaCompatibilityFacts, options: AssessOptions): SchemaCompatibilityAssessment {
  const policy = POLICIES[process];
  const latest = options.latestModuleVersion ?? LATEST_WORKSPACE_MODULE_VERSION;
  const ledger = compareLedger(facts.expected, facts.applied, options.retired ?? RETIRED_MIGRATIONS);
  // C3, API: only when the first pending migration is exactly the one api-prestart named as the failed step.
  const named = options.upgradeIncomplete?.trim();
  const apiRelaxed = process === 'api' && !!named && facts.upgradeEvidence === true && isInOrderPendingTail(facts.expected, ledger) && firstPendingMigration(ledger.pending) === named;
  // C3, Worker ("the Worker starts too, like Twenty", owner 2026-11-05): decided from the database alone (it cannot see the
  // API's CREWFLOW_UPGRADE_INCOMPLETE). Only a contiguous, in-order pending TAIL of this code's chain qualifies.
  // A first install (no upgrade evidence) never qualifies: the Worker does not start on a failed first install.
  const workerRelaxed = process === 'worker' && facts.upgradeEvidence === true && isInOrderPendingTail(facts.expected, ledger);
  const relaxed = apiRelaxed || workerRelaxed;
  const first = firstPendingMigration(ledger.pending);
  const result: SchemaCompatibilityAssessment = {
    process,
    ...ledger,
    refusals: [],
    warnings: [],
    upgradeIncomplete: apiRelaxed ? named! : workerRelaxed ? first! : null,
  };
  const c3 = (verdict: Verdict): Verdict => (relaxed && verdict !== 'ignore' ? 'warn' : verdict);
  const pendingMessage = apiRelaxed
    ? `UPGRADE INCOMPLETE (owner decision C3, 2026-11-05): the upgrade failed at ${named}; ${ledger.pending.length} migration(s) are not applied: ${show(ledger.pending)}. Serving on the previous schema; deploy the fix.`
    : workerRelaxed
      ? `UPGRADE INCOMPLETE (owner decision C3, 2026-11-05): running on a partly-upgraded schema: ${first} and ${ledger.pending.length - 1} more not applied. Every job runs on it, payroll timers included; deploy the fix.`
      : `${ledger.pending.length} migration(s) are not applied: ${show(ledger.pending)}.`;

  const apply = (verdict: Verdict, finding: CompatibilityFinding, message: string) => {
    if (verdict === 'ignore') return;
    if (verdict === 'refuse' || (verdict === 'refuse-in-production' && options.production)) result.refusals.push({ finding, message });
    else result.warnings.push(message);
  };

  if (ledger.pending.length > 0) {
    apply(c3(policy.pending), 'pending', pendingMessage);
  }
  if (ledger.unknownInterleaved.length > 0) {
    apply(
      policy.ledgerInterleaved,
      'ledger-interleaved',
      `the migration ledger holds ${ledger.unknownInterleaved.length} migration(s) this code does not know and that are not newer than its ` +
        `newest migration: ${show(ledger.unknownInterleaved)}. This is another branch's migration chain or the wrong database, not an image rollback.`,
    );
  }
  if (ledger.unknownNewer.length > 0) {
    apply(
      policy.ledgerAhead,
      'ledger-ahead',
      `the migration ledger is AHEAD of this code by ${ledger.unknownNewer.length} migration(s): ${show(ledger.unknownNewer)}. ` +
        'An older image is running on a newer schema (expand-only releases keep this safe for serving).',
    );
  }

  const fn = facts.provisionFunction;
  if (fn) {
    const described = describeProvisionFunctionState(fn);
    if (fn.state === 'missing' || fn.state === 'unknown') {
      apply(policy.functionUnknown, 'provision-function-unknown', `${described}; this code cannot tell which workspace modules it provisions.`);
    } else if (fn.state === 'legacy' || fn.moduleVersion < latest) {
      apply(c3(policy.functionBehind), 'provision-function-behind', `${described}, below this code's workspace module ${latest}.${relaxed ? ` UPGRADE INCOMPLETE (C3): first not applied ${result.upgradeIncomplete}.` : ''}`);
    } else if (fn.moduleVersion > latest) {
      apply(policy.functionAhead, 'provision-function-ahead', `${described}, above this code's workspace module ${latest} (an image rollback).`);
    }
  }

  if (facts.workspaces) {
    const behind = facts.workspaces.filter((w) => w.moduleVersion < latest);
    const ahead = facts.workspaces.filter((w) => w.moduleVersion > latest);
    const list = (ws: readonly WorkspaceModuleLevel[]) => show(ws.map((w) => `${w.workspaceId}@${w.moduleVersion}`));
    if (behind.length) apply(policy.workspaceBehind, 'workspace-behind', `${behind.length} READY workspace(s) are below module ${latest}: ${list(behind)}.`);
    if (ahead.length) apply(policy.workspaceAhead, 'workspace-ahead', `${ahead.length} READY workspace(s) are above this code's module ${latest}: ${list(ahead)}.`);
  }
  return result;
}

const ACTIONS: Record<CompatibilityFinding, string> = {
  pending:
    'The API never migrates on its own. Apply them through the approved migration step (the one-off rab-migrate service, ' +
    'deploy:prepare, with the per-release approval in its own environment), then start again.',
  'ledger-interleaved': 'Check that this process points at the right database and runs the right release; retired migrations belong in RETIRED_MIGRATIONS.',
  'ledger-ahead': 'Deploy the release that matches the database (this process type does not run on a newer schema).',
  'provision-function-unknown': 'Treat it as posture drift: compare the function with the release that last migrated this database.',
  'provision-function-behind': 'Re-apply the release migrations (rab-migrate) so the provisioning function matches the code.',
  'provision-function-ahead': 'Deploy the release that matches the database.',
  'workspace-behind': 'Run the workspace schema migrator (migrate-workspace-schemas) for the listed workspaces.',
  'workspace-ahead': 'Deploy the release that matches the database.',
};

/** Throws SchemaCompatibilityError naming every refusal; returns the warnings otherwise. */
export function assertSchemaCompatible(assessment: SchemaCompatibilityAssessment, label: string): string[] {
  if (assessment.refusals.length === 0) return assessment.warnings;
  const findings = assessment.refusals.map((r) => r.finding);
  const gate = findings.includes('pending') ? 'pending-migrations' : 'schema-compatibility';
  const actions = [...new Set(findings.map((f) => ACTIONS[f]))].join(' ');
  throw new SchemaCompatibilityError(gate, findings, `Refusing to start the ${label}: ${assessment.refusals.map((r) => r.message).join(' ')} ${actions}`);
}

// ------------------------------------------------------------------------------------------------ reads

export type CompatibilityQuery = (sql: string, params?: unknown[]) => Promise<unknown[]>;

/** `core.migrations` names. An unreadable ledger is a refusal (gate 'pending-migrations'), never a pass. */
export async function readLedgerNames(query: CompatibilityQuery, label: string): Promise<string[]> {
  try {
    const rows = (await query('SELECT name FROM core.migrations')) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } catch (error) {
    const code = (error as { code?: string })?.code ?? 'no-sqlstate';
    throw new SchemaCompatibilityError('pending-migrations', [], `Refusing to start the ${label}: the migration ledger could not be read (SQLSTATE ${code}).`);
  }
}

/**
 * READY workspaces and their module versions, enumerated with `core.worker_list_workspaces` (EXECUTE: crewflow, and the
 * migration identity through it); each registry row is read with that workspace's organisation bound (the registry is
 * FORCE RLS), one short transaction per workspace — the same access path as the drift detector. Never the runtime role.
 */
export async function readReadyWorkspaceModuleLevels(query: CompatibilityQuery, pageSize = 100): Promise<WorkspaceModuleLevel[]> {
  const out: WorkspaceModuleLevel[] = [];
  let after: string | null = null;
  for (;;) {
    const page = (await query('SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1, $2)', [after, pageSize])) as Array<{
      workspace_id: string;
      organisation_id: string;
    }>;
    for (const ws of page) {
      await query('BEGIN');
      try {
        await query(`SELECT pg_catalog.set_config('rab.organisation_id', $1, true)`, [ws.organisation_id]);
        const rows = (await query('SELECT status, module_version FROM core.workspace_schema_registry WHERE workspace_id = $1', [ws.workspace_id])) as Array<{
          status: string;
          module_version: number;
        }>;
        await query('COMMIT');
        if (rows[0]?.status === 'READY') out.push({ workspaceId: ws.workspace_id, moduleVersion: Number(rows[0].module_version) });
      } catch (error) {
        await query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    if (page.length < pageSize) break;
    after = page[page.length - 1]!.workspace_id;
  }
  return out;
}

export interface CheckSchemaCompatibilityOptions {
  process: CompatibilityProcess;
  production: boolean;
  /** The code's migration names. Empty → refused (the version cannot be checked). */
  expected: readonly string[];
  /** Refusal wording: "Refusing to start the <label>". */
  label: string;
  /** Read and assess core.provision_workspace(uuid)'s body (default: true unless the policy ignores every function finding). */
  provisionFunction?: boolean;
  /** Fleet scan of READY workspaces (crewflow / migration identity only). Default false. */
  workspaces?: boolean;
  /** Skip the ledger comparison (deploy post-checks: the runner already compared it). */
  ledger?: boolean;
  retired?: readonly string[];
  /** C3: see UPGRADE_INCOMPLETE_VAR (honoured for the API only). */
  upgradeIncomplete?: string;
  /**
   * C3: reads Agent 1's classification + physical fresh-install proof and answers "an upgrade stopped here" (CHAIN-PARTIAL and
   * not fresh). Called only when a relaxation could apply (the API with CREWFLOW_UPGRADE_INCOMPLETE, the Worker) and the
   * ledger is an in-order pending tail. Absent: no evidence, nothing is relaxed.
   */
  readUpgradeEvidence?: () => Promise<boolean>;
}

/** Reads what the policy needs on the caller's session, assesses, throws on refusal, returns the assessment (warnings). */
export async function checkSchemaCompatibility(query: CompatibilityQuery, options: CheckSchemaCompatibilityOptions): Promise<SchemaCompatibilityAssessment> {
  const policy = POLICIES[options.process];
  const checkLedger = options.ledger !== false;
  if (checkLedger && options.expected.length === 0) {
    throw new SchemaCompatibilityError('pending-migrations', [], `Refusing to start the ${options.label}: no migrations are loaded, so the schema version cannot be checked.`);
  }
  const expected = options.expected;
  const applied = checkLedger ? await readLedgerNames(query, options.label) : [...expected];
  // Pending migrations refuse before anything else is read: the function and the workspaces of a database behind the code
  // are expected to be behind too.
  let upgradeEvidence: boolean | undefined;
  const mayRelax = options.process === 'worker' || (options.process === 'api' && !!options.upgradeIncomplete?.trim());
  if (mayRelax && options.readUpgradeEvidence && isInOrderPendingTail(expected, compareLedger(expected, applied, options.retired ?? RETIRED_MIGRATIONS))) {
    upgradeEvidence = await options.readUpgradeEvidence();
  }
  const ledgerOnly = assessSchemaCompatibility(
    options.process,
    { expected, applied, upgradeEvidence },
    { production: options.production, retired: options.retired, upgradeIncomplete: options.upgradeIncomplete },
  );
  assertSchemaCompatible(ledgerOnly, options.label);

  const functionMatters = [policy.functionUnknown, policy.functionBehind, policy.functionAhead].some((v) => v !== 'ignore');
  const provisionFunction = (options.provisionFunction ?? functionMatters) ? await readProvisionFunctionState(query) : undefined;
  const workspaces = options.workspaces ? await readReadyWorkspaceModuleLevels(query) : undefined;
  const assessment = assessSchemaCompatibility(
    options.process,
    { expected, applied, provisionFunction, workspaces, upgradeEvidence },
    { production: options.production, retired: options.retired, upgradeIncomplete: options.upgradeIncomplete },
  );
  assertSchemaCompatible(assessment, options.label);
  return assessment;
}
