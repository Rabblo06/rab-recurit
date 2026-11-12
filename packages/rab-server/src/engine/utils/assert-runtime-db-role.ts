import { DataSource } from 'typeorm';

import { OWNER_LOGIN_ROLE, ownerLoginRolePostureProblems } from '../../database/boot-checks/owner-login-posture';

/**
 * Owner-login architecture (owner's final decision 2026-11-04, Option A, PERMANENT): the API, the Worker (either claim
 * mode), the CLI and the migration child all connect as the ONE schema-owning login `crewflow_owner` (M0 §5.1 shape).
 * Fixed, not environment-overridable: an env var naming the expected role would let a misconfigured deployment redefine
 * what "the runtime login" means.
 *
 * What changed (in place, no second validator; every difference is in the behaviour-change catalogue,
 * database/boot-checks/owner-login-behaviour-catalogue.ts, THREAT-MODEL.md PT-01):
 *  - before: the runtime login had to be `crewflow_app` (API, CLI) or `crewflow_worker` (global-mode Worker), owning
 *    nothing and a member of no owner role, so RLS bound every query it ran. Those are SCHEMA roles now; connecting as
 *    one of them is refused here;
 *  - now: the login is crewflow_owner itself (no SET ROLE), it is not SUPERUSER / BYPASSRLS / REPLICATION / CREATEDB,
 *    nothing dangerous is reachable from it (MEMBER-semantics walk) and the role layout is exactly the reviewed
 *    owner-login inventory — the SAME function the boot gate and tools/check-rls-coverage.ts run
 *    (database/boot-checks/owner-login-posture.ts). It IS a member of rab_secure_owner and crewflow, by design: RLS binds
 *    it on FORCE tables (every tenant table, and since M-T1 the 16 pre-auth tables) on normal code paths only. Injected
 *    SQL runs with the owners' privileges (owner-accepted, final prompt §2).
 */
const RUNTIME_DB_ROLE = OWNER_LOGIN_ROLE;
/** The Worker-only SCHEMA role. Never a login any more: a connection as it is refused. */
const WORKER_DB_ROLE = 'crewflow_worker';

/**
 * Which process the asserted connection serves. Kept so existing callers (storage reconciliation, the scan lock) compile
 * unchanged; it no longer changes the accepted login (the owner login for every identity).
 */
export type RuntimeDbIdentity = { process: 'api' } | { process: 'worker'; claimMode: 'per_scope' | 'global' };

export function acceptedRuntimeDbRoles(identity: RuntimeDbIdentity = { process: 'api' }): readonly string[] {
  if (identity.process === 'api') return [RUNTIME_DB_ROLE];
  if (identity.claimMode === 'global' || identity.claimMode === 'per_scope') return [RUNTIME_DB_ROLE];
  return []; // fail closed on an unknown claim mode
}

/** The Worker's own connection labels (code constants, exact match). */
export const WORKER_CONNECTION_LABELS: readonly string[] = Object.freeze(['worker', 'worker-direct', 'worker-scan-lock', 'worker-wake-listener']);

export function runtimeDbIdentityFor(processName: string, env: Record<string, string | undefined> = process.env): RuntimeDbIdentity {
  if (!WORKER_CONNECTION_LABELS.includes(processName)) return { process: 'api' };
  const raw = env.WORKER_CLAIM_MODE;
  const claimMode = raw === undefined || raw === '' ? 'per_scope' : raw;
  return { process: 'worker', claimMode: claimMode as 'per_scope' | 'global' };
}

/**
 * Asserts, before the process serves a request or runs a job, that its connection is the reviewed owner login. Shared by
 * the API (`main.ts`), the Worker (`packages/rab-worker/src/main.ts`), the prestart check and the CLI commands that open
 * their own connections.
 */
export async function assertRuntimeDbRole(dataSource: DataSource, processName: string, explicitIdentity?: RuntimeDbIdentity): Promise<void> {
  const identity = explicitIdentity ?? runtimeDbIdentityFor(processName);
  const accepted = acceptedRuntimeDbRoles(identity);
  const [{ current_user: connectedAs }] = await dataSource.query<[{ current_user: string }]>('SELECT current_user');
  if (connectedAs === WORKER_DB_ROLE) {
    throw new Error(
      `Refusing to start: the ${processName} connects as "${WORKER_DB_ROLE}", a schema role that holds the Worker-only dispatch-claim grants. ` +
        `Every process connects as ${accepted.map((r) => `"${r}"`).join(' or ') || '(no accepted role)'}.`,
    );
  }
  if (!accepted.includes(connectedAs)) {
    throw new Error(
      `Refusing to start: PG_DATABASE_URL connects as "${connectedAs}", not ${accepted.map((r) => `"${r}"`).join(' or ') || '(no accepted role)'}. ` +
        `The legacy logins crewflow_app / crewflow / crewflow_worker are schema roles now; point PG_DATABASE_URL at the owner login.`,
    );
  }
  const [{ rolbypassrls, rolsuper }] = await dataSource.query<[{ rolbypassrls: boolean; rolsuper: boolean }]>(
    'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
  );
  if (rolbypassrls || rolsuper) {
    throw new Error(`Refusing to start: runtime role "${connectedAs}" has BYPASSRLS/SUPERUSER — row-level security would not apply.`);
  }
  // CF-43: `current_user` alone can be the result of a privileged login running SET ROLE. The LOGIN identity must be the
  // runtime role itself.
  const [session] = await dataSource.query<[{ session_user: string; session_super: boolean; version: number }]>(RUNTIME_IDENTITY_SQL);
  if (session.session_user !== connectedAs || session.session_super) {
    throw new Error(`Refusing to start: the database login is "${session.session_user}", not "${connectedAs}" itself (SET ROLE is not accepted).`);
  }
  if (!(Number(session.version) >= 160000)) {
    throw new Error(`Refusing to start: PostgreSQL 16 or later is required (server_version_num ${session.version}).`);
  }
  // Reachability (MEMBER semantics) and the exact role inventory: the boot gate's own function, not a copy.
  const problems = await ownerLoginRolePostureProblems((sql, params) => dataSource.query(sql, params));
  if (problems.length) {
    throw new Error(`Refusing to start: the role posture is not the reviewed owner-login layout: ${problems.join('; ')}.`);
  }
}

/** Exported for its unit test. */
export const RUNTIME_IDENTITY_SQL = `SELECT session_user AS session_user,
            (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = session_user) AS session_super,
            pg_catalog.current_setting('server_version_num')::int AS version`;
