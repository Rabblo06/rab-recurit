/**
 * Owner-login architecture (owner decision 2026-11-04, PR 3 "fresh-install and migration lifecycle"): the fresh-install bootstrap that `crewflow_owner` runs itself, in ONE transaction, on the
 * locked migration session, before phase A. The SQL is M0 §5.2 (VERIFIED: the exact prep of M0 Agent A's replay B), made
 * idempotent and defensive:
 *
 *   - every role is created only when absent; a role that already exists must have EXACTLY the shape this bootstrap would
 *     have given it (attributes, LOGIN, memberships in both directions, crewflow_owner's INHERIT/SET grant). Anything else
 *     is refused (BootstrapRefusal), never altered: a pre-existing SUPERUSER / BYPASSRLS / REPLICATION / CREATEROLE /
 *     CREATEDB role, a NOLOGIN that should be LOGIN or the reverse, an extra member or an extra membership.
 *   - roles are CLUSTER-wide while the migration lock is per DATABASE, so two installs of two databases on one cluster can
 *     race on CREATE ROLE. A 42710 (duplicate_object) or 23505 (unique_violation on pg_authid) rolls the whole bootstrap
 *     transaction back; the caller's loop re-runs it (bounded), and the next attempt finds the role and verifies its shape.
 *   - `crewflow_worker` is created by a throwaway NOLOGIN CREATEROLE `crewflow_rolemaker` (SET only), then the rolemaker is
 *     dropped, so `crewflow_worker` ends with ZERO members (M0 B3: the implicit ADMIN row of a non-superuser creator would
 *     otherwise make crewflow_owner a member, and WorkerDispatchPointer1786721300000 requires none).
 *   - `crewflow` and `crewflow_app` are LOGIN without a password here (golden posture); the chain's role migrations set
 *     random, discarded passwords (owner-login-chain.ts phase B).
 *   - extensions must end in schema `public` (the code hard-codes public.citext etc.); one that already exists elsewhere is
 *     refused (M0-E: the boot gate checks existence, not schema).
 *   - the `core` schema is created AUTHORIZATION rab_owner; an existing `core` owned by anyone else is refused.
 *
 * Nothing here prints a password, a URL or a user name other than the fixed Crewflow role names.
 */
import type { Query } from '../locked-migration-runner';

export const OWNER_LOGIN = 'crewflow_owner';
export const ROLEMAKER = 'crewflow_rolemaker';

/** The five extensions the chain uses, all in `public` (M0 §5.2 order). */
export const BOOTSTRAP_EXTENSIONS = ['pgcrypto', 'citext', 'btree_gist', 'unaccent', 'pg_trgm'] as const;

export class BootstrapRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapRefusal';
  }
}

export interface RoleSpec {
  name: string;
  login: boolean;
  /** crewflow_owner's membership: INHERIT TRUE, SET TRUE for the owner roles; ADMIN only for crewflow_app; none for the worker. */
  ownerMember: 'inherit-set' | 'admin-only' | 'none';
  /** The roles this role is itself a member of (exactly). */
  memberOf: ReadonlyArray<{ role: string; inherit: boolean; set: boolean }>;
}

/** M0 §5.2, in creation order. */
export const BOOTSTRAP_ROLES: readonly RoleSpec[] = [
  { name: 'rab_owner', login: false, ownerMember: 'inherit-set', memberOf: [] },
  { name: 'rab_app', login: false, ownerMember: 'inherit-set', memberOf: [] },
  { name: 'rab_secure_owner', login: false, ownerMember: 'inherit-set', memberOf: [] },
  { name: 'crewflow', login: true, ownerMember: 'inherit-set', memberOf: [] },
  // crewflow_owner created it, so PostgreSQL 16+ records an implicit ADMIN-only row; no INHERIT / SET (M0 §3.1).
  { name: 'crewflow_app', login: true, ownerMember: 'admin-only', memberOf: [] },
  // Created by the rolemaker: no member at all, a member of exactly crewflow_app WITH INHERIT TRUE, SET FALSE.
  { name: 'crewflow_worker', login: true, ownerMember: 'none', memberOf: [{ role: 'crewflow_app', inherit: true, set: false }] },
];

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export const ROLE_FACTS_SQL = `
SELECT r.rolname::text AS "name", r.rolsuper AS "super", r.rolbypassrls AS "bypassrls", r.rolreplication AS "replication",
       r.rolcreaterole AS "createrole", r.rolcreatedb AS "createdb", r.rolcanlogin AS "login", r.rolinherit AS "inherit",
       coalesce((SELECT json_agg(json_build_object('member', m.rolname, 'admin', a.admin_option, 'inherit', a.inherit_option, 'set', a.set_option) ORDER BY m.rolname)
                   FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles m ON m.oid = a.member WHERE a.roleid = r.oid), '[]'::json) AS "members",
       coalesce((SELECT json_agg(json_build_object('role', g.rolname, 'admin', a.admin_option, 'inherit', a.inherit_option, 'set', a.set_option) ORDER BY g.rolname)
                   FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles g ON g.oid = a.roleid WHERE a.member = r.oid), '[]'::json) AS "memberOf"
  FROM pg_catalog.pg_roles r WHERE r.rolname = ANY ($1::text[])`;

