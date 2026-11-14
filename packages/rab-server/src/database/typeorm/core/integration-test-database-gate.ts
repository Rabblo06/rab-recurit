/**
 * DEAD-07 (cleanup audit 2026-11-02, C1; X3.5 PR B): the one gate an integration spec uses to decide whether it runs.
 *
 * Before this helper, about 280 specs decided with `Boolean(<legacy primary connection name>)` followed by
 * `RUN ? describe : describe.skip`, and a handful with the raw TEST_* names. Under Jest the skip branch was unreachable:
 * setupFiles (test-database-guard.ts, applyIntegrationTestDatabaseEnv) writes the legacy names from the validated TEST pair,
 * and globalSetup fails the whole run without that pair. So those gates were dead conditions. They were also a trap: the day
 * the routing stops writing the legacy name (X3.5-S6) or the deprecated admin name (X3.5-S8), every one of those suites
 * would SKIP SILENTLY instead of failing.
 *
 * This gate keys on what the routing itself checks, never on a connection variable a later change can stop writing:
 *   - NODE_ENV must be `test` (assertJestNodeEnv: under Jest setupFiles refuses anything else, so the routing ran);
 *   - the TEST_* pair must resolve and pass every rule of resolveIntegrationTestDatabase (same database, same endpoint,
 *     loopback unless ALLOW_REMOTE_TEST_DATABASE=true, never the development database, logins named in the URLs).
 * It never returns false: a missing or invalid pair throws TestDatabaseConfigError, so a suite fails loudly rather than
 * skipping. Opt-in suites keep their own extra conditions next to it, e.g.
 *   `const RUN = integrationTestDatabaseReady() && process.env.RUN_PERF_BASELINE === 'true';`
 * Pure apart from reading `env` (default process.env); opens no connection. Error messages never contain a URL.
 * integration-test-database-gate.spec.ts holds the abuse cases and the static scan that keeps every spec on this gate.
 */
import { assertJestNodeEnv, resolveIntegrationTestDatabase, ResolvedTestDatabase } from './test-database-guard';

/**
 * The validated TEST pair, for a suite whose opt-in depends on WHICH database or login it got (e.g. "only on the owner
 * login": `integrationTestDatabase().app.login === 'crewflow_owner'`). Same rules and same throw as the gate below; never
 * null, so an invalid pair cannot turn into a skip. `app.login` / `admin.login` are for comparisons only, never printing.
 */
export function integrationTestDatabase(env: Record<string, string | undefined> = process.env): ResolvedTestDatabase {
  assertJestNodeEnv(env);
  return resolveIntegrationTestDatabase(env);
}

export function integrationTestDatabaseReady(env: Record<string, string | undefined> = process.env): boolean {
  integrationTestDatabase(env);
  return true;
}
