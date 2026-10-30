/**
 * Phase B (P7) `deploy:prepare`: the platform-neutral release step the one-off `rab-migrate` process runs before the API and
 * the Worker are started (compose: they `depends_on: rab-migrate: service_completed_successfully`; any other platform: run
 * it as a release/pre-deploy job and promote only on exit 0). The API and the Worker never migrate.
 *
 *   PG_DATABASE_URL=<migration-only login> DB_TARGET=... [ALLOW_PRODUCTION_DB_COMMANDS=true]
 *   CREWFLOW_MIGRATION_APPROVED=pending-<n>-<sha256>          (this run may apply EXACTLY the pending set the check run
 *                                                             printed; final review F5, migrate/migration-approval.ts)
 *   [CREWFLOW_MIGRATION_PHASE=A|B]                            (historical first-build phases; see below)
 *   [CREWFLOW_DEPLOY_CACHE_FLUSH=entitycache  REDIS_URL=...]  (or --cache-flush=entitycache)
 *     node packages/rab-server/dist/database/typeorm/scripts/deploy-prepare.js
 *
 * Steps (migrate/locked-migration-runner.ts does 1-4 on one session):
 *   1. target guard + URL rules (PG_DATABASE_URL; production refuses the legacy names), before any migration session;
 *   2. migration advisory lock on the migration session (bounded wait, logged);
 *   3. after the lock: target again, N1 production approval, CF-41 identity, and two rules of this command: the identity must
 *      be a migration identity even when nothing is pending (a runtime credential is refused, not a silent no-op), and the
 *      CREWFLOW_MIGRATION_PHASE rule when set (A: the session must be rab_owner; B: never rab_app / rab_owner / crewflow /
 *      crewflow_app — the same rule the rab-migrate compose wrapper applies to the URL, applied here to the live session);
 *   4. approval gate (final review F5): without CREWFLOW_MIGRATION_APPROVED this is a check run and nothing is applied: exit
 *      0 when nothing is pending, exit 3 when something is (the release must not be promoted onto a schema behind its code),
 *      after printing every pending name and the approval token for exactly that set. With it, the token must equal the
 *      token of the set pending NOW, recomputed on the locked session (the set cannot change before the apply); a stale
 *      token, a token for another set, a malformed value or the retired constant `apply-pending-migrations` is refused
 *      (exit 1, nothing applied, the message prints the token to use);
 *   5. post-checks on the locked session (migrate/deploy-post-checks.ts): nothing pending, secure-owner invariants, RLS
 *      enabled on every core tenant table, the migration identity owns nothing;
 *   6. optional cache flush of the allow-listed `entitycache` namespace only (migrate/entity-cache-flush.ts), AFTER the
 *      migrations so the old API instances still serving cannot refill it with pre-migration rows;
 *   7. unlock, exit 0. Any failure exits 1 (3 for "pending but not approved").
 * Deliberately does NOT import dotenv: production authority comes only from the deployment environment.
 */
import { assertFlushableNamespace } from './migrate/entity-cache-flush';
import { deployPostCheckProblems } from './migrate/deploy-post-checks';
import { Query, redactConnectionStrings, runLockedMigrations } from './migrate/locked-migration-runner';
import {
  assertMigrationApproval,
  MIGRATION_APPROVAL_VAR,
  migrationApprovalToken,
  pendingInRunOrder,
  readMigrationApproval,
} from './migrate/migration-approval';
import { MigrationIdentityError, MigrationIdentityFacts } from '../core/migration-identity';
import { runCacheFlush } from './cache-flush';

export const EXIT_PENDING_NOT_APPROVED = 3;

const defaultLog = (message: string) => {
  // eslint-disable-next-line no-console
  console.log(`[deploy-prepare] ${message}`);
};

/** CREWFLOW_MIGRATION_PHASE, applied to the live session's role. Pure. */
export function assertMigrationPhase(phase: string | undefined, facts: MigrationIdentityFacts): void {
  if (phase === undefined || phase === '') return;
  if (phase === 'A') {
    if (facts.currentUser !== 'rab_owner') throw new MigrationIdentityError(`CREWFLOW_MIGRATION_PHASE=A must connect as rab_owner (got "${facts.currentUser}"). Refusing.`);
    return;
  }
  if (phase === 'B') {
    if (['rab_app', 'rab_owner', 'crewflow', 'crewflow_app'].includes(facts.currentUser)) {
      throw new MigrationIdentityError(`CREWFLOW_MIGRATION_PHASE=B needs the migration identity, not "${facts.currentUser}". Refusing.`);
    }
    return;
  }
  throw new MigrationIdentityError('CREWFLOW_MIGRATION_PHASE must be A or B when set. Refusing.');
}