export interface MembershipRow {
  admin: boolean;
  inherit: boolean;
  set: boolean;
}

export interface RoleFacts {
  name: string;
  super: boolean;
  bypassrls: boolean;
  replication: boolean;
  createrole: boolean;
  createdb: boolean;
  login: boolean;
  inherit: boolean;
  members: Array<MembershipRow & { member: string }>;
  memberOf: Array<MembershipRow & { role: string }>;
}

/** PostgreSQL 16+ keeps one membership row per grantor: the union of the options per role. */
function mergeRows<K extends 'member' | 'role'>(rows: ReadonlyArray<MembershipRow & Record<K, string>>, key: K): Map<string, MembershipRow> {
  const out = new Map<string, MembershipRow>();
  for (const r of rows) {
    const prev = out.get(r[key]) ?? { admin: false, inherit: false, set: false };
    out.set(r[key], { admin: prev.admin || r.admin, inherit: prev.inherit || r.inherit, set: prev.set || r.set });
  }
  return out;
}

/** Pure: the problems of an EXISTING role against its bootstrap shape (empty = acceptable as is). */
export function roleShapeProblems(spec: RoleSpec, facts: RoleFacts, owner: string = OWNER_LOGIN): string[] {
  const problems: string[] = [];
  const attr = (ok: boolean, what: string) => {
    if (!ok) problems.push(`${spec.name}: ${what}`);
  };
  attr(!facts.super, 'is SUPERUSER');
  attr(!facts.bypassrls, 'has BYPASSRLS');
  attr(!facts.replication, 'has REPLICATION');
  attr(!facts.createrole, 'has CREATEROLE');
  attr(!facts.createdb, 'has CREATEDB');
  attr(facts.login === spec.login, spec.login ? 'is NOLOGIN (must be LOGIN)' : 'is LOGIN (must be NOLOGIN)');
  attr(facts.inherit, 'is NOINHERIT');

  const members = mergeRows(facts.members, 'member');
  for (const [member, o] of members) {
    if (member === owner) {
      if (spec.ownerMember === 'none') problems.push(`${spec.name}: ${owner} is a member (it must have none)`);
      else if (spec.ownerMember === 'admin-only' && (o.inherit || o.set)) problems.push(`${spec.name}: ${owner} has INHERIT or SET on it`);
      else if (spec.ownerMember === 'inherit-set' && !(o.inherit && o.set)) problems.push(`${spec.name}: ${owner} lacks INHERIT TRUE, SET TRUE`);
      continue;
    }
    const allowed = BOOTSTRAP_ROLES.find((r) => r.name === member)?.memberOf.find((m) => m.role === spec.name);
    if (!allowed) problems.push(`${spec.name}: unexpected member ${member}`);
    else if (o.admin || o.inherit !== allowed.inherit || o.set !== allowed.set) problems.push(`${spec.name}: member ${member} has the wrong options`);
  }
  if (spec.ownerMember !== 'none' && !members.has(owner)) {
    problems.push(`${spec.name}: ${owner} is not a member (it cannot adopt a role it neither created nor was granted)`);
  }

  const memberOf = mergeRows(facts.memberOf, 'role');
  for (const [role, o] of memberOf) {
    const allowed = spec.memberOf.find((m) => m.role === role);
    if (!allowed) problems.push(`${spec.name}: is a member of ${role}`);
    else if (o.admin || o.inherit !== allowed.inherit || o.set !== allowed.set) problems.push(`${spec.name}: membership of ${role} has the wrong options`);
  }
  for (const m of spec.memberOf) if (!memberOf.has(m.role)) problems.push(`${spec.name}: is not a member of ${m.role}`);
  return problems;
}

