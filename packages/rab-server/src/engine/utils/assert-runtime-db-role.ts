import { DataSource } from 'typeorm';

// Fixed, not environment-overridable: an env var naming the expected role would let a misconfigured deployment redefine what
// "the restricted runtime role" means and pass this check while actually connected as the owner.
// P2/P3 Checkpoint 2 (restricted runtime role): the ordinary application login is `crewflow_app` —
// it owns NOTHING (NOLOGIN was considered and rejected; it must be able to log in to actually serve
// requests). It holds only plain DML (SELECT/INSERT/UPDATE/DELETE, replicated from `crewflow`'s own
// grants, deliberately excluding TRIGGER/REFERENCES/TRUNCATE — see
// `CrewflowAppRestrictedRuntimeRole1786687000000`) plus EXECUTE on the same SECURITY DEFINER
// functions `crewflow` itself can call. Because it owns no table, it structurally cannot
// ALTER/DROP/DISABLE ROW LEVEL SECURITY/CREATE SCHEMA — those require ownership or superuser,
// never a GRANT, in Postgres. `crewflow` (the former sole runtime identity, now demoted to
// migration/bootstrap authority) remains the owner of the 36 ordinary business tables and of
// `provision_workspace_schema`'s one remaining privileged caller path; `crewflow_app` is deliberately
// never granted EXECUTE on `provision_workspace_schema` — only the worker's dedicated, non-pooled
// provisioning connection (authenticated as `crewflow`) may run it. The pre-auth-sensitive NOT_FORCE
// tables (`core.user_session`, `user`, `refresh_token`, ... — see `tools/check-rls-coverage.ts`'s
// `NOT_FORCED_ALLOWLIST`) and their SECURITY DEFINER lookup functions are owned by the separate,
// NOLOGIN `rab_secure_owner`, which neither `crewflow` nor `crewflow_app` is ever a member of or can
// SET ROLE into. `rab_app`/`rab_owner` are retired (NOLOGIN, zero remaining grants).
const RUNTIME_DB_ROLE = 'crewflow_app';
/**
 * Phase D (D2): the Worker-only login (member of crewflow_app WITH INHERIT TRUE, SET FALSE; the only holder of the
 * dispatch-claim grants). Accepted only for the Worker identity below; the API and every other caller refuse it.
 */
const WORKER_DB_ROLE = 'crewflow_worker';

/**
 * Which process the asserted connection serves. Default `{ process: 'api' }` = exactly crewflow_app (every pre-Phase-D
 * caller). A Worker connection passes its WORKER_CLAIM_MODE: per_scope accepts crewflow_app or crewflow_worker (old
 * runtime mode keeps working), global accepts crewflow_worker only. The accepted roles are these code constants, never env.
 */
export type RuntimeDbIdentity = { process: 'api' } | { process: 'worker'; claimMode: 'per_scope' | 'global' };

export function acceptedRuntimeDbRoles(identity: RuntimeDbIdentity = { process: 'api' }): readonly string[] {
  if (identity.process === 'api') return [RUNTIME_DB_ROLE];
  if (identity.claimMode === 'global') return [WORKER_DB_ROLE];
  if (identity.claimMode === 'per_scope') return [RUNTIME_DB_ROLE, WORKER_DB_ROLE];
  return []; // fail closed on anything else
}

/**
 * The Worker's own connection labels (code constants, exact match): the jobs child's runtime pool, its direct/lock pool,
 * the BullMQ scan-lock session and the event-mode wake listener. A call with one of these labels and no explicit identity
 * is asserted as the Worker, with WORKER_CLAIM_MODE read from the process environment (unset/empty = per_scope; any
 * other value than per_scope/global accepts NO role — fail closed). Every other label (the API, CLI commands, prestart
 * checks, e2e boots) stays crewflow_app only.
 */
export const WORKER_CONNECTION_LABELS: readonly string[] = Object.freeze(['worker', 'worker-direct', 'worker-scan-lock', 'worker-wake-listener']);

export function runtimeDbIdentityFor(processName: string, env: Record<string, string | undefined> = process.env): RuntimeDbIdentity {
  if (!WORKER_CONNECTION_LABELS.includes(processName)) return { process: 'api' };
  const raw = env.WORKER_CLAIM_MODE;
  const claimMode = raw === undefined || raw === '' ? 'per_scope' : raw;
  return { process: 'worker', claimMode: claimMode as 'per_scope' | 'global' };
}

