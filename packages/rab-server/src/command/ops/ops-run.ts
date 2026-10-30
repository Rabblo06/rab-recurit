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
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseDotenv } from 'dotenv';

import {
  currentPgProcessRole,
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
    throw new OpsRunError(
      `"${command}" runs only in the one-off operations container (${OPS_RUN_VAR}=${OPS_RUN_VALUE}, ${OPS_APP_DATABASE_URL_VAR}, the operator label). See the ops section of docs/runbooks/database.md.`,
    );
  } else {
    const held = OPS_ONLY_ENV_NAMES.filter((name) => present(env, name) !== undefined);
    if (held.length > 0) throw new OpsRunError(`ordinary CLI commands refuse the operations-container variable(s) ${held.join(', ')}.`);
  }
  setPgProcessRole(role);
  return role;
}

/** The operational audit label, exactly as recorded in audit metadata (key `operationalLabel`). */
export interface OpsOperationalLabel {
  kind: 'operational-label';
  note: typeof OPS_LABEL_NOTE;
  actorSource: OpsActorSource;
  actorId: string;
  changeRef: string;
  command: OpsCommand;
  mode: string;
  /** Random per run: ties the run's audit rows, its log and its console output together. */
  runId: string;
}

/** Reads and validates the three label variables. Refuses absent or malformed values (names only in the message). */
export function readOpsOperationalLabel(env: Record<string, string | undefined>, command: OpsCommand, mode: string): OpsOperationalLabel {
  const [sourceVar, idVar, refVar] = OPS_ACTOR_ENV_NAMES;
  const missing = OPS_ACTOR_ENV_NAMES.filter((name) => present(env, name) === undefined);
  if (missing.length > 0) {
    throw new OpsRunError(
      `every ops command requires the operator label ${OPS_ACTOR_ENV_NAMES.join(', ')} (missing: ${missing.join(', ')}). Set them from the deployment platform's job identity and the approved change reference.`,
    );
  }
  const actorSource = present(env, sourceVar)!;
  if (!(OPS_ACTOR_SOURCES as readonly string[]).includes(actorSource)) {
    throw new OpsRunError(`${sourceVar} must be one of ${OPS_ACTOR_SOURCES.join(', ')}.`);
  }
  const actorId = present(env, idVar)!;
  if (!ACTOR_ID_PATTERN.test(actorId)) {
    throw new OpsRunError(`${idVar} must be 1-200 printable characters without whitespace (letters, digits, . _ : @ / + = -), starting with a letter or digit.`);
  }
  const changeRef = present(env, refVar)!;
  if (!CHANGE_REF_PATTERN.test(changeRef)) {
    throw new OpsRunError(`${refVar} must be 1-120 characters (letters, digits, . _ : # / + -), starting with a letter or digit.`);
  }
  return {
    kind: 'operational-label',
    note: OPS_LABEL_NOTE,
    actorSource: actorSource as OpsActorSource,
    actorId,
    changeRef,
    command,
    mode,
    runId: randomUUID(),
  };
}

/**
 * The ops values must come from the one-off container's own environment, never a `.env` file (dotenv/config loads
 * `<cwd>/.env` into process.env before anything runs). A `.env` that defines any ops name or PG_DATABASE_URL refuses.
 */
export function assertOpsValuesNotFromDotenv(cwd: string = process.cwd(), read: (path: string) => string | null = readIfExists): void {
  const content = read(resolve(cwd, '.env'));
  if (content === null) return;
  const parsed = parseDotenv(content);
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
): OpsOperationalLabel {
  if (currentPgProcessRole() !== 'ops' || !resolved.ops || resolved.processRole !== 'ops') {
    throw new OpsRunError(`"${command}" runs only in the one-off operations container (${OPS_RUN_VAR}=${OPS_RUN_VALUE}).`);
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

/** One sanitised console line: the label (it is not secret) and the run id. */
export function describeOpsLabel(label: OpsOperationalLabel): string {
  return `[ops] command=${label.command} mode=${label.mode} run=${label.runId} actor_source=${label.actorSource} actor_id=${label.actorId} change_ref=${label.changeRef} (${OPS_LABEL_NOTE})`;
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
