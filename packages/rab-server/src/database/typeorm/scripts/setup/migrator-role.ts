/**
 * Creates (or, with --drop, removes) the migration-only login `crewflow_migrator` on a DISPOSABLE cluster, by running the
 * reviewed create-migrator-role.sql / drop-migrator-role.sql next to this file. Phase B (P7).
 *
 *   CREWFLOW_SETUP_ADMIN_URL=<superuser of a DISPOSABLE loopback cluster> CREWFLOW_MIGRATOR_PASSWORD=<[A-Za-z0-9]{24,}> \
 *     ts-node --transpile-only -P packages/rab-server/tsconfig.app.json \
 *     packages/rab-server/src/database/typeorm/scripts/setup/migrator-role.ts [--drop]
 *
 * DISPOSABLE ONLY. The admin URL is read only from CREWFLOW_SETUP_ADMIN_URL (never DATABASE_URL, PG_DATABASE_URL or .env),
 * must be a loopback host and a superuser of a cluster marked `crewflow.disposable_cluster = on` (the marker the M2 harness
 * and the CI containers use); the SQL re-checks the marker itself.
 *
 * Security review L-1: the URL is parsed by the connection factory's URL policy (pg-url-policy.ts: a `?host=`, `?hostaddr=`,
 * `?port=`, `?user=` or session `?options=` override is refused, so the host checked here is the host connected to) and
 * the client is built by the factory with explicit fields (createPgClient), never a raw connection string. The marker is
 * read from server-side facts a session cannot set (DISPOSABLE_MARKER_SQL): a database- or cluster-level setting in
 * pg_db_role_setting (`ALTER DATABASE postgres SET crewflow.disposable_cluster = on`, the local disposable cluster), a
 * configuration-file entry (`ALTER SYSTEM` / postgresql.conf, pg_file_settings), or the postmaster command line
 * (`-c crewflow.disposable_cluster=on`, the CI container; postmaster.opts). current_setting() is never the proof: a
 * session's startup options could set it. Creating crewflow_migrator on any real environment is a
 * separate owner approval and is not what this tool is for.
 *
 * The password is set as a SCRAM-SHA-256 verifier computed here (RFC 5802/7677, 4096 iterations, random salt), so the
 * plaintext never reaches the server or its statement log. Output: role attributes and memberships only, never a URL, user
 * name of the admin, or password.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPgClientForUrl, PgConfigError, parsePgUrl } from '../../../postgres';

const ROLE = 'crewflow_migrator';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Server-side disposable-cluster facts (security review L-1). Superuser only (pg_file_settings, pg_read_file). Kept in step
 * with the DO block of create-migrator-role.sql, which re-checks the same three facts on the same session.
 */
export const DISPOSABLE_MARKER_SQL = `SELECT
    (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) AS rolsuper,
    EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s
             WHERE s.setrole = 0
               AND s.setdatabase IN (0, (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()))
               AND 'crewflow.disposable_cluster=on' = ANY (s.setconfig)) AS database_marker,
    EXISTS (SELECT 1 FROM pg_catalog.pg_file_settings f
             WHERE f.name = 'crewflow.disposable_cluster' AND f.setting = 'on' AND f.error IS NULL) AS file_marker,
    coalesce(pg_catalog.pg_read_file('postmaster.opts', true), '') ~ '"-c" "crewflow[.]disposable_cluster=on"' AS command_line_marker`;

export interface DisposableMarkerFacts {
  rolsuper: boolean | null;
  database_marker: boolean;
  file_marker: boolean;
  command_line_marker: boolean;
}

/** Refuses unless the login is a superuser AND one server-side marker fact holds. Pure. */
export function assertDisposableCluster(facts: DisposableMarkerFacts | undefined): string {
  if (!facts?.rolsuper) throw new MigratorRoleSetupError('CREWFLOW_SETUP_ADMIN_URL must be a superuser of the disposable cluster. Refusing.');
  if (facts.database_marker) return 'database setting';
  if (facts.file_marker) return 'configuration file';
  if (facts.command_line_marker) return 'server command line';
  throw new MigratorRoleSetupError(
    'the cluster is not marked disposable server-side (crewflow.disposable_cluster = on as a database setting, in the configuration or on the server command line; a session setting does not count). Refusing.',
  );
}

