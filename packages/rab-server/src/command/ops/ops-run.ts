/**
 * Phase B (owner-approved "operations commands"): the one-off OPERATIONS container rules for the three owner CLI commands
 * (`containment:suspend-test-accounts`, `hws:backfill`, `user-session:backfill`).
 *
 * Where they run: ONLY in a one-off ops container (same pattern as rab-migrate: `restart: "no"`, run once, removed), never in
 * the API or the Worker. The container's own environment holds:
 *   CREWFLOW_OPS_RUN=one-off        declares the ops process (pg-config.ts resolveOpsMode)
 *   PG_OPS_APP_DATABASE_URL         the ordinary restricted runtime login (crewflow_app): the CLI's primary connection, the
 *                                   boot gates and every tenant-context write. Not a new privileged credential.
 *   PG_DATABASE_URL                 the migration identity (crewflow_migrator) — ONLY for the command/mode that needs a
 *                                   verified elevated session (elevated-ops-session.ts); refused for every other mode.
 *   CREWFLOW_OPS_ACTOR_SOURCE       github-actions | gitlab-ci | manual-console
 *   CREWFLOW_OPS_ACTOR_ID           e.g. the CI OIDC subject, the run id, or the deploy user
 *   CREWFLOW_OPS_CHANGE_REF         the ticket / PR / change reference that approved the run
 * plus DB_TARGET (and in production ALLOW_PRODUCTION_DB_COMMANDS and the deployment identity), exactly as rab-migrate.
 *
 * The three actor values are an OPERATIONAL AUDIT LABEL, NOT a database-verified human identity: they are whatever the
 * container environment says. They are required (refused when absent or malformed) and recorded verbatim in the audit
 * metadata of every row the operation writes, marked as such. Accountability for WHO ran the command comes from the
 * deployment platform's own controls (protected environments, required reviewers, manual approval jobs) — see the ops
 * section of docs/runbooks/database.md.
 *
 * Enforcement layers: main.ts refuses an ops command outside the ops container and any other command inside it
 * (assertOpsPlacement); every ops command's run() calls assertOpsRun again (layer 2: a command body can be reached without
 * main.ts, e.g. from a test or another module); pg-config.ts refuses every ops variable in every other process.
 *
 * Phase X2.2 (owner decision 2026-11-12, "the Twenty way": every command runs from the same image under the one login):
 * the same three commands ALSO run on the ordinary CLI path, as a one-off of the API service
 * (`docker compose run --rm --no-deps rab-api node packages/rab-server/dist/command/main.js <command> ...`), under the owner
 * login crewflow_owner and nothing else. This is the OWNER-LOGIN path (OpsRunPath 'owner-login'):
 *   - layer 1 (main.ts, assertOpsPlacement, before any connection): PG_DATABASE_URL must name exactly crewflow_owner, and
 *     no legacy database variable and no operations-container variable may be set. Any other login is refused;
 *   - the CLI boot gates (gate 1: session_user = current_user = crewflow_owner, plus the owner-login posture) run before
 *     any command body, as for every CLI command;
 *   - layer 2 (assertOpsRun, the first statement of run()): the CLI process, PG_DATABASE_URL = crewflow_owner, no second
 *     endpoint, and the operator label from the command's own flags (`--operator "<name>"` and `--change-ref`, required;
 *     `--operator-source` optional, default manual-console); then each command re-verifies the login ON the database
 *     (elevated-ops-session.ts verifyOpsAppSession) before its first data statement.
 * The cross-tenant steps keep the FROZEN statement lists (ops-statements.ts): crewflow_owner narrows itself with
 * `SET LOCAL ROLE rab_secure_owner` (a role it already holds with SET; no grant is added) in a verified transaction on its
 * own one-connection pool. The rab-ops container path above stays, unchanged, until the separated-mode clean-up (X5.1).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { OWNER_LOGIN_ROLE } from '../../database/boot-checks/owner-login-posture';
import { nxDotenvPaths, readDotenvFilesValues, WORKSPACE_ROOT } from '../../database/typeorm/core/nx-dotenv-files';
import { parsePgUrl } from '../../database/postgres/pg-url-policy';
import {
  currentPgProcessRole,
  LEGACY_PG_ENV_NAMES,
  LIBPQ_ENV_NAMES,
  OPS_ACTOR_ENV_NAMES,
  OPS_APP_DATABASE_URL_VAR,
  OPS_ONLY_ENV_NAMES,
  OPS_RUN_VALUE,
  OPS_RUN_VAR,
  PgProcessRole,
  ResolvedPgEnvironment,
  setPgProcessRole,
} from '../../database/postgres/pg-config';

export const OPS_COMMANDS = ['containment:suspend-test-accounts', 'hws:backfill', 'user-session:backfill'] as const;
export type OpsCommand = (typeof OPS_COMMANDS)[number];

export const OPS_ACTOR_SOURCES = ['github-actions', 'gitlab-ci', 'manual-console'] as const;
export type OpsActorSource = (typeof OPS_ACTOR_SOURCES)[number];

/** The fixed note every audit label carries, so no reader mistakes it for a verified identity. */
export const OPS_LABEL_NOTE = 'operational label, not database-verified identity';

