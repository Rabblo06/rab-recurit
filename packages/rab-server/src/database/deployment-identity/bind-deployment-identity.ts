/**
 * `db:bind-identity` — the ONLY write path for the deployment identity marker (Phase B / B3, P3). Binds an unbound database
 * or rebinds a bound one (a clone or restore of production, or a production id rotation), audited in
 * core.deployment_identity_history by the database itself.
 *
 * Standalone script, not a nest-commander command: the CLI refuses a migration identity by design (database boot gates),
 * and this command must run AS the migration identity (a member of rab_secure_owner, the only caller
 * core.deployment_identity_bind admits). It never boots Nest and never loads .env into the process.
 *
 * Order, before any write:
 *   1. arguments (all required confirmations present and well-formed);
 *   2. the command target guard (database-target.ts assertDbTarget: DB_TARGET, production authority from the process
 *      environment only, read-only probe, and the CURRENT marker against the declared deployment identity — so rebinding a
 *      production-bound database needs production command authority and its current id);
 *   3. the connecting login: never crewflow / crewflow_app, and it must be able to act as rab_secure_owner (CF-41
 *      migration identity: migration-identity.ts MIGRATION_IDENTITY_FACTS_QUERY) or be a superuser;
 *   4. typed confirmations against the live connection: database name, the host set (it must contain the host this
 *      command connects to), and (when bound) the current deployment id;
 *   5. one transaction: read marker, core.deployment_identity_bind(...), read marker again, verify, commit.
 * Owner decision A + host-binding review: the bind also records WHERE the deployment lives — the database
 * (current_database(), recorded by the definer itself) and the SET of 1 to 5 host names confirmed with repeated
 * --confirm-host (passed to the definer, which validates the shape and stores them sorted). Bind every host name a process
 * of this deployment connects through: typically the direct host (Worker, provisioner, migrations, this command) and, when
 * the API uses one, a session-compatible proxy host. Only the host this command itself connects to is verified by a live
 * connection; any other confirmed host is the operator's statement. A host name with a documented transaction-pooler
 * shape (Neon `-pooler`, AWS RDS Proxy) is refused here; port-only pooler shapes are decided by the URL policy of each
 * process at start. Every runtime and command identity check then refuses a database whose own name differs or whose
 * connection host is not in the set (a restore, clone, fork or branch elsewhere, or a provider-issued new host name)
 * until this command rebinds it. This command is the only reader allowed to see a marker bound elsewhere (as a warning),
 * because recording the new location is its purpose.
 *
 * AUTHENTICATION, precisely: what admits a bind today is possession of the migration credential (a database login that is
 * a member of rab_secure_owner) — the definer re-checks the SESSION login and records it as `session_login`. `--actor` is
 * free text the operator types: self-asserted metadata recorded as `bound_by`, NOT proof of who the operator is. Tying a
 * bind to an approved operations ticket is a separate owner decision. The history row is an audit aid, not tamper-proof
 * against the migration identity (it can SET ROLE rab_secure_owner and write the marker directly).
 * Prints the before / after environment and deployment id, the database and the hosts. Never a URL, user name or password.
 *
 * Connection (Phase B / B1): the command's own PG_DATABASE_URL (the migration identity; outside production the deprecated
 * DATABASE_URL_UNPOOLED still names it), resolved by the shared factory exactly as the target guard resolved it (same
 * endpoint, URL policy and TLS), so the database the guard probed is the database written to.
 */
import { createPgClient, detectTransactionPooler } from '../postgres';
import { BOUND_HOST_PATTERN, MAX_BOUND_HOSTS } from '../typeorm/core/deployment-identity-sql';
import { assertDbTarget, DbTargetError, ResolvedDbTarget } from '../typeorm/core/database-target';
import { MIGRATION_IDENTITY_FACTS_QUERY } from '../typeorm/core/migration-identity';
import {
  DEPLOYMENT_ENVIRONMENTS,
  DEPLOYMENT_IDENTITY_MIGRATION,
  DeploymentEnvironment,
  DeploymentMarker,
  isDeploymentEnvironment,
  isRemoteDatabaseHost,
  isUuid,
  readDeploymentMarker,
} from './deployment-identity';