/**
 * A cryptographically valid request/job can still be served against the wrong
 * database role — RLS's non-FORCE'd tables (see `NOT_FORCED_ALLOWLIST` /
 * `PRE_AUTH_EXEMPT_TABLES` in tools/check-rls-coverage.ts, the authoritative
 * list) are fully unscoped for a table-owner connection regardless of tenant
 * context. This mirrors that CI check at boot, catching a misconfigured
 * DATABASE_URL (e.g. accidentally pointed at the migration/owner role) before
 * the process ever serves a request or runs a job, rather than discovering it
 * via a cross-tenant data leak.
 *
 * Shared by the API (`main.ts`) and the worker (`packages/rab-worker/src/main.ts`): the
 * worker's tenant-scoped work runs through the same DataSource, so it needs
 * exactly the same guarantee. (The worker ALSO holds a deliberate, separate
 * owner connection for read-only cross-tenant discovery — that one is never
 * this DataSource.)
 */
export async function assertRuntimeDbRole(dataSource: DataSource, processName: string, explicitIdentity?: RuntimeDbIdentity): Promise<void> {
  const identity = explicitIdentity ?? runtimeDbIdentityFor(processName);
  const accepted = acceptedRuntimeDbRoles(identity);
  const [{ current_user: connectedAs }] = await dataSource.query<[{ current_user: string }]>('SELECT current_user');
  if (connectedAs === WORKER_DB_ROLE && !accepted.includes(WORKER_DB_ROLE)) {
    throw new Error(
      `Refusing to start: the ${processName} connects as "${WORKER_DB_ROLE}", the Worker-only login that holds the dispatch-claim grants. ` +
        `It must connect as ${accepted.join(' or ') || '(no accepted role)'} — never with the Worker's credential.`,
    );
  }
  if (!accepted.includes(connectedAs)) {
    throw new Error(
      `Refusing to start: DATABASE_URL connects as "${connectedAs}", not ${accepted.map((r) => `"${r}"`).join(' or ') || '(no accepted role)'}. ` +
        (identity.process === 'worker' && identity.claimMode === 'global' && connectedAs === RUNTIME_DB_ROLE
          ? `WORKER_CLAIM_MODE=global requires the ${processName} to connect as "${WORKER_DB_ROLE}".`
          : `The ${processName} must never run tenant-scoped work as the migration/owner role — see postgres-init/01-roles.sql.`),
    );
  }
  const [{ rolbypassrls, rolsuper }] = await dataSource.query<[{ rolbypassrls: boolean; rolsuper: boolean }]>(
    'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
  );
  if (rolbypassrls || rolsuper) {
    throw new Error(`Refusing to start: runtime role "${connectedAs}" has BYPASSRLS/SUPERUSER — row-level security would not apply.`);
  }
  // CF-43: `current_user` alone can be the result of a privileged login running SET ROLE. The LOGIN identity must be the
  // runtime role itself, and that role must not be able to act as any table-owning or privileged role.
  // Phase D: membership is tested with MEMBER (PG16: any membership, whatever its INHERIT/SET options), not USAGE — USAGE
  // missed an INHERIT FALSE, SET TRUE grant, through which the login could still SET ROLE to an owner role. Both the
  // acting role and the login are checked (same rule as the boot gate's BOOT_FACTS_SQL).
  const [session] = await dataSource.query<[{ session_user: string; session_super: boolean; owner_roles: string | null; worker_member: boolean | null }]>(
    RUNTIME_IDENTITY_SQL,
  );
  if (session.session_user !== connectedAs || session.session_super) {
    throw new Error(`Refusing to start: the database login is "${session.session_user}", not "${connectedAs}" itself (SET ROLE is not accepted).`);
  }
  if (session.owner_roles) {
    throw new Error(`Refusing to start: runtime role "${connectedAs}" can act as ${session.owner_roles}, which own tables and would bypass row-level security.`);
  }
  if (session.worker_member === true && !accepted.includes(WORKER_DB_ROLE)) {
    throw new Error(`Refusing to start: runtime role "${connectedAs}" is a member of ${WORKER_DB_ROLE} and would inherit the Worker-only dispatch-claim grants.`);
  }
}

/** Exported for its unit test. */
export const RUNTIME_IDENTITY_SQL = `SELECT session_user AS session_user,
            (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = session_user) AS session_super,
            (SELECT string_agg(r.rolname, ',') FROM pg_roles r
              WHERE r.rolname <> current_user AND r.rolname IN ('crewflow', 'rab_secure_owner', 'rab_owner')
                AND (pg_has_role(current_user, r.oid, 'MEMBER') OR pg_has_role(session_user, r.oid, 'MEMBER'))) AS owner_roles,
            (SELECT pg_has_role(current_user, w.oid, 'MEMBER') OR pg_has_role(session_user, w.oid, 'MEMBER')
               FROM pg_roles w WHERE w.rolname = 'crewflow_worker') AS worker_member`;