/**
 * Where an ops run executes: the separated-mode one-off operations container (rab-ops, until X5.1), or the ordinary CLI as
 * a one-off of the API service under the owner login crewflow_owner (X2.2). Set by the code and recorded in every label.
 */
export type OpsRunPath = 'ops-container' | 'owner-login';

/**
 * The owner-login path's operator label flags (owner decision 2026-11-12, G1 option c): `--operator "<name>"` and
 * `--change-ref <ref>` are REQUIRED; `--operator-source` is optional and defaults to `manual-console`.
 */
export const OPS_LABEL_FLAGS = ['--operator', '--change-ref', '--operator-source'] as const;
export const OPS_REQUIRED_LABEL_FLAGS = ['--operator', '--change-ref'] as const;
export const OPS_DEFAULT_OPERATOR_SOURCE: OpsActorSource = 'manual-console';

/** The parsed label flags (nest-commander camel-cases the flag names). */
export interface OpsLabelFlags {
  operator?: string;
  changeRef?: string;
  operatorSource?: string;
}

/**
 * `--operator "<name>"`: a person's or job's name, spaces allowed. After trimming: 1-200 characters (code points); the first
 * a letter or digit; then only letters, combining marks, digits, spaces and . _ : @ / + = ' , ( ) -. So no newline, tab or
 * other control character, no format character (bidi overrides, zero-width), no quote that could break a log line. The
 * value is only ever stored as data (a field of the audit row's jsonb metadata, written through a bound parameter) and
 * printed JSON-quoted; it is never interpolated into SQL.
 */
const OPERATOR_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._:@/+=',()-]*$/u;
const OPERATOR_NAME_MAX = 200;

/** A CI OIDC subject (`repo:org/repo:environment:production`), a run id, a deploy user: printable, no whitespace. */
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,199}$/;
/** A ticket / PR / change reference: `OPS-123`, `org/repo#456`, `CHG0012345`. */
const CHANGE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:#/+-]{0,119}$/;

export class OpsRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpsRunError';
  }
}

export function isOpsCommand(name: string | undefined): name is OpsCommand {
  return name !== undefined && (OPS_COMMANDS as readonly string[]).includes(name);
}

