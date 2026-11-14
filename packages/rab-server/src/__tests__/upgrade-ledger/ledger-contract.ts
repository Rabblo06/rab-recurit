/**
 * B2 tests (OWNER-DB-ULTIMATE.md Part B): the ONE place where the upgrade-logbook specs name B1's interface
 * (docs/plans/phase-x3/UPGRADE-LEDGER-INTERFACE.md, DRAFT 2026-11-13).
 *
 * What the owner's prompt and the interface fix (table, columns, statuses, indexes, FK cascade, FORCE RLS, the
 * `rab.upgrade_scope` access rules, SQLSTATEs, exit codes, the R254 / R256 versions, step names) are constants here and are
 * asserted by the specs as written. B1's TypeScript is reached only through `b1()`, which loads B1's modules when they exist
 * on the branch under test and returns null otherwise (then the specs that need it are skipped, never passed). The SQL-only
 * specs run as soon as B1's migration file is on the branch (LEDGER_MIGRATION_ON_BRANCH) and FAIL LOUDLY when the table is
 * then missing from the test database.
 *
 * A member B1 has not yet defined throws `InterfaceGap` with what is missing: a failing test that names the gap, never a skip.
 *
 * Twenty reference (re-implemented, nothing copied), twentyhq/twenty @ eedb0a73:
 *   engine/core-modules/upgrade/upgrade-migration.entity.ts              columns; the two partial unique indexes
 *   engine/core-modules/upgrade/services/upgrade-migration.service.ts:33-110   isLastAttemptCompleted, recordUpgradeMigration
 *   same :150-190                                                              isInitial (markAsWorkspaceInitial)
 *   engine/core-modules/workspace/services/workspace.service.ts:813            a new workspace is marked initial
 *   database/commands/run-instance-commands.command.ts:124-168                the previous-version check, --force
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Client } from 'pg';

const SERVER_SRC = join(__dirname, '..', '..');
export const REPO_ROOT = join(SERVER_SRC, '..', '..', '..');
const UPGRADE_DIR = join(SERVER_SRC, 'engine', 'core-modules', 'upgrade');

/** Interface §1 (stable): the migration. */
export const LEDGER_MIGRATION_FILE = join(SERVER_SRC, 'database', 'typeorm', 'core', 'migrations', '1786721470000-UpgradeMigrationLedger.ts');
export const LEDGER_MIGRATION_NAME = 'UpgradeMigrationLedger1786721470000';
/** True on a branch that carries B1's migration: the SQL specs then run and fail loudly if the table is missing. */
export const LEDGER_MIGRATION_ON_BRANCH = existsSync(LEDGER_MIGRATION_FILE);

export const LEDGER_TABLE = 'core.upgrade_migration';

/** Part B1 + interface §1: Twenty's columns in snake_case, plus `forced`. `error_class` is not in the interface: refused. */
export const EXPECTED_COLUMNS: Readonly<Record<string, { type: string; nullable: boolean; defaultLike?: RegExp }>> = Object.freeze({
  id: { type: 'uuid', nullable: false, defaultLike: /gen_random_uuid\(\)/ },
  name: { type: 'text', nullable: false },
  status: { type: 'text', nullable: false },
  attempt: { type: 'integer', nullable: false },
  executed_by_version: { type: 'text', nullable: false },
  error_message: { type: 'text', nullable: true },
  is_initial: { type: 'boolean', nullable: false },
  workspace_id: { type: 'uuid', nullable: true },
  created_at: { type: 'timestamp with time zone', nullable: false },
  forced: { type: 'boolean', nullable: false },
});
export const OPTIONAL_COLUMNS = new Set<string>([]);

/** Interface §1 (stable) index names. */
export const INDEXES = Object.freeze({
  instanceUq: 'upgrade_migration_instance_uq',
  workspaceUq: 'upgrade_migration_workspace_uq',
  workspaceNameAttempt: 'upgrade_migration_workspace_name_attempt_idx',
  workspaceCreatedAt: 'upgrade_migration_workspace_created_at_idx',
});

/** Part B1 / B3: `completed` | `failed` only. No `started` (a crash leaves no row). */
export const STATUSES = Object.freeze(['completed', 'failed'] as const);
export const REFUSED_STATUSES = Object.freeze(['started', 'running', 'pending', 'COMPLETED', '']);
/** Interface §1: error_message ≤ 4000 characters (CHECK 23514). */
export const ERROR_MESSAGE_MAX = 4000;

