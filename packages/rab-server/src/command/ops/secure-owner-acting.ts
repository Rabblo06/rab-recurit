import { DataSource, EntityManager } from 'typeorm';

import { OWNER_LOGIN_ROLE } from '../../database/boot-checks/owner-login-posture';
import { currentPgProcessRole } from '../../database/postgres/pg-config';
import { RESET_ROLE_SQL } from '../../database/postgres/session-role-reset';

/**
 * O-2: how a one-off operator command reads or writes the rab_secure_owner-owned pre-auth tables (core."user",
 * core.organisation, core.platform_admin, core.manager_workspace, ...) when no tenant context can exist yet.
 *
 * Since M-T1 (PreAuthTablesForceOwnerOnly1786721400000, ../../database/typeorm/core/preauth-force-sql.ts) those tables are
 * FORCE ROW LEVEL SECURITY with an owner-only definer policy (CURRENT_USER = 'rab_secure_owner'). The owner login
 * crewflow_owner merely INHERITS rab_secure_owner, so acting as itself it gets the ordinary tenant policies: zero rows
 * without a tenant context, and core.platform_admin's write policy demands an acting platform admin. preauth-force-sql.ts
 * states the consequence for operator scripts: `SET LOCAL ROLE rab_secure_owner` (or a definer), otherwise zero rows.
 *
 * This is that step and nothing more. No grant is added: crewflow_owner already holds rab_secure_owner WITH SET (the
 * owner-login bootstrap), exactly as the three ops commands use it (elevated-ops-session.ts). It NARROWS the session to the
 * table owner for the duration of `fn` inside the CURRENT transaction only:
 *   - before: the process declared itself the CLI (currentPgProcessRole() === 'cli'), the transaction is open, the session
 *     is the owner login acting as itself, not SUPERUSER/BYPASSRLS, and may SET the role;
 *   - `SET LOCAL ROLE rab_secure_owner` (a frozen literal); after: current_user is rab_secure_owner (and, when asked, the
 *     transaction is READ ONLY);
 *   - after `fn` resolves: `RESET ROLE`, checked (current_user = session_user), so the rest of the transaction runs as the
 *     login. Not in a `finally`: when `fn` fails the transaction is aborted (any statement would raise 25P02) and its
 *     rollback undoes the SET LOCAL anyway.
 * Any mismatch throws before a data statement runs.
 *
 * THE BARRIER. The API and the Worker connect with the SAME login (crewflow_owner), so the login is not what keeps this
 * off a request path. Two things are: (1) the process-role check above — only command/main.ts declares `cli`
 * (command/ops/declare-cli-process.ts), the API and Worker never do; (2) a static test (secure-owner-acting.spec.ts) that
 * fails when anything outside src/command/** imports this file. Neither stops injected SQL (G-02, as before).
 */
export class SecureOwnerActingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecureOwnerActingError';
  }
}

export const SECURE_OWNER_ROLE = 'rab_secure_owner';

const SET_LOCAL_ROLE_SECURE_OWNER_SQL = 'SET LOCAL ROLE rab_secure_owner';

const FACTS_SQL = `
SELECT session_user::text AS login,
       current_user::text AS acting,
       (r.rolsuper OR r.rolbypassrls) AS exempt,
       pg_catalog.pg_has_role(session_user, 'rab_secure_owner', 'SET') AS can_set
  FROM pg_catalog.pg_roles r
 WHERE r.rolname = session_user`;

const AFTER_SQL = `SELECT current_user::text AS acting, pg_catalog.current_setting('transaction_read_only') AS read_only`;

interface Facts {
  login: string;
  acting: string;
  exempt: boolean;
  can_set: boolean;
}

function refuse(why: string): never {
  throw new SecureOwnerActingError(`refusing to act as ${SECURE_OWNER_ROLE}: ${why}. Nothing was run.`);
}

async function actAsSecureOwner(manager: EntityManager, expectReadOnly: boolean): Promise<void> {
  if (currentPgProcessRole() !== 'cli') refuse(`this process is "${currentPgProcessRole()}", not the CLI`);
  if (!manager.queryRunner?.isTransactionActive) refuse('no open transaction (SET LOCAL needs one)');
  const [f] = (await manager.query(FACTS_SQL)) as Facts[];
  if (!f) return refuse('cannot read the connecting identity');
  if (f.login !== OWNER_LOGIN_ROLE) refuse(`the login is "${f.login}", not the owner login ${OWNER_LOGIN_ROLE}`);
  if (f.acting !== f.login) refuse(`the session already acts as "${f.acting}", not as its login`);
  if (f.exempt) refuse(`the login ${f.login} is SUPERUSER or BYPASSRLS`);
  if (!f.can_set) refuse(`the login ${f.login} may not SET ROLE ${SECURE_OWNER_ROLE}`);
  await manager.query(SET_LOCAL_ROLE_SECURE_OWNER_SQL);
  const [after] = (await manager.query(AFTER_SQL)) as Array<{ acting: string; read_only: string }>;
  if (after?.acting !== SECURE_OWNER_ROLE) refuse(`SET LOCAL ROLE ${SECURE_OWNER_ROLE} did not take effect`);
  if (expectReadOnly && after.read_only !== 'on') refuse('the transaction is not READ ONLY');
}

async function stopActingAsSecureOwner(manager: EntityManager): Promise<void> {
  await manager.query(RESET_ROLE_SQL);
  const [row] = (await manager.query(`SELECT current_user::text AS acting, session_user::text AS login`)) as Array<{ acting: string; login: string }>;
  if (!row || row.acting !== row.login) throw new SecureOwnerActingError('RESET ROLE did not return the session to its login.');
}

/**
 * Runs `fn` acting as rab_secure_owner inside the caller's OPEN transaction on `manager`, then returns the session to its
 * login (checked) before the caller's transaction continues.
 */
export async function withSecureOwner<T>(
  manager: EntityManager,
  fn: (manager: EntityManager) => Promise<T>,
  options: { expectReadOnly?: boolean } = {},
): Promise<T> {
  await actAsSecureOwner(manager, options.expectReadOnly === true);
  const result = await fn(manager);
  await stopActingAsSecureOwner(manager);
  return result;
}

/** Runs `fn` in a NEW transaction on `dataSource` acting as rab_secure_owner; READ ONLY (and asserted) when `readOnly`. */
export async function inSecureOwnerTransaction<T>(
  dataSource: DataSource,
  options: { readOnly: boolean },
  fn: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return dataSource.transaction(async (manager) => {
    if (options.readOnly) await manager.query('SET TRANSACTION READ ONLY');
    return withSecureOwner(manager, fn, { expectReadOnly: options.readOnly });
  });
}