export const BIND_COMMAND = 'db:bind-identity';

export const BIND_USAGE = `${BIND_COMMAND}: bind or rebind this database's deployment identity marker (migration identity only).

Environment (process environment only, never .env):
  DB_TARGET=local|test|production
  PG_DATABASE_URL=<migration-identity URL>      (outside production also the deprecated DATABASE_URL / DATABASE_URL_UNPOOLED)
  production also: ALLOW_PRODUCTION_DB_COMMANDS=true
                   CREWFLOW_DEPLOYMENT_ENVIRONMENT=production CREWFLOW_DEPLOYMENT_ID=<the id the database is bound to now>
  first bind of a fresh production database only:
                   CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP=unbound-production-database PG_EXPECTED_DATABASE_NAME=<database>
                   (CREWFLOW_DEPLOYMENT_ID is then the NEW id being bound)

Arguments (all required unless marked):
  --environment <${DEPLOYMENT_ENVIRONMENTS.join('|')}>
  --deployment-id <uuid>                    the NEW id; a rebind must choose a different one
  --reason "<10 to 500 characters>"         recorded in core.deployment_identity_history
  --actor "<who, 1 to 200 characters>"      recorded as bound_by (self-asserted text, not an authenticated identity)
  --confirm-database <name>                 must equal the server's current_database()
  --confirm-host <host>                     REPEAT once per host name a process of this deployment connects through
                                            (1 to ${MAX_BOUND_HOSTS}, e.g. the direct host and the API's session-compatible proxy
                                            host); the set must include the host this command connects to; recorded as
                                            bound_hosts. Transaction-pooler host names (Neon -pooler, RDS Proxy) are refused.
  --confirm-current-deployment-id <uuid>    REQUIRED when the database is already bound: the id bound now

Example (rebind a restored copy of production as staging, run with production command authority):
  DB_TARGET=production ALLOW_PRODUCTION_DB_COMMANDS=true \\
  CREWFLOW_DEPLOYMENT_ENVIRONMENT=production CREWFLOW_DEPLOYMENT_ID=<production id> \\
  PG_DATABASE_URL=<migration-identity URL of the COPY> \\
  node packages/rab-server/dist/database/deployment-identity/bind-deployment-identity.js \\
    --environment staging --deployment-id <new uuid> --reason "restored copy for staging, ticket OPS-123" \\
    --actor "ops: Jane Doe" --confirm-database <copy database> --confirm-host <copy direct host> \\
    --confirm-current-deployment-id <production id>`;

export class BindIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindIdentityError';
  }
}

export interface BindArgs {
  environment: DeploymentEnvironment;
  deploymentId: string;
  reason: string;
  actor: string;
  confirmDatabase: string;
  /** Canonical (lower-case, no brackets), distinct, sorted in byte order — exactly what the definer stores. */
  confirmHosts: string[];
  confirmCurrentDeploymentId: string | null;
}

const FLAGS: Record<string, keyof BindArgs> = {
  '--environment': 'environment',
  '--deployment-id': 'deploymentId',
  '--reason': 'reason',
  '--actor': 'actor',
  '--confirm-database': 'confirmDatabase',
  '--confirm-host': 'confirmHosts',
  '--confirm-current-deployment-id': 'confirmCurrentDeploymentId',
};

const BOUND_HOST = new RegExp(BOUND_HOST_PATTERN);

/** Canonical host form, the same as the factory's parse (lower-case, IPv6 brackets removed). */
export const canonicalConfirmHost = (host: string) => host.trim().replace(/^\[|\]$/g, '').toLowerCase();