/** Interface §1: the transaction-local access setting and its values. */
export const UPGRADE_SCOPE_SETTING = 'rab.upgrade_scope';
export const SCOPES = Object.freeze(['upgrade', 'status', 'workspace_init'] as const);
export type Scope = (typeof SCOPES)[number];
/** The migration advisory lock (migration-lock.ts MIGRATION_LOCK_KEY 0x637265776d696772, "crewmigr"). */
export const MIGRATION_LOCK_KEY_SQL = "x'637265776d696772'::bigint";

/** STARTUP_EXIT_CODES + interface §3: 65 too old / unknown / skipped, 66 migration failed, 70 only a command failed (serves). */
export const EXIT = Object.freeze({ ok: 0, config: 64, behind: 65, migrationFailed: 66, identity: 67, postCheck: 68, lockTimeout: 69, commandFailedServing: 70 });

/** Part B3: R254 = 0.4.0, R256 = 0.5.0, the first release of this work = 0.6.0. */
export const ADOPTION = Object.freeze({ R254: '0.4.0', R256: '0.5.0' } as const);
export const FIRST_LEDGER_VERSION = '0.6.0';
export const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Interface §1: `<MAJOR.MINOR.PATCH>_<Step>[_<13-digit ts>]`. */
export const migrationsStep = (version: string) => `${version}_TypeOrmMigrations`;
export const STEP_NAME_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)_[A-Za-z][A-Za-z0-9]*(_[0-9]{13})?$/;

/** The FK target (interface §1). */
export const EXPECTED_WORKSPACE_TABLE = 'core.manager_workspace';

export interface LedgerRow {
  id: string;
  name: string;
  status: string;
  attempt: number;
  executed_by_version: string;
  error_message: string | null;
  is_initial: boolean;
  workspace_id: string | null;
  created_at: Date;
  forced: boolean;
}

export const LEDGER_SELECT_SQL =
  'SELECT id::text, name, status, attempt, executed_by_version, error_message, is_initial, workspace_id::text, created_at, forced FROM core.upgrade_migration ORDER BY created_at, name, attempt, id';

export type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export interface StartOutcome {
  exitCode: number | null;
  serve: boolean;
  /** From the result line: `failed` when a step failed and the API serves (healthz upgradeFailed:true). */
  upgradeStatus: 'ok' | 'failed' | 'unknown';
  /** The result line's `upgrade` object (interface §3). */
  upgrade: { codeVersion?: string; decision?: string; adoptedFrom?: string | null; forced?: boolean; recorded?: { name: string; status: string; attempt: number }[] } | null;
  lines: string[];
}

export class InterfaceGap extends Error {
  constructor(what: string) {
    super(`B1 interface gap (UPGRADE-LEDGER-INTERFACE.md): ${what}`);
    this.name = 'InterfaceGap';
  }
}

export interface B1Interface {
  currentVersion: string;
  /**
   * stepsForVersion(v) names: the migrations step first, then the version's commands in timestamp order, then (interface
   * §4) the test probe commands `<v>_<Name>_<1799999990000+i>` when `probes` are given.
   */
  stepsOf(version: string, probes?: readonly string[]): string[];
  /** Twenty isLastAttemptCompleted on the version's last step (instance scope), through B1's service on `query`. */
  isVersionComplete(query: Query, version: string, probes?: readonly string[]): Promise<boolean>;
  /** The start path (the migrate-on-start child twenty-migrate.ts) as a CHILD PROCESS; `killOnStep` SIGKILLs it on the step's start event. */
  start(db: string, opts?: { env?: Record<string, string>; killOnMigration?: string; asSuperuser?: boolean }): Promise<StartOutcome & { killed: boolean }>;
  /**
   * The start path IN PROCESS with the target guard seamed to PRODUCTION (the release-floor spec's pattern): the history
   * checks that a local / test target deliberately skips (decideUpgradeStart `unchecked`) apply as in production.
   */
  startProduction(db: string, opts?: { env?: Record<string, string> }): Promise<StartOutcome>;
  /** The manual command's entry (command/upgrade.command.ts runUpgradeCommand) with `args`, in process. */
  upgradeCommand(db: string, args: string[], opts?: { env?: Record<string, string> }): Promise<StartOutcome>;
  /** `upgrade --force`. */
  forceUpgrade(db: string, opts?: { env?: Record<string, string> }): Promise<StartOutcome>;
  /** UPGRADE_COMMANDS[<major>-<minor>] of the current version. */
  upgradeCommands(): { name: string; timestamp: number }[];
  /** Runs one command alone on `db` (run-twice idempotence). */
  runCommand(db: string, name: string): Promise<void>;
  /**
   * upgrade-version-check.ts decideUpgradeStart (pure, Twenty run-instance-commands.command.ts:124-168): returns the
   * decision, or throws (refusal 65 = error name `UpgradeVersionTooOldError`).
   */
  decide(facts: UpgradeStartFactsLike): { kind: string; [k: string]: unknown };
  seams: {
    failMigrationEnv(migrationClass: string): Record<string, string>;
    /** CREWFLOW_TEST_UPGRADE_COMMANDS: no-op probe commands appended to the code version (interface §4). */
    probeEnv(names: readonly string[]): Record<string, string>;
    /** CREWFLOW_TEST_UPGRADE_FAIL_COMMAND: that command fails (recorded failed; exit 70, serves). */
    failCommandEnv(command: string): Record<string, string>;
  };
}