export async function readRoleFacts(query: Query, names: readonly string[]): Promise<Map<string, RoleFacts>> {
  const rows = (await query(ROLE_FACTS_SQL, [[...names]])) as RoleFacts[];
  return new Map(rows.map((r) => [r.name, r]));
}

export interface BootstrapResult {
  created: string[];
  verified: string[];
  extensionsCreated: string[];
  attempts: number;
}

export function isRoleRace(error: unknown): boolean {
  const e = error as { code?: string; driverError?: { code?: string } } | undefined;
  const code = e?.code ?? e?.driverError?.code;
  return code === '42710' || code === '23505';
}

/**
 * Runs the bootstrap in one transaction on `query` (the locked session; no transaction may be open). Retries a lost
 * CREATE ROLE race at most `maxAttempts` times (each attempt starts from a clean rollback). Throws BootstrapRefusal on a
 * wrong shape, and any other error unchanged.
 */
export async function runOwnerLoginBootstrap(
  query: Query,
  options: { log?: (line: string) => void; maxAttempts?: number; owner?: string } = {},
): Promise<BootstrapResult> {
  const log = options.log ?? (() => undefined);
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    await query('BEGIN');
    try {
      const result = await bootstrapOnce(query, options.owner ?? OWNER_LOGIN, log);
      await query('COMMIT');
      return { ...result, attempts: attempt };
    } catch (error) {
      await query('ROLLBACK').catch(() => undefined);
      const code = (error as { code?: string; driverError?: { code?: string } })?.code ?? (error as { driverError?: { code?: string } })?.driverError?.code;
      if (code === '42501') {
        // Insufficient privilege (e.g. no GRANT OPTION on the database, no CREATE on it, an extension that needs more than
        // CREATE): the M0 §5.1 admin step is incomplete. The whole bootstrap rolled back; nothing was created.
        throw new BootstrapRefusal(
          `insufficient privilege during the bootstrap (SQLSTATE 42501): run the provider-admin step postgres-init/owner-login/01-crewflow-owner.sql exactly (CREATEROLE, and CONNECT, CREATE, TEMPORARY ON DATABASE WITH GRANT OPTION). Nothing was created.`,
        );
      }
      if (isRoleRace(error) && attempt < maxAttempts) {
        log(`bootstrap attempt ${attempt}: another installation created a Crewflow role at the same moment (roles are cluster-wide); rolled back, re-verifying`);
        continue;
      }
      throw error;
    }
  }
}