export class MigratorRoleSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigratorRoleSetupError';
  }
}

/** PostgreSQL's SCRAM-SHA-256 verifier format: SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey> (base64). */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export function disposableAdminUrl(raw: string | undefined): string {
  if (!raw?.trim()) throw new MigratorRoleSetupError('CREWFLOW_SETUP_ADMIN_URL is required. There is no fallback.');
  // The factory's URL policy: refuses host/hostaddr/port/user/dbname query overrides and session `options`, so the host
  // checked below is the host the client connects to. Its messages never contain the value.
  let target;
  try {
    target = parsePgUrl(raw, 'CREWFLOW_SETUP_ADMIN_URL');
  } catch (error) {
    if (error instanceof PgConfigError) throw new MigratorRoleSetupError(error.message);
    throw error;
  }
  if (!LOOPBACK.has(target.host)) throw new MigratorRoleSetupError('CREWFLOW_SETUP_ADMIN_URL must be a loopback disposable cluster. Refusing.');
  const url = new URL(raw.trim());
  url.pathname = '/postgres';
  return url.toString();
}

export async function setupMigratorRole(mode: 'create' | 'drop', env: Record<string, string | undefined> = process.env): Promise<string> {
  const adminUrl = disposableAdminUrl(env.CREWFLOW_SETUP_ADMIN_URL);
  const password = env.CREWFLOW_MIGRATOR_PASSWORD;
  if (mode === 'create' && !/^[A-Za-z0-9]{24,128}$/.test(password ?? '')) {
    throw new MigratorRoleSetupError('CREWFLOW_MIGRATOR_PASSWORD must be 24-128 letters and digits (for example `openssl rand -hex 32`).');
  }
  // The connection factory, with explicit fields (never a raw connection string to pg). Only this variable is consulted.
  let client;
  try {
    client = createPgClientForUrl(adminUrl, 'CREWFLOW_SETUP_ADMIN_URL', { purpose: 'migrator-role-setup' }, env);
  } catch (error) {
    if (error instanceof PgConfigError) throw new MigratorRoleSetupError(error.message);
    throw error;
  }
  await client.connect();
  try {
    const { rows } = await client.query<DisposableMarkerFacts>(DISPOSABLE_MARKER_SQL);
    assertDisposableCluster(rows[0]);

    if (mode === 'drop') {
      await client.query(readFileSync(join(__dirname, 'drop-migrator-role.sql'), 'utf8'));
      const left = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [ROLE]);
      if (left.rowCount) throw new MigratorRoleSetupError(`${ROLE} still exists after the drop.`);
      return `${ROLE} dropped`;
    }

    await client.query(readFileSync(join(__dirname, 'create-migrator-role.sql'), 'utf8'));
    await client.query(`ALTER ROLE ${ROLE} LOGIN PASSWORD ${client.escapeLiteral(scramSha256Verifier(password as string))}`);
    const attrs = await client.query(
      `SELECT r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolcanlogin, r.rolinherit,
              (SELECT string_agg(g.rolname, ',' ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of
         FROM pg_roles r WHERE r.rolname = $1`,
      [ROLE],
    );
    const a = attrs.rows[0];
    const expected = { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolcanlogin: true, rolinherit: true };
    for (const [k, v] of Object.entries(expected)) {
      if (a?.[k] !== v) throw new MigratorRoleSetupError(`${ROLE} has ${k}=${String(a?.[k])}, expected ${String(v)}.`);
    }
    if (a.member_of !== 'crewflow,rab_secure_owner') throw new MigratorRoleSetupError(`${ROLE} memberships are "${a.member_of}", expected crewflow,rab_secure_owner.`);
    return `${ROLE}: LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT, member of ${a.member_of}`;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (require.main === module) {
  setupMigratorRole(process.argv.includes('--drop') ? 'drop' : 'create').then(
    (summary) => {
      // eslint-disable-next-line no-console
      console.log(`[migrator-role] ${summary}`);
      process.exit(0);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : 'unknown error';
      // eslint-disable-next-line no-console
      console.error(`[migrator-role] FAILED: ${message.replace(/postgres(ql)?:\/\/\S+/gi, '<url>')}`);
      process.exit(1);
    },
  );
}