export function cacheFlushRequest(argv: readonly string[], env: Record<string, string | undefined>): string | null {
  const arg = argv.find((a) => a.startsWith('--cache-flush='));
  const raw = arg ? arg.slice('--cache-flush='.length) : env.CREWFLOW_DEPLOY_CACHE_FLUSH?.trim();
  if (!raw) return null;
  return assertFlushableNamespace(raw);
}

/** Test seams of deployPrepare (production: the real locked runner and cache flush, process.env, console). */
export interface DeployPrepareDeps {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  log?: (message: string) => void;
  runner?: typeof runLockedMigrations;
  cacheFlush?: typeof runCacheFlush;
}

/** The whole command; resolves to the exit code (0, or 3 for "pending but not approved"); a refusal rejects (exit 1). */
export async function deployPrepare(deps: DeployPrepareDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? defaultLog;
  const runner = deps.runner ?? runLockedMigrations;
  const cacheFlush = deps.cacheFlush ?? runCacheFlush;
  // F5: any non-empty value is an apply run; whether it approves anything is decided after the lock (assertMigrationApproval).
  const approval = readMigrationApproval(env);
  const approved = approval !== null;
  const phase = env.CREWFLOW_MIGRATION_PHASE?.trim();
  // Same as the rab-migrate wrapper: phase A never receives the bootstrap passwords, so the run stops at the role split.
  if (phase === 'A') {
    delete env.CREWFLOW_BOOTSTRAP_PASSWORD;
    delete env.CREWFLOW_APP_BOOTSTRAP_PASSWORD;
  }
  // Validate the optional flush up front, so a misconfigured request fails before anything is applied.
  const flush = cacheFlushRequest(deps.argv ?? process.argv, env);
  if (flush && !env.REDIS_URL?.trim()) throw new Error(`cache flush "${flush}" requested but REDIS_URL is not set. Refusing before any migration.`);

  log(
    approved
      ? `apply run: ${MIGRATION_APPROVAL_VAR} is set; it must be the token of the set pending after the lock`
      : `check run (${MIGRATION_APPROVAL_VAR} not set): nothing will be applied`,
  );
  const result = await runner({
    label: 'deploy-prepare',
    env,
    log,
    mode: approved ? 'apply' : 'check',
    requireMigrationIdentity: true,
    extraIdentityCheck: (facts) => assertMigrationPhase(phase, facts),
    approvePending:
      approval === null
        ? undefined
        : (pending) => {
            assertMigrationApproval(approval, pending);
            if (pending.length === 0) {
              log(`WARNING: ${MIGRATION_APPROVAL_VAR} is set but nothing is pending, so it approved nothing. Remove it: the next release refuses it.`);
            }
          },
    afterMigrations: async ({ queryRunner, applied }) => {
      if (!approved) return;
      const query: Query = (sql, parameters) => queryRunner.query(sql, parameters) as Promise<unknown[]>;
      const problems = await deployPostCheckProblems(query);
      if (problems.length) throw new Error(`post-migration checks failed (${problems.length}): ${problems.slice(0, 20).join('; ')}`);
      log(`post-checks passed (${applied.length} applied, none pending)`);
      if (flush) await cacheFlush(flush, env);
    },
  });

  if (!approved) {
    if (result.pendingBefore.length > 0) {
      // F5: the set was read on the locked session; the approval token is for exactly this list, in this order.
      log(`${result.pendingBefore.length} migration(s) pending, in run order:`);
      for (const name of pendingInRunOrder(result.pendingBefore)) log(`  pending: ${name}`);
      log(`approval token for exactly this set: ${migrationApprovalToken(result.pendingBefore)}`);
      log(
        `REFUSED: ${result.pendingBefore.length} migration(s) are pending and this run is not approved. Nothing was applied. ` +
          `The release must not be promoted. After reviewing the list, run again with ${MIGRATION_APPROVAL_VAR}=<the token above> ` +
          `for that one run (it approves this set only).`,
      );
      return EXIT_PENDING_NOT_APPROVED;
    }
    log('schema is current; nothing to apply');
    if (flush) await cacheFlush(flush, env);
    return 0;
  }
  log(`done: ${result.applied.length === 0 ? 'none pending' : `applied ${result.applied.join(', ')}`}`);
  return 0;
}

if (require.main === module) {
  deployPrepare().then(
    (code) => process.exit(code),
    (error: unknown) => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
      // eslint-disable-next-line no-console
      console.error(`[deploy-prepare] FAILED: ${redactConnectionStrings(message)}`);
      process.exit(1);
    },
  );
}