function present(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/** The process role the CLI declares before anything resolves a connection (ops when CREWFLOW_OPS_RUN is set). */
export function cliProcessRoleFor(env: Record<string, string | undefined>): PgProcessRole {
  return present(env, OPS_RUN_VAR) !== undefined ? 'ops' : 'cli';
}

/**
 * main.ts, before any connection: an ops command runs only in the ops container, and the ops container runs only ops
 * commands (no seed, bootstrap-admin, ... with the ops environment). Declares the process role. Throws OpsRunError.
 */
export function assertOpsPlacement(command: string | undefined, env: Record<string, string | undefined>): PgProcessRole {
  const role = cliProcessRoleFor(env);
  if (role === 'ops') {
    if (present(env, OPS_RUN_VAR) !== OPS_RUN_VALUE) {
      throw new OpsRunError(`${OPS_RUN_VAR} must be exactly "${OPS_RUN_VALUE}".`);
    }
    if (!isOpsCommand(command)) {
      throw new OpsRunError(
        `the one-off operations container runs only ${OPS_COMMANDS.join(', ')}; "${command ?? '(none)'}" is an ordinary CLI command. Run it without the ops environment.`,
      );
    }
  } else if (isOpsCommand(command)) {
    // X2.2 owner-login path: allowed only when the one login is crewflow_owner (verified on the database again by the boot
    // gates and by the command itself before any data statement).
    assertOwnerLoginOpsEnvironment(command, env);
  } else {
    const held = OPS_ONLY_ENV_NAMES.filter((name) => present(env, name) !== undefined);
    if (held.length > 0) throw new OpsRunError(`ordinary CLI commands refuse the operations-container variable(s) ${held.join(', ')}.`);
  }
  setPgProcessRole(role);
  return role;
}

/**
 * The user PG_DATABASE_URL connects as, read by THE SAME parser pg-config.ts uses for the connection (parsePgUrl: the user
 * the pool will send, after its query-parameter refusals such as `?user=` and `options=-c role=`). One parser, so this
 * check can never disagree with the login actually used. Throws OpsRunError with the parser's credential-free reason.
 */
function urlUser(command: OpsCommand, raw: string): string {
  try {
    return parsePgUrl(raw, 'PG_DATABASE_URL').user;
  } catch (error) {
    const reason = error instanceof Error && error.name === 'PgConfigError' ? error.message : 'PG_DATABASE_URL could not be parsed (value not shown).';
    throw new OpsRunError(`"${command}" refuses PG_DATABASE_URL: ${reason}`);
  }
}

/**
 * X2.2, layer 1 (pure, before any connection): an ops command on the ordinary CLI path runs only under the owner login.
 * PG_DATABASE_URL must name exactly crewflow_owner. Refused in EVERY environment (pg-config.ts refuses some of these in
 * production only): any operations-container variable (the label comes from the command's flags), any legacy database
 * variable (DATABASE_URL, DATABASE_URL_UNPOOLED, DATABASE_DIRECT_URL, DB_POOL_MAX), any libpq variable (PGOPTIONS, PGUSER,
 * ...: node-postgres reads some of them as silent fallbacks, e.g. a session role), and PG_DATABASE_REPLICA_URL (the ops
 * commands have no replica path, as the ops container: pg-config.ts). Exactly one endpoint. Throws OpsRunError; the
 * message names variables and the login only.
 */
export function assertOwnerLoginOpsEnvironment(command: OpsCommand, env: Record<string, string | undefined>): void {
  const held = OPS_ONLY_ENV_NAMES.filter((name) => present(env, name) !== undefined);
  if (held.length > 0) {
    throw new OpsRunError(
      `"${command}" on the owner-login path refuses the operations-container variable(s) ${held.join(', ')}: pass the operator label as ${OPS_LABEL_FLAGS.join(', ')}.`,
    );
  }
  const legacy = LEGACY_PG_ENV_NAMES.filter((name) => present(env, name) !== undefined);
  if (legacy.length > 0) {
    throw new OpsRunError(`"${command}" runs only on PG_DATABASE_URL (the owner login); remove the legacy database variable(s) ${legacy.join(', ')}.`);
  }
  const libpq = LIBPQ_ENV_NAMES.filter((name) => present(env, name) !== undefined);
  if (libpq.length > 0) {
    throw new OpsRunError(`"${command}" refuses libpq environment variable(s) ${libpq.join(', ')} in every environment: put everything in PG_DATABASE_URL.`);
  }
  if (present(env, 'PG_DATABASE_REPLICA_URL') !== undefined) {
    throw new OpsRunError(`"${command}" refuses PG_DATABASE_REPLICA_URL: the ops commands have no replica path.`);
  }
  const raw = present(env, 'PG_DATABASE_URL');
  if (raw === undefined) throw new OpsRunError(`"${command}" requires PG_DATABASE_URL naming the owner login ${OWNER_LOGIN_ROLE}.`);
  const user = urlUser(command, raw);
  if (user !== OWNER_LOGIN_ROLE) {
    throw new OpsRunError(`"${command}" runs only under the owner login ${OWNER_LOGIN_ROLE}; PG_DATABASE_URL names "${user}". Refusing.`);
  }
}

/** The operational audit label, exactly as recorded in audit metadata (key `operationalLabel`). */
export interface OpsOperationalLabel {
  kind: 'operational-label';
  note: typeof OPS_LABEL_NOTE;
  actorSource: OpsActorSource;
  /** Owner-login path: the `--operator "<name>"` value; ops container: CREWFLOW_OPS_ACTOR_ID. An operator CLAIM (see `note`). */
  actorId: string;
  changeRef: string;
  command: OpsCommand;
  mode: string;
  /** Which path ran the command (set by the code, not by the operator). */
  path: OpsRunPath;
  /** Random per run: ties the run's audit rows, its log and its console output together. */
  runId: string;
}

function presentValue(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

function missingLabel(names: readonly string[], missing: readonly string[]): never {
  throw new OpsRunError(
    `every ops command requires the operator label ${names.join(', ')} (missing: ${missing.join(', ')}). Set them from the deployment platform's job identity and the approved change reference.`,
  );
}

function assertActorSource(value: string, name: string): OpsActorSource {
  if (!(OPS_ACTOR_SOURCES as readonly string[]).includes(value)) throw new OpsRunError(`${name} must be one of ${OPS_ACTOR_SOURCES.join(', ')}.`);
  return value as OpsActorSource;
}

function assertChangeRef(value: string, name: string): string {
  if (!CHANGE_REF_PATTERN.test(value)) throw new OpsRunError(`${name} must be 1-120 characters (letters, digits, . _ : # / + -), starting with a letter or digit.`);
  return value;
}

function label(actorSource: OpsActorSource, actorId: string, changeRef: string, command: OpsCommand, mode: string, path: OpsRunPath): OpsOperationalLabel {
  return { kind: 'operational-label', note: OPS_LABEL_NOTE, actorSource, actorId, changeRef, command, mode, path, runId: randomUUID() };
}

/** The ops container: reads and validates the three label variables. Refuses absent or malformed values (names only in the message). */
export function readOpsOperationalLabel(env: Record<string, string | undefined>, command: OpsCommand, mode: string): OpsOperationalLabel {
  const [sourceVar, idVar, refVar] = OPS_ACTOR_ENV_NAMES;
  const values = [presentValue(env[sourceVar]), presentValue(env[idVar]), presentValue(env[refVar])];
  const missing = OPS_ACTOR_ENV_NAMES.filter((_, i) => values[i] === undefined);
  if (missing.length > 0) missingLabel(OPS_ACTOR_ENV_NAMES, missing);
  const [source, actorId, changeRef] = values as [string, string, string];
  if (!ACTOR_ID_PATTERN.test(actorId)) {
    throw new OpsRunError(`${idVar} must be 1-200 printable characters without whitespace (letters, digits, . _ : @ / + = -), starting with a letter or digit.`);
  }
  return label(assertActorSource(source, sourceVar), actorId, assertChangeRef(changeRef, refVar), command, mode, 'ops-container');
}

/**
 * X2.2 owner-login path: the label from the command's flags. `--operator` and `--change-ref` are required;
 * `--operator-source` defaults to manual-console. The operator name is recorded as `actorId` (the same audit field as the
 * container's CREWFLOW_OPS_ACTOR_ID), with the fixed note that it is an operator claim, not a verified identity.
 */
export function readOpsLabelFromFlags(flags: OpsLabelFlags, command: OpsCommand, mode: string): OpsOperationalLabel {
  const operator = presentValue(flags.operator);
  const changeRef = presentValue(flags.changeRef);
  const missing = OPS_REQUIRED_LABEL_FLAGS.filter((_, i) => [operator, changeRef][i] === undefined);
  if (missing.length > 0) missingLabel(OPS_REQUIRED_LABEL_FLAGS, missing);
  if ([...operator!].length > OPERATOR_NAME_MAX || !OPERATOR_NAME_PATTERN.test(operator!)) {
    throw new OpsRunError(
      `--operator must be 1-${OPERATOR_NAME_MAX} characters: a letter or digit first, then letters, digits, spaces and . _ : @ / + = ' , ( ) - only (no newline, tab or other control character).`,
    );
  }
  const source = flags.operatorSource === undefined ? OPS_DEFAULT_OPERATOR_SOURCE : assertActorSource(flags.operatorSource.trim(), '--operator-source');
  return label(source, operator!, assertChangeRef(changeRef!, '--change-ref'), command, mode, 'owner-login');
}

function anyLabelFlag(flags: OpsLabelFlags): boolean {
  return [flags.operator, flags.changeRef, flags.operatorSource].some((v) => v !== undefined);
}

/**
 * The ops values must come from the one-off container's own environment, never a `.env` file (dotenv/config loads
 * `<cwd>/.env` into process.env before anything runs; final review F6: `nx run rab-server:command` injects every dotenv
 * file of nx-dotenv-files.ts as well). Any of those files that defines an ops name or PG_DATABASE_URL refuses.
 */
export function assertOpsValuesNotFromDotenv(cwd: string = process.cwd(), read: (path: string) => string | null = readIfExists): void {
  const parsed = readDotenvFilesValues([resolve(cwd, '.env'), ...nxDotenvPaths([WORKSPACE_ROOT, cwd])], read);
  const fromFile = [...OPS_ONLY_ENV_NAMES, 'PG_DATABASE_URL'].filter((name) => parsed[name] !== undefined && parsed[name].trim() !== '');
  if (fromFile.length > 0) {
    throw new OpsRunError(
      `the ops value(s) ${fromFile.join(', ')} are present in a .env file. Ops credentials and the operator label must come from the one-off container's environment only.`,
    );
  }
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Whether this command + mode needs the verified elevated session (and therefore PG_DATABASE_URL). */
export interface OpsElevatedRequirement {
  needsElevated: boolean;
}

/**
 * Layer 2, the first statement of every ops command's run(): the ops process, the label, the .env rule, and the
 * minimum-privilege endpoint rule — PG_DATABASE_URL (the migration identity) must be present exactly when this mode
 * needs the elevated session, and absent otherwise (do not hand over a credential the mode does not use).
 */
export function assertOpsRun(
  command: OpsCommand,
  mode: string,
  requirement: OpsElevatedRequirement,
  resolved: ResolvedPgEnvironment,
  env: Record<string, string | undefined> = process.env,
  flags: OpsLabelFlags = {},
): OpsOperationalLabel {
  if (!resolved.ops && resolved.processRole !== 'ops' && currentPgProcessRole() !== 'ops') {
    return assertOwnerLoginOpsRun(command, mode, resolved, env, flags);
  }
  if (currentPgProcessRole() !== 'ops' || !resolved.ops || resolved.processRole !== 'ops') {
    throw new OpsRunError(`"${command}" runs only in the one-off operations container (${OPS_RUN_VAR}=${OPS_RUN_VALUE}) or on the owner-login CLI path.`);
  }
  if (anyLabelFlag(flags)) {
    throw new OpsRunError(`in the one-off operations container the operator label comes from ${OPS_ACTOR_ENV_NAMES.join(', ')}; remove ${OPS_LABEL_FLAGS.join(' / ')}.`);
  }
  assertOpsValuesNotFromDotenv();
  const label = readOpsOperationalLabel(env, command, mode);
  if (requirement.needsElevated && !resolved.elevated) {
    throw new OpsRunError(`"${command} ${mode}" needs the verified elevated session: set PG_DATABASE_URL (the migration identity) in the ops container.`);
  }
  if (!requirement.needsElevated && resolved.elevated) {
    throw new OpsRunError(
      `"${command} ${mode}" runs entirely as the restricted runtime login (${OPS_APP_DATABASE_URL_VAR}). Remove PG_DATABASE_URL (the migration identity) from this run: minimum privilege.`,
    );
  }
  return label;
}

/**
 * X2.2 layer 2 on the owner-login path: the ordinary CLI process (never the API, the Worker or the provisioner), the one
 * endpoint PG_DATABASE_URL naming crewflow_owner (no second endpoint, no ops variable), and the label from the flags.
 * The database facts (session_user = current_user = crewflow_owner) are verified next by verifyOpsAppSession, before the
 * first data statement. `needsElevated` changes nothing here: the narrowed session uses the same login.
 */
function assertOwnerLoginOpsRun(
  command: OpsCommand,
  mode: string,
  resolved: ResolvedPgEnvironment,
  env: Record<string, string | undefined>,
  flags: OpsLabelFlags,
): OpsOperationalLabel {
  if (currentPgProcessRole() !== 'cli' || resolved.processRole !== 'cli') {
    throw new OpsRunError(`"${command}" runs only as a one-off CLI command (dist/command/main.js), never inside the ${resolved.processRole} process.`);
  }
  assertOwnerLoginOpsEnvironment(command, env);
  if (resolved.primary.source !== 'PG_DATABASE_URL' || resolved.primary.target.user !== OWNER_LOGIN_ROLE) {
    throw new OpsRunError(`"${command}" runs only under the owner login ${OWNER_LOGIN_ROLE} named by PG_DATABASE_URL. Refusing.`);
  }
  // Defence in depth: outside the ops container the only source of `resolved.elevated` is DATABASE_URL_UNPOOLED, which
  // assertOwnerLoginOpsEnvironment above already refuses, so this is reachable only when a caller passes a `resolved`
  // built from a different environment than `env` (a direct call from other code or a test). Kept so a second endpoint
  // can never reach the run whatever the caller passes.
  if (resolved.elevated !== null) {
    throw new OpsRunError(`"${command}" on the owner-login path uses the one login only; a second database endpoint (${resolved.elevated.source}) is refused.`);
  }
  return readOpsLabelFromFlags(flags, command, mode);
}

/** One sanitised console line: the label (it is not secret) and the run id. */
export function describeOpsLabel(label: OpsOperationalLabel): string {
  return `[ops] command=${label.command} mode=${label.mode} path=${label.path} run=${label.runId} actor_source=${label.actorSource} operator=${JSON.stringify(label.actorId)} change_ref=${label.changeRef} (${OPS_LABEL_NOTE})`;
}

/** What the run verified on its database sessions (these ARE database facts, unlike the label). */
export interface OpsDatabaseVerified {
  appLogin: string;
  elevatedLogin?: string;
  elevatedRole?: string;
  identity: string;
}

/**
 * The audit metadata every row an ops run writes carries: the label verbatim under `operationalLabel` (with its fixed
 * note), and the verified database facts under `databaseVerified`.
 */
export function opsAuditMetadata(label: OpsOperationalLabel, verified: OpsDatabaseVerified): Record<string, unknown> {
  return {
    operationalLabel: { ...label },
    databaseVerified: { ...verified, note: 'session roles verified by the ops command before it wrote; the label above is not' },
  };
}