async function bootstrapOnce(query: Query, owner: string, log: (line: string) => void): Promise<Omit<BootstrapResult, 'attempts'>> {
  const [me] = (await query(
    `SELECT session_user::text AS "session", current_user::text AS "current", r.rolcreaterole AS "createrole", r.rolsuper AS "super",
            r.rolbypassrls AS "bypassrls", current_database()::text AS "db"
       FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
  )) as Array<{ session: string; current: string; createrole: boolean; super: boolean; bypassrls: boolean; db: string }>;
  if (!me || me.session !== owner || me.current !== owner) throw new BootstrapRefusal(`the bootstrap runs only as ${owner} itself (no SET ROLE).`);
  if (me.super || me.bypassrls) throw new BootstrapRefusal(`${owner} must be NOSUPERUSER NOBYPASSRLS.`);
  if (!me.createrole) throw new BootstrapRefusal(`${owner} needs CREATEROLE for the first install (M0 §5.1 admin step). Refusing.`);

  const names = [...BOOTSTRAP_ROLES.map((r) => r.name), ROLEMAKER];
  const existing = await readRoleFacts(query, names);
  if (existing.has(ROLEMAKER)) {
    throw new BootstrapRefusal(
      `${ROLEMAKER} exists, but it is only ever created and dropped inside one bootstrap transaction. Review and drop it as the provider admin. Refusing.`,
    );
  }
  const problems = BOOTSTRAP_ROLES.flatMap((spec) => (existing.has(spec.name) ? roleShapeProblems(spec, existing.get(spec.name)!, owner) : []));
  if (problems.length) throw new BootstrapRefusal(`pre-existing Crewflow roles do not have the bootstrap shape (nothing changed): ${problems.join('; ')}`);

  const created: string[] = [];
  const verified: string[] = [];
  for (const spec of BOOTSTRAP_ROLES) {
    if (existing.has(spec.name)) {
      verified.push(spec.name);
      continue;
    }
    if (spec.name === 'crewflow_worker') {
      await query(`CREATE ROLE ${ROLEMAKER} NOLOGIN CREATEROLE`);
      await query(`GRANT ${ROLEMAKER} TO ${q(owner)} WITH INHERIT FALSE, SET TRUE`);
      await query(`SET LOCAL ROLE ${ROLEMAKER}`);
      await query(`CREATE ROLE crewflow_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`);
      await query(`RESET ROLE`);
      await query(`GRANT crewflow_app TO crewflow_worker WITH INHERIT TRUE, SET FALSE`);
      await query(`DROP ROLE ${ROLEMAKER}`);
    } else if (spec.name === 'crewflow_app') {
      await query(`CREATE ROLE crewflow_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    } else {
      await query(`CREATE ROLE ${q(spec.name)} ${spec.login ? 'LOGIN' : 'NOLOGIN'} NOBYPASSRLS`);
      await query(`GRANT ${q(spec.name)} TO ${q(owner)} WITH INHERIT TRUE, SET TRUE`);
    }
    created.push(spec.name);
  }

  await query(`GRANT CREATE ON DATABASE ${q(me.db)} TO rab_owner`);

  const extRows = (await query(
    `SELECT e.extname::text AS "name", n.nspname::text AS "schema" FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = ANY ($1::text[])`,
    [[...BOOTSTRAP_EXTENSIONS]],
  )) as Array<{ name: string; schema: string }>;
  const misplaced = extRows.filter((e) => e.schema !== 'public');
  if (misplaced.length) {
    throw new BootstrapRefusal(
      `extension(s) already installed outside schema public: ${misplaced.map((e) => `${e.name} in ${e.schema}`).join(', ')}. The chain needs them in public. Refusing.`,
    );
  }
  const extensionsCreated: string[] = [];
  for (const ext of BOOTSTRAP_EXTENSIONS) {
    if (extRows.some((e) => e.name === ext)) continue;
    await query(`CREATE EXTENSION IF NOT EXISTS ${ext} WITH SCHEMA public`);
    extensionsCreated.push(ext);
  }

  const [core] = (await query(`SELECT pg_catalog.pg_get_userbyid(nspowner)::text AS "owner" FROM pg_catalog.pg_namespace WHERE nspname = 'core'`)) as Array<{
    owner: string;
  }>;
  if (core && core.owner !== 'rab_owner') throw new BootstrapRefusal(`schema core exists and is owned by ${core.owner}, not rab_owner. Refusing.`);
  if (!core) await query(`CREATE SCHEMA core AUTHORIZATION rab_owner`);
  await query(`GRANT USAGE ON SCHEMA core TO rab_app`);
  await query(`ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rab_app`);
  await query(`ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core GRANT USAGE, SELECT ON SEQUENCES TO rab_app`);
  await query(`ALTER DEFAULT PRIVILEGES FOR ROLE rab_owner IN SCHEMA core GRANT EXECUTE ON FUNCTIONS TO rab_app`);

  // Post-condition inside the transaction: every role has the bootstrap shape now.
  const after = await readRoleFacts(query, names);
  const left = [
    ...(after.has(ROLEMAKER) ? [`${ROLEMAKER} still exists`] : []),
    ...BOOTSTRAP_ROLES.flatMap((spec) => (after.has(spec.name) ? roleShapeProblems(spec, after.get(spec.name)!, owner) : [`${spec.name} missing`])),
  ];
  if (left.length) throw new BootstrapRefusal(`bootstrap post-condition failed (rolled back): ${left.join('; ')}`);
  log(
    `bootstrap committed: created ${created.join(', ') || 'no role'}; verified ${verified.join(', ') || 'none'}; ` +
      `extensions created ${extensionsCreated.join(', ') || 'none'}`,
  );
  return { created, verified, extensionsCreated };
}