/** Validates and canonicalises the repeated --confirm-host values: 1 to MAX_BOUND_HOSTS distinct, well-formed names. */
export function parseConfirmHosts(values: readonly string[]): string[] {
  if (values.length === 0) throw new BindIdentityError('--confirm-host is required (repeat it for each host name). See --help.');
  if (values.length > MAX_BOUND_HOSTS) throw new BindIdentityError(`--confirm-host is given ${values.length} times; at most ${MAX_BOUND_HOSTS} host names can be bound.`);
  const hosts = values.map(canonicalConfirmHost);
  for (const host of hosts) {
    if (host.length < 1 || host.length > 253 || !BOUND_HOST.test(host)) {
      throw new BindIdentityError(`--confirm-host "${host}" is not a host name or address (letters, digits, dot, hyphen; IPv6 without brackets).`);
    }
    const pooler = detectTransactionPooler(host, 5432);
    if (pooler) {
      throw new BindIdentityError(
        `--confirm-host "${host}" has a documented transaction-pooler shape (${pooler.reason}). Bind direct or session-compatible host names only.`,
      );
    }
  }
  if (new Set(hosts).size !== hosts.length) throw new BindIdentityError('--confirm-host names the same host twice.');
  return [...hosts].sort();
}

/** `--flag value` or `--flag=value`. Unknown flags, repeats (except --confirm-host) and missing values are refused. */
export function parseBindArgs(argv: readonly string[]): BindArgs {
  const raw: Partial<Record<Exclude<keyof BindArgs, 'confirmHosts'>, string>> = {};
  const hostValues: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const flag = eq > 0 ? token.slice(0, eq) : token;
    const key = FLAGS[flag];
    if (!key) throw new BindIdentityError(`unknown argument "${flag}". See --help.`);
    const value = eq > 0 ? token.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith('--')) throw new BindIdentityError(`${flag} needs a value.`);
    if (key === 'confirmHosts') {
      hostValues.push(value);
      continue;
    }
    if (raw[key] !== undefined) throw new BindIdentityError(`${flag} is given twice.`);
    raw[key] = value.trim();
  }
  for (const [flag, key] of Object.entries(FLAGS)) {
    if (key !== 'confirmCurrentDeploymentId' && key !== 'confirmHosts' && !raw[key]) throw new BindIdentityError(`${flag} is required. See --help.`);
  }
  const confirmHosts = parseConfirmHosts(hostValues);
  const environment = raw.environment as string;
  if (!isDeploymentEnvironment(environment)) {
    throw new BindIdentityError(`--environment must be one of ${DEPLOYMENT_ENVIRONMENTS.join(', ')}.`);
  }
  const deploymentId = (raw.deploymentId as string).toLowerCase();
  if (!isUuid(deploymentId)) throw new BindIdentityError('--deployment-id must be a uuid.');
  const confirmCurrent = raw.confirmCurrentDeploymentId ? raw.confirmCurrentDeploymentId.toLowerCase() : null;
  if (confirmCurrent !== null && !isUuid(confirmCurrent)) throw new BindIdentityError('--confirm-current-deployment-id must be a uuid.');
  const reason = raw.reason as string;
  if (reason.length < 10 || reason.length > 500) throw new BindIdentityError('--reason must be 10 to 500 characters.');
  const actor = raw.actor as string;
  if (actor.length < 1 || actor.length > 200) throw new BindIdentityError('--actor must be 1 to 200 characters.');
  return {
    environment,
    deploymentId,
    reason,
    actor,
    confirmDatabase: raw.confirmDatabase as string,
    confirmHosts,
    confirmCurrentDeploymentId: confirmCurrent,
  };
}

export interface BindLoginFacts {
  currentUser: string;
  sessionUser: string;
  isSuperuser: boolean;
  canActAsOwnerRoles: boolean;
}

/** The migration identity only: never a runtime login, and able to act as rab_secure_owner (or a superuser). */
export function assertBindLogin(facts: BindLoginFacts): void {
  for (const who of [facts.currentUser, facts.sessionUser]) {
    if (who === 'crewflow' || who === 'crewflow_app') {
      throw new BindIdentityError(`${BIND_COMMAND} refuses the runtime login "${who}". Run it with the migration identity URL only.`);
    }
  }
  if (facts.currentUser !== facts.sessionUser) {
    throw new BindIdentityError(`${BIND_COMMAND} refuses a SET ROLE session. Connect as the migration identity itself.`);
  }
  if (!facts.isSuperuser && !facts.canActAsOwnerRoles) {
    throw new BindIdentityError(
      `${BIND_COMMAND}: the connecting login cannot act as rab_secure_owner and crewflow (CF-41 migration identity). Use the migration-only login.`,
    );
  }
}

