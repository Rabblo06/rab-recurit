import { EntityManager } from 'typeorm';

import { OWNER_LOGIN_ROLE } from '../../database/boot-checks/owner-login-posture';
import { RESET_ROLE_SQL } from '../../database/postgres/session-role-reset';

/**
 * O-2: how a one-off operator command reads or writes the rab_secure_owner-owned pre-auth tables (core."user",
 * core.organisation, core.platform_admin, core.manager_workspace, ...) when no tenant context can exist yet.
 *
 * Since M-T1 (PreAuthTablesForceOwnerOnly1786721400000, ../../database/typeorm/core/preauth-force-sql.ts) those tables are
 * FORCE ROW LEVEL SECURITY with an owner-only definer policy (CURRENT_USER = 'rab_secure_owner'). The CLI login
 * crewflow_owner merely INHERITS rab_secure_owner, so acting as itself it gets the ordinary tenant policies: zero rows
 * without a tenant context, and core.platform_admin's write policy demands an acting platform admin. preauth-force-sql.ts
 * states the consequence for operator scripts: `SET LOCAL ROLE rab_secure_owner` (or a definer), otherwise zero rows.
 *
 * This is that step and nothing more. No grant is added: crewflow_owner already holds rab_secure_owner WITH SET (the
 * owner-login bootstrap), exactly as the three ops commands use it (elevated-ops-session.ts). It NARROWS the session to the
 * table owner for the rest of the CURRENT transaction only:
 *   - before: the session is the owner login acting as itself, not SUPERUSER/BYPASSRLS, and may SET the role;
 *   - `SET LOCAL ROLE rab_secure_owner` (a frozen literal);
 *   - after: current_user is rab_secure_owner.
 * Any mismatch throws before a data statement runs. `SET LOCAL` ends with the transaction, the pool's RESET ROLE on checkout
 * (session-role-reset.ts) runs before every later transaction, and stopActingAsSecureOwner() ends it early when the same
 * transaction continues with ordinary tenant-scoped work (audit, sessions) as the login itself.
 *
 * Only callers that run outside any request path may use this: the CLI commands, which main.ts gates to the owner login.
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

interface Facts {
  login: string;
  acting: string;
  exempt: boolean;
  can_set: boolean;
}

/** Narrows the current transaction of `manager` to rab_secure_owner. `manager` must be inside a transaction. */
export async function actAsSecureOwner(manager: EntityManager): Promise<void> {
  if (!manager.queryRunner?.isTransactionActive) throw new SecureOwnerActingError('acting as rab_secure_owner needs an open transaction (SET LOCAL). Nothing was run.');
  const [f] = (await manager.query(FACTS_SQL)) as Facts[];
  if (!f) throw new SecureOwnerActingError('cannot read the connecting identity. Nothing was run.');
  if (f.login !== OWNER_LOGIN_ROLE) throw new SecureOwnerActingError(`the login is "${f.login}", not the owner login ${OWNER_LOGIN_ROLE}. Nothing was run.`);
  if (f.acting !== f.login) throw new SecureOwnerActingError(`the session already acts as "${f.acting}", not as its login. Nothing was run.`);
  if (f.exempt) throw new SecureOwnerActingError(`the login ${f.login} is SUPERUSER or BYPASSRLS. Nothing was run.`);
  if (!f.can_set) throw new SecureOwnerActingError(`the login ${f.login} may not SET ROLE ${SECURE_OWNER_ROLE}. Nothing was run.`);
  await manager.query(SET_LOCAL_ROLE_SECURE_OWNER_SQL);
  const [after] = (await manager.query(`SELECT current_user::text AS acting`)) as Array<{ acting: string }>;
  if (after?.acting !== SECURE_OWNER_ROLE) throw new SecureOwnerActingError(`SET LOCAL ROLE ${SECURE_OWNER_ROLE} did not take effect. Nothing was run.`);
}

/** Ends acting as rab_secure_owner inside the same transaction: the session acts as its login again (checked). */
export async function stopActingAsSecureOwner(manager: EntityManager): Promise<void> {
  await manager.query(RESET_ROLE_SQL);
  const [row] = (await manager.query(`SELECT current_user::text AS acting, session_user::text AS login`)) as Array<{ acting: string; login: string }>;
  if (!row || row.acting !== row.login) throw new SecureOwnerActingError('RESET ROLE did not return the session to its login.');
}

/** Runs `fn` in its own transaction acting as rab_secure_owner (READ ONLY when `readOnly`). */
export async function inSecureOwnerTransaction<T>(
  manager: EntityManager,
  options: { readOnly: boolean },
  fn: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return manager.transaction(async (m) => {
    if (options.readOnly) await m.query('SET TRANSACTION READ ONLY');
    await actAsSecureOwner(m);
    return fn(m);
  });
}