/** Interface §2 `UpgradeStartFacts` (upgrade-version-check.ts), as the specs build it. */
export interface UpgradeStartFactsLike {
  codeVersion: string;
  fresh: boolean;
  force: boolean;
  ledgerExists: boolean;
  hasInstanceRows: boolean;
  complete: Readonly<Record<string, boolean>>;
  newerVersions: readonly string[];
  attribution: { kind: 'release'; release: string; beyond: string[]; remaining: number } | { kind: 'older' | 'unknown'; detail: string } | null;
  unrestrictedTarget: boolean;
  previousVersions?: readonly string[];
}

/**
 * The API's boot gates (database/boot-checks/database-boot-gates.ts runDatabaseBootGates('api')), in process, on `db` as
 * crewflow_owner: what main.js runs after the migrate child exits 0 / 70 and before it serves. The FORCE-RLS spot check,
 * the semantic posture and the schema gate live HERE, not in the migrate child. Returns the refusing gate or null.
 */
export async function apiBootGateRefusal(db: string): Promise<string | null> {
  const gates = require(join(SERVER_SRC, 'database', 'boot-checks', 'database-boot-gates')) as {
    runDatabaseBootGates(p: string, o: Record<string, unknown>): Promise<unknown>;
  };
  try {
    await gates.runDatabaseBootGates('api', {
      env: { NODE_ENV: 'test' },
      connectionEnv: { NODE_ENV: 'test', PG_DATABASE_URL: withDatabase(urls.owner, db) },
      retry: { attempts: 1 },
      log: () => undefined,
    });
    return null;
  } catch (e) {
    const gate = (e as { gate?: unknown }).gate;
    if (e instanceof Error && e.name === 'DatabaseBootGateError' && typeof gate === 'string') return gate;
    throw e;
  }
}

/** Connection URLs, set by the spec (never printed). */
export const urls = { owner: '', admin: '' };

export function withDatabase(base: string, db: string): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

export function loginOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return '';
  }
}

function load<T = Record<string, unknown>>(file: string): T | null {
  const p = join(UPGRADE_DIR, file);
  if (!existsSync(`${p}.ts`) && !existsSync(`${p}.js`)) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(p) as T;
}

const redact = (line: string) => line.replace(/postgres(ql)?:\/\/[^\s'"]+/g, 'postgres://<redacted>');

/** A child process (ts-node --transpile-only, as the repo's migration entrypoints run: never tsx). Output redacted. */
function child(script: string, args: string[], env: NodeJS.ProcessEnv, killOnMigration?: string): Promise<{ code: number | null; killed: boolean; lines: string[]; result: Record<string, unknown> | null }> {
  return new Promise((resolve) => {
    const argv = [require.resolve('ts-node/dist/bin.js'), '--transpile-only', '-P', join(REPO_ROOT, 'packages', 'rab-server', 'tsconfig.app.json'), script, ...args];
    const p = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT });
    const lines: string[] = [];
    let result: Record<string, unknown> | null = null;
    let killed = false;
    let pending = '';
    const onLine = (raw: string) => {
      if (!raw.trim()) return;
      lines.push(redact(raw));
      const r = /TWENTY_MIGRATE_RESULT (\{.*\})\s*$/.exec(raw);
      if (r) {
        try {
          result = JSON.parse(r[1]!);
        } catch {
          result = { state: 'UNPARSEABLE' };
        }
      }
      const ev = /MIGRATION_EVENT (\{.*\})\s*$/.exec(raw);
      if (ev && killOnMigration && !killed) {
        try {
          const e = JSON.parse(ev[1]!) as { event: string; name: string };
          if (e.event === 'start' && e.name === killOnMigration) {
            killed = true;
            p.kill('SIGKILL');
          }
        } catch {
          /* malformed: the assertions catch a missing kill */
        }
      }
    };
    const onData = (b: Buffer) => {
      pending += b.toString('utf8');
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      parts.forEach(onLine);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const timer = setTimeout(() => {
      killed = true;
      p.kill('SIGKILL');
    }, 900_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (pending) onLine(pending);
      resolve({ code, killed, lines, result });
    });
  });
}