export interface BindPlanInput {
  args: BindArgs;
  target: Pick<ResolvedDbTarget, 'target' | 'declared' | 'bootstrapRequested'>;
  marker: DeploymentMarker;
  database: string;
  /** The host THIS command's connection names (the factory's canonical parse): it must be one of the confirmed hosts. */
  host: string;
}

/** Pure: every refusal that can be decided before calling the definer. Returns a one-line description of the change. */
export function planBind(input: BindPlanInput): string {
  const { args, target, marker, database, host } = input;
  if (args.confirmDatabase !== database) {
    throw new BindIdentityError(`--confirm-database "${args.confirmDatabase}" does not match the connected database "${database}". Nothing changed.`);
  }
  if (!args.confirmHosts.includes(canonicalConfirmHost(host))) {
    throw new BindIdentityError(
      `--confirm-host ${args.confirmHosts.map((h) => `"${h}"`).join(', ')} does not include the host this command connects to ("${host}"). Nothing changed.`,
    );
  }
  if (args.environment === 'production' && target.target !== 'production') {
    throw new BindIdentityError('binding environment=production requires DB_TARGET=production (production command authority). Nothing changed.');
  }
  // Final review F7: a production marker bound to a loopback or single-label host would let a tunnel on any machine pass the
  // location check. Production databases are always reached by a network name (the production compose has no database).
  const localHost = args.environment === 'production' ? args.confirmHosts.find((h) => !isRemoteDatabaseHost(h)) : undefined;
  if (localHost !== undefined) {
    throw new BindIdentityError(
      `--confirm-host "${localHost}" is a loopback or single-label host; a production bind names the database's network host names only. Nothing changed.`,
    );
  }
  if (marker.state === 'absent') {
    throw new BindIdentityError(`the marker does not exist: apply migration ${DEPLOYMENT_IDENTITY_MIGRATION} first. Nothing changed.`);
  }
  if (marker.state === 'unbound') {
    if (args.confirmCurrentDeploymentId !== null) {
      throw new BindIdentityError('the database is not bound yet: --confirm-current-deployment-id must not be given. Nothing changed.');
    }
    if (target.target === 'production') {
      // Bootstrap: bind exactly what the deployment environment declares, so the app's env and the marker cannot diverge.
      if (!target.bootstrapRequested || !target.declared) {
        throw new BindIdentityError('the first production bind needs the bootstrap flag and the declared production identity. Nothing changed.');
      }
      if (args.environment !== target.declared.environment || args.deploymentId !== target.declared.deploymentId) {
        throw new BindIdentityError(
          'the first production bind must bind exactly CREWFLOW_DEPLOYMENT_ENVIRONMENT / CREWFLOW_DEPLOYMENT_ID of this environment. Nothing changed.',
        );
      }
    }
    return `bind (unbound) -> ${args.environment}/${args.deploymentId} at ${args.confirmHosts.join(',')}/${database}`;
  }
  const current = marker.deploymentId.toLowerCase();
  if (args.confirmCurrentDeploymentId === null) {
    throw new BindIdentityError(`the database is bound (${marker.environment}/${current}): --confirm-current-deployment-id is required. Nothing changed.`);
  }
  if (args.confirmCurrentDeploymentId !== current) {
    throw new BindIdentityError(`--confirm-current-deployment-id does not match the bound id (${marker.environment}/${current}). Nothing changed.`);
  }
  if (args.deploymentId === current) {
    throw new BindIdentityError('a rebind needs a NEW deployment id (the same id would let the old deployment keep using this database). Nothing changed.');
  }
  return `rebind ${marker.environment}/${current} -> ${args.environment}/${args.deploymentId} at ${args.confirmHosts.join(',')}/${database}`;
}

const sanitise = (text: string) => text.replace(/postgres(ql)?:\/\/\S+/g, '<url>');

const describeMarker = (m: DeploymentMarker) =>
  m.state === 'bound' ? `${m.environment}/${m.deploymentId}@${m.boundHosts?.join(',') ?? '?'}/${m.boundDatabase ?? '?'}` : m.state;