function childEnv(url: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'test', PG_DATABASE_URL: url, CREWFLOW_MIGRATE_ON_START: 'true', ...extra };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function outcome(r: { code: number | null; lines: string[]; result: Record<string, unknown> | null }): StartOutcome {
  const res = (r.result ?? {}) as { serve?: boolean; exitCode?: number; upgrade?: StartOutcome['upgrade'] };
  const exitCode = r.code;
  const failedRow = res.upgrade?.recorded?.some((x) => x.status === 'failed') ?? false;
  return {
    exitCode,
    serve: res.serve === true && (exitCode === EXIT.ok || exitCode === EXIT.commandFailedServing),
    upgradeStatus: r.result === null ? 'unknown' : exitCode === EXIT.commandFailedServing || failedRow ? 'failed' : 'ok',
    upgrade: res.upgrade ?? null,
    lines: r.lines,
  };
}

interface MigrateOnStartModule {
  runMigrateOnStart(config: Record<string, unknown>, deps: Record<string, unknown>): Promise<Record<string, unknown>>;
}
interface LockedRunnerModule {
  runLockedMigrations(options: Record<string, unknown>): Promise<unknown>;
}
const STARTUP_EXIT: Record<string, number> = { ok: 0, config: 64, behind: 65, migrationFailed: 66, identity: 67, postCheck: 68, lockTimeout: 69, degradedContinue: 70 };

function inProcessOutcome(r: Record<string, unknown>, lines: string[]): StartOutcome {
  const exitCode = STARTUP_EXIT[String(r.outcome)] ?? null;
  return outcome({ code: exitCode, lines, result: { ...r, exitCode } });
}

/** command/upgrade.command.ts runUpgradeCommand, in process; its stdout lines captured (and redacted), not printed. */
async function runCommandEntry(db: string, args: string[], extra: Record<string, string> = {}): Promise<StartOutcome> {
  const mod = require(join(SERVER_SRC, 'command', 'upgrade.command')) as { runUpgradeCommand(args: string[], env: NodeJS.ProcessEnv): Promise<number> };
  const lines: string[] = [];
  const original = console.log; // eslint-disable-line no-console
  console.log = (...a: unknown[]) => void lines.push(redact(a.map(String).join(' '))); // eslint-disable-line no-console
  let code: number;
  try {
    code = await mod.runUpgradeCommand(args, { NODE_ENV: 'test', PG_DATABASE_URL: withDatabase(urls.owner, db), ...extra } as NodeJS.ProcessEnv);
  } finally {
    console.log = original; // eslint-disable-line no-console
  }
  const res = lines.map((l) => /TWENTY_MIGRATE_RESULT (\{.*\})\s*$/.exec(l)).filter(Boolean).pop();
  let result: Record<string, unknown> | null = null;
  try {
    result = res ? JSON.parse(res[1]!) : null;
  } catch {
    result = null;
  }
  return outcome({ code, lines, result });
}

/** B1's code, when it is on the branch under test; null otherwise. */
export function b1(): B1Interface | null {
  const version = load<{ readAppVersion(env: NodeJS.ProcessEnv): string; majorMinorKey(v: string): string }>('upgrade-version');
  const sequence = load<{ stepsForVersion(v: string): (string | { name: string })[] }>('upgrade-sequence');
  const service = load<{ isLastAttemptCompleted(q: Query, a: { name: string; workspaceId: string | null }): Promise<boolean> }>('upgrade-migration.service');
  if (!version || !sequence || !service || !LEDGER_MIGRATION_ON_BRANCH) return null;
  const check = load<{ decideUpgradeStart(f: UpgradeStartFactsLike): { kind: string; [k: string]: unknown } }>('upgrade-version-check');
  if (!check) return null;
  const registry = load<{ UPGRADE_COMMANDS: Record<string, { name: string; timestamp: number }[]> }>(join('upgrade-commands', 'registry'));
  const migrateEntry = join(SERVER_SRC, 'database', 'typeorm', 'scripts', 'migrate', 'twenty', 'twenty-migrate.ts');
  const currentVersion = version.readAppVersion(process.env);
  const stepsOf = (v: string, probes: readonly string[] = []) => [
    ...sequence.stepsForVersion(v).map((s) => (typeof s === 'string' ? s : s.name)),
    ...(v === currentVersion ? probes.map((name, i) => `${v}_${name}_${1799999990000 + i}`) : []),
  ];
  return {
    currentVersion,
    stepsOf,
    isVersionComplete: async (query, v, probes = []) => {
      // The caller holds an open transaction; the `status` scope (read only) is what the upgrade code reads under.
      // (B1's withUpgradeScope opens and COMMITs its own transaction, which would commit a spec's rolled-back fixture.)
      await query('SELECT pg_catalog.set_config($1, $2, true)', [UPGRADE_SCOPE_SETTING, 'status']);
      const steps = stepsOf(v, probes);
      return service.isLastAttemptCompleted(query, { name: steps[steps.length - 1]!, workspaceId: null });
    },
    start: async (db, opts = {}) => {
      const url = withDatabase(opts.asSuperuser ? urls.admin : urls.owner, db);
      const r = await child(migrateEntry, [], childEnv(url, opts.env), opts.killOnMigration);
      return { ...outcome(r), killed: r.killed };
    },
    startProduction: async (db, opts = {}) => {
      const mos = require(join(SERVER_SRC, 'database', 'typeorm', 'scripts', 'migrate', 'owner-login', 'migrate-on-start')) as MigrateOnStartModule;
      const runnerMod = require(join(SERVER_SRC, 'database', 'typeorm', 'scripts', 'migrate', 'locked-migration-runner')) as LockedRunnerModule;
      const lines: string[] = [];
      const r = await mos.runMigrateOnStart(
        // Part B3: CREWFLOW_UPGRADE_FAILURE / the `continue` policy are removed; the config is the approval mode only.
        { migrationApprovalMode: 'none' },
        {
          env: { NODE_ENV: 'test', PG_DATABASE_URL: withDatabase(urls.owner, db), ...(opts.env ?? {}) },
          log: (l: string) => lines.push(redact(l)),
          runner: (o: Record<string, unknown>) =>
            runnerMod.runLockedMigrations({ ...o, assertTarget: async () => ({ target: 'production', app: { database: db, host: '127.0.0.1' } }), dotenvValues: {} }),
        },
      );
      return inProcessOutcome(r, lines);
    },
    decide: (facts) => check.decideUpgradeStart(facts),
    upgradeCommand: (db, args, opts = {}) => runCommandEntry(db, args, opts.env),
    forceUpgrade: (db, opts = {}) => runCommandEntry(db, ['--force'], opts.env),
    upgradeCommands: () => registry?.UPGRADE_COMMANDS[version.majorMinorKey(currentVersion)] ?? [],
    runCommand: async (db, name) => {
      const cmd = (registry?.UPGRADE_COMMANDS[version.majorMinorKey(currentVersion)] ?? []).find((c) => c.name === name) as
        | { run(ctx: { query: Query; log: (l: string) => void }): Promise<void> }
        | undefined;
      if (!cmd) throw new InterfaceGap(`upgrade command ${name} is not in UPGRADE_COMMANDS`);
      // As the runner does: the owner login, the migration lock held on the session, autocommit.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Client: PgClient } = require('pg') as typeof import('pg');
      const c = new PgClient({ connectionString: withDatabase(urls.owner, db), application_name: 'b2-ledger-run-command' });
      await c.connect();
      try {
        await c.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY_SQL})`);
        await cmd.run({ query: async (sql, params) => (await c.query(sql, params as unknown[])).rows, log: () => undefined });
      } finally {
        await c.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY_SQL})`).catch(() => undefined);
        await c.end();
      }
    },
    seams: {
      failMigrationEnv: (migrationClass) => ({ CREWFLOW_MIGRATION_TEST_FAIL_AT: migrationClass }),
      probeEnv: (names) => ({ CREWFLOW_TEST_UPGRADE_COMMANDS: names.join(',') }),
      failCommandEnv: (command) => ({ CREWFLOW_TEST_UPGRADE_FAIL_COMMAND: command }),
    },
  };
}

/** Puts `client` (crewflow_owner, inside an OPEN transaction) into a scope (interface §1: transaction-local). */
export async function setScope(client: Client, scope: string): Promise<void> {
  await client.query('SELECT set_config($1, $2, true)', [UPGRADE_SCOPE_SETTING, scope]);
}