export async function runBind(argv: readonly string[], env: Record<string, string | undefined>, log: (line: string) => void): Promise<void> {
  const args = parseBindArgs(argv);
  // The factory's rule (selectMigrationEndpoint): PG_DATABASE_URL; outside production the deprecated DATABASE_URL_UNPOOLED
  // when PG_DATABASE_URL is unset; both naming different targets is refused by the guard.
  const target = await assertDbTarget(BIND_COMMAND, env);
  const endpoint = target.migrationEndpoint;
  const host = (endpoint === 'elevated' && target.admin ? target.admin : target.app).host;

  const client = createPgClient(target.pg, { endpoint, purpose: 'bind-identity', sessionAffinity: true });
  await client.connect();
  try {
    const [facts] = (await client.query(MIGRATION_IDENTITY_FACTS_QUERY)).rows as Array<{ currentUser: string; isSuperuser: boolean; canActAsOwnerRoles: boolean }>;
    const [login] = (await client.query(`SELECT session_user::text AS login`)).rows as Array<{ login: string }>;
    if (!facts || !login) throw new BindIdentityError('cannot read the connecting login. Nothing changed.');
    assertBindLogin({ currentUser: facts.currentUser, sessionUser: login.login, isSuperuser: facts.isSuperuser, canActAsOwnerRoles: facts.canActAsOwnerRoles });

    const query = async (sql: string, params?: unknown[]) => (await client.query(sql, params as unknown[])).rows;
    await client.query('BEGIN');
    try {
      const before = await readDeploymentMarker(query);
      const plan = planBind({ args, target, marker: before.marker, database: before.database, host });
      log(`[${BIND_COMMAND}] database=${before.database} host=${host} target=${target.target} before=${describeMarker(before.marker)}`);
      log(`[${BIND_COMMAND}] ${plan}`);
      await client.query(`SELECT core.deployment_identity_bind($1, $2::uuid, $3, $4, $5::uuid, $6::text[])`, [
        args.environment,
        args.deploymentId,
        args.reason,
        args.actor,
        args.confirmCurrentDeploymentId,
        args.confirmHosts,
      ]);
      const after = await readDeploymentMarker(query);
      if (
        after.marker.state !== 'bound' ||
        after.marker.environment !== args.environment ||
        after.marker.deploymentId.toLowerCase() !== args.deploymentId ||
        after.marker.boundDatabase !== before.database ||
        JSON.stringify(after.marker.boundHosts ?? []) !== JSON.stringify(args.confirmHosts) ||
        !args.confirmHosts.includes(canonicalConfirmHost(host))
      ) {
        throw new BindIdentityError(`the marker reads ${describeMarker(after.marker)} after the bind, not the requested value. Rolled back.`);
      }
      await client.query('COMMIT');
      log(`[${BIND_COMMAND}] committed. after=${describeMarker(after.marker)} database=${after.database} host=${host} (history row written with session_login and bound_by)`);
      log(
        `[${BIND_COMMAND}] next: set CREWFLOW_DEPLOYMENT_ENVIRONMENT=${args.environment} and CREWFLOW_DEPLOYMENT_ID=${args.deploymentId} on every process that uses this database` +
          (target.bootstrapRequested ? ', and REMOVE CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP' : '') +
          '. Processes still declaring the old value will refuse to start.',
      );
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    // eslint-disable-next-line no-console
    console.log(BIND_USAGE);
    return;
  }
  await runBind(argv, process.env, (line) => console.log(line)); // eslint-disable-line no-console
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // Guard and plan refusals carry no URL or credential by construction; anything else is sanitised before printing.
    const pgCode = error instanceof BindIdentityError || error instanceof DbTargetError ? undefined : (error as { code?: string })?.code;
    const message = error instanceof Error ? error.message : 'unknown error';
    // eslint-disable-next-line no-console
    console.error(`[${BIND_COMMAND}] refused: ${sanitise(message)}${pgCode ? ` (SQLSTATE ${pgCode})` : ''}`);
    process.exit(error instanceof BindIdentityError && /needs a value|is required|unknown argument|given twice/.test(message) ? 2 : 1);
  });
}
