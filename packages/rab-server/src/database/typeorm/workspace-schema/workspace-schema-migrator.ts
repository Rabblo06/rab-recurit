import { EXPECTED_WORKSPACE_FINGERPRINTS } from './v1/expected-fingerprints';
import {
  BASELINE_WORKSPACE_MODULE_VERSION,
  LATEST_WORKSPACE_MODULE_VERSION,
  moduleChecksum,
  modulesThrough,
  WORKSPACE_SCHEMA_MODULES,
  WorkspaceSchemaModule,
} from './workspace-schema-modules';

/**
 * Wave 2 lane S2 (B3/B4): per-workspace schema migrator + ledger (`core.workspace_schema_migration`).
 *
 * WHO may run it: only the migration / provisioner identity — `crewflow` (table and schema-object owner) or the bootstrap
 * superuser during `migration:run`. Never `crewflow_app`: `assertMigrationIdentity()` refuses it before anything runs, and
 * the database refuses it independently (the runtime role has no INSERT/UPDATE/DELETE on the ledger, owns no workspace
 * table, and has no CREATE on any workspace schema). No HTTP route, resolver or runtime job calls this class.
 *
 * WHAT it does, per `workspace_<32 hex>` schema (one at a time, in workspace-id order):
 *  1. One transaction (or one SAVEPOINT when the caller is already inside a migration transaction) holding
 *     `pg_advisory_xact_lock(hashtext(<schema>))`, `SET LOCAL lock_timeout`, and the registry row `FOR UPDATE`.
 *  2. Only READY workspaces are migrated; PROVISIONING / FAILED ones are SKIPPED (provisioning applies every module itself).
 *  3. A READY workspace with no ledger yet (module_version 0: created before the ledger, or by an old image) is BASELINED
 *     only if its structural fingerprint equals the expected fingerprint of a known module version; otherwise REFUSED
 *     (BASELINE_MISMATCH) and left untouched.
 *  4. Every applied module's recorded checksum must equal the code's; any mismatch → REFUSED (CHECKSUM_MISMATCH), nothing
 *     applied.
 *  5. Pending modules are applied in order (each module's data pre-check first), one APPLIED ledger row each, and the
 *     registry's `module_version` is bumped after every step. Then `core.verify_workspace_schema_v1` and the fingerprint
 *     must match the expected fingerprint of the target version, or the whole schema transaction rolls back.
 *  6. Atomic per schema: a failure rolls back EVERY change to that schema, so a workspace is never left partially upgraded
 *     and is never marked current at a version it does not fully have. The failure is then recorded in a separate
 *     transaction (FAILED / REFUSED ledger row with a safe `error_class`, never the driver message) and the run moves on
 *     to the next schema. Rerunning resumes: applied modules are skipped, the failed one is attempted again (attempt + 1).
 */

/** Minimal query surface: a pg `Client` (`(sql, p) => client.query(sql, p).then(r => r.rows)`) or a TypeORM QueryRunner. */
export interface SqlRunner {
  query(sql: string, params?: unknown[]): Promise<any>;
}

export type WorkspaceMigrationStatus = 'UP_TO_DATE' | 'MIGRATED' | 'BASELINED' | 'SKIPPED' | 'FAILED' | 'REFUSED';

export interface WorkspaceMigrationOutcome {
  workspaceId: string;
  organisationId: string;
  schemaName: string;
  status: WorkspaceMigrationStatus;
  fromVersion: number;
  toVersion: number;
  errorClass?: string;
  moduleId?: string;
}

export interface MigrateOptions {
  /** Apply modules up to and including this version (core migrations pin it). Default: the latest version. */
  throughVersion?: number;
  /** Recorded in the ledger. Default: CREWFLOW_APP_VERSION, else 'unknown'. */
  appVersion?: string;
  /** `SET LOCAL lock_timeout`. Default 5 s: a workspace whose tables are busy fails fast and is retried later. */
  lockTimeoutMs?: number;
  /** 'own' (default): BEGIN/COMMIT per schema. 'savepoint': caller is inside a transaction (a TypeORM migration). */
  txMode?: 'own' | 'savepoint';
  /** Restrict to these workspaces (tests, targeted resume). */
  workspaceIds?: readonly string[];
  /** Refuse unless the migrated schema's fingerprint equals the expected one for the target version. Default true. */
  requireExpectedFingerprint?: boolean;
  /** Test seam only: runs after a module's DDL and before its ledger row. Throwing simulates a failing module. */
  afterModule?: (schemaName: string, module: WorkspaceSchemaModule) => Promise<void>;
}

export class WorkspaceMigrationRefused extends Error {
  constructor(
    readonly errorClass: string,
    readonly moduleId: string,
  ) {
    super(errorClass);
    this.name = 'WorkspaceMigrationRefused';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_APP_VERSION = /^[A-Za-z0-9._:@+\-/]{1,100}$/;

export function workspaceSchemaNameOf(workspaceId: string): string {
  if (!UUID_RE.test(workspaceId)) throw new Error('workspace id is not a canonical uuid');
  return 'workspace_' + workspaceId.replace(/-/g, '');
}

export function resolveAppVersion(explicit?: string): string {
  const v = (explicit ?? process.env.CREWFLOW_APP_VERSION ?? 'unknown').trim();
  return SAFE_APP_VERSION.test(v) ? v : 'unknown';
}

/** Safe error class: our own refusal label, or the SQLSTATE. Never a driver message (it can echo identifiers or values). */
export function errorClassOf(error: unknown): string {
  if (error instanceof WorkspaceMigrationRefused) return error.errorClass;
  const code = (error as { code?: unknown })?.code;
  if (code === '55P03') return 'LOCK_TIMEOUT';
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `SQLSTATE_${code}`;
  return 'INTERNAL';
}

interface RegistryRow {
  status: string;
  module_version: number;
}

export class WorkspaceSchemaMigrator {
  constructor(private readonly db: SqlRunner) {}

  /** Refuses the runtime role and any identity that cannot act as crewflow. */
  async assertMigrationIdentity(): Promise<void> {
    const rows: Array<{ who: string; superuser: boolean; crewflow: boolean }> = await this.db.query(
      `SELECT current_user::text AS who,
              coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user), false) AS superuser,
              EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crewflow') AND pg_catalog.pg_has_role(current_user, 'crewflow', 'USAGE') AS crewflow`,
    );
    const me = rows[0];
    if (!me || me.who === 'crewflow_app' || !(me.superuser || me.crewflow)) {
      throw new Error(
        `WorkspaceSchemaMigrator refuses to run as "${me?.who ?? 'unknown'}": only the migration/provisioner identity (crewflow or the bootstrap superuser) may migrate workspace schemas.`,
      );
    }
  }

  /** Every workspace (id + organisation), via the existing narrow discovery function (crewflow has EXECUTE). */
  async listWorkspaces(only?: readonly string[]): Promise<Array<{ workspaceId: string; organisationId: string }>> {
    const out: Array<{ workspaceId: string; organisationId: string }> = [];
    let after: string | null = null;
    for (;;) {
      const page: Array<{ workspace_id: string; organisation_id: string }> = await this.db.query(
        'SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1, 100)',
        [after],
      );
      for (const r of page) {
        if (!only || only.includes(r.workspace_id)) out.push({ workspaceId: r.workspace_id, organisationId: r.organisation_id });
      }
      if (page.length < 100) break;
      after = page[page.length - 1]!.workspace_id;
    }
    return out;
  }

  async migrateAll(options: MigrateOptions = {}): Promise<WorkspaceMigrationOutcome[]> {
    await this.assertMigrationIdentity();
    const through = options.throughVersion ?? LATEST_WORKSPACE_MODULE_VERSION;
    modulesThrough(through); // validates
    const outcomes: WorkspaceMigrationOutcome[] = [];
    for (const ws of await this.listWorkspaces(options.workspaceIds)) {
      outcomes.push(await this.migrateOne(ws.workspaceId, ws.organisationId, { ...options, throughVersion: through }));
    }
    return outcomes;
  }

  async migrateOne(workspaceId: string, organisationId: string, options: MigrateOptions = {}): Promise<WorkspaceMigrationOutcome> {
    const schemaName = workspaceSchemaNameOf(workspaceId);
    const through = options.throughVersion ?? LATEST_WORKSPACE_MODULE_VERSION;
    modulesThrough(through); // validates the target before anything is opened
    const appVersion = resolveAppVersion(options.appVersion);
    const savepoint = options.txMode === 'savepoint';
    const lockTimeout = Math.max(100, Math.min(options.lockTimeoutMs ?? 5_000, 60_000));
    const base = { workspaceId, organisationId, schemaName };
    let fromVersion = 0;
    let currentModule: WorkspaceSchemaModule | undefined;

    await this.db.query(savepoint ? 'SAVEPOINT workspace_schema_migrate' : 'BEGIN');
    try {
      if (!savepoint) await this.db.query(`SET LOCAL lock_timeout = '${lockTimeout}ms'`);
      await this.bind(organisationId, workspaceId);
      await this.db.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))', [schemaName]);
      const reg: RegistryRow[] = await this.db.query(
        'SELECT status, module_version FROM core.workspace_schema_registry WHERE workspace_id = $1 FOR UPDATE',
        [workspaceId],
      );
      if (reg.length !== 1 || reg[0]!.status !== 'READY') {
        await this.end(savepoint, false);
        return { ...base, status: 'SKIPPED', fromVersion: reg[0]?.module_version ?? 0, toVersion: reg[0]?.module_version ?? 0 };
      }
      fromVersion = Number(reg[0]!.module_version);

      let baselined = false;
      if (fromVersion === 0) {
        currentModule = WORKSPACE_SCHEMA_MODULES[0];
        fromVersion = await this.baseline(workspaceId, organisationId, schemaName, appVersion, through);
        baselined = true;
      }
      currentModule = undefined;
      await this.assertChecksums(workspaceId, fromVersion);

      if (fromVersion >= through) {
        await this.end(savepoint, true);
        return { ...base, status: baselined ? 'BASELINED' : 'UP_TO_DATE', fromVersion, toVersion: fromVersion };
      }

      for (const module of modulesThrough(through).slice(fromVersion)) {
        currentModule = module;
        const started: Array<{ t: string }> = await this.db.query('SELECT pg_catalog.clock_timestamp()::text AS t');
        if (module.precheck) {
          const pre: Array<{ n: number }> = await this.db.query(module.precheck(schemaName));
          if (Number(pre[0]?.n ?? 0) !== 0) throw new WorkspaceMigrationRefused('PRECHECK_VIOLATION', module.id);
        }
        await this.db.query(module.sql(schemaName));
        if (options.afterModule) await options.afterModule(schemaName, module);
        await this.insertLedger(workspaceId, organisationId, schemaName, module, fromVersion, through, 'APPLIED', started[0]!.t, null, appVersion);
        await this.db.query(
          'UPDATE core.workspace_schema_registry SET module_version = $2, last_migrated_at = now() WHERE workspace_id = $1',
          [workspaceId, module.version],
        );
      }
      currentModule = undefined;
      await this.verifyAndRecordFingerprint(workspaceId, through, options.requireExpectedFingerprint ?? true, 'migrated');
      await this.end(savepoint, true);
      return { ...base, status: 'MIGRATED', fromVersion, toVersion: through };
    } catch (error) {
      await this.db.query(savepoint ? 'ROLLBACK TO SAVEPOINT workspace_schema_migrate' : 'ROLLBACK');
      if (savepoint) await this.db.query('RELEASE SAVEPOINT workspace_schema_migrate');
      const errorClass = errorClassOf(error);
      const refused = error instanceof WorkspaceMigrationRefused;
      const moduleId = refused ? error.moduleId : (currentModule?.id ?? modulesThrough(through)[Math.min(fromVersion, through - 1)]!.id);
      await this.recordFailure(workspaceId, organisationId, schemaName, moduleId, fromVersion, through, refused ? 'REFUSED' : 'FAILED', errorClass, appVersion, savepoint);
      return { ...base, status: refused ? 'REFUSED' : 'FAILED', fromVersion, toVersion: fromVersion, errorClass, moduleId };
    }
  }

  /**
   * Called inside the provisioning transaction of a NEW schema (both provisioning paths' TypeScript side), after its
   * modules, binding CHECKs and verification: one APPLIED ledger row per module, module_version and the fingerprint.
   * The caller has already bound rab.organisation_id to the workspace's organisation.
   */
  async recordProvisioned(workspaceId: string, organisationId: string, throughVersion: number, startedAt: string, appVersion?: string): Promise<void> {
    const schemaName = workspaceSchemaNameOf(workspaceId);
    const version = resolveAppVersion(appVersion);
    for (const module of modulesThrough(throughVersion)) {
      await this.insertLedger(workspaceId, organisationId, schemaName, module, 0, throughVersion, 'APPLIED', startedAt, null, version);
    }
    await this.db.query('UPDATE core.workspace_schema_registry SET module_version = $2 WHERE workspace_id = $1', [workspaceId, throughVersion]);
    await this.verifyAndRecordFingerprint(workspaceId, throughVersion, true, 'provisioned');
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async bind(organisationId: string, workspaceId: string): Promise<void> {
    await this.db.query(
      `SELECT pg_catalog.set_config('rab.organisation_id', $1, true), pg_catalog.set_config('rab.workspace_id', $2, true)`,
      [organisationId, workspaceId],
    );
  }

  private async end(savepoint: boolean, commit: boolean): Promise<void> {
    if (savepoint) {
      if (!commit) await this.db.query('ROLLBACK TO SAVEPOINT workspace_schema_migrate');
      await this.db.query('RELEASE SAVEPOINT workspace_schema_migrate');
    } else {
      await this.db.query(commit ? 'COMMIT' : 'ROLLBACK');
    }
  }

  /**
   * Adopts a READY workspace that has no ledger: its fingerprint must equal the expected fingerprint of a known module
   * version v (≤ the run's target and ≤ the baseline ceiling or exactly a later known version). Records BASELINED rows
   * for modules 1..v. Throws REFUSED BASELINE_MISMATCH otherwise.
   */
  private async baseline(workspaceId: string, organisationId: string, schemaName: string, appVersion: string, through: number): Promise<number> {
    const existing: Array<{ n: number }> = await this.db.query(
      'SELECT count(*)::int AS n FROM core.workspace_schema_migration WHERE workspace_id = $1 AND status IN ($2, $3)',
      [workspaceId, 'APPLIED', 'BASELINED'],
    );
    if (Number(existing[0]!.n) !== 0) throw new WorkspaceMigrationRefused('LEDGER_REGISTRY_MISMATCH', WORKSPACE_SCHEMA_MODULES[0]!.id);
    const problem: Array<{ p: string | null }> = await this.db.query('SELECT core.verify_workspace_schema_v1($1) AS p', [workspaceId]);
    if (problem[0]?.p) throw new WorkspaceMigrationRefused('BASELINE_VERIFY_FAILED', WORKSPACE_SCHEMA_MODULES[0]!.id);
    const fp: Array<{ f: string | null }> = await this.db.query('SELECT core.workspace_schema_fingerprint($1) AS f', [workspaceId]);
    const fingerprint = fp[0]?.f ?? null;
    const candidates = Object.entries(EXPECTED_WORKSPACE_FINGERPRINTS)
      .map(([v, f]) => ({ version: Number(v), fingerprint: f }))
      .filter((c) => c.version >= BASELINE_WORKSPACE_MODULE_VERSION && c.version <= Math.max(through, BASELINE_WORKSPACE_MODULE_VERSION));
    const match = candidates.find((c) => c.fingerprint === fingerprint);
    if (!fingerprint || !match) throw new WorkspaceMigrationRefused('BASELINE_MISMATCH', WORKSPACE_SCHEMA_MODULES[0]!.id);
    const started: Array<{ t: string }> = await this.db.query('SELECT pg_catalog.clock_timestamp()::text AS t');
    for (const module of modulesThrough(match.version)) {
      await this.insertLedger(workspaceId, organisationId, schemaName, module, 0, match.version, 'BASELINED', started[0]!.t, null, appVersion);
    }
    await this.db.query(
      `UPDATE core.workspace_schema_registry
          SET module_version = $2, expected_fingerprint = $3, observed_fingerprint = $3, fingerprint_checked_at = now(),
              drift_status = 'OK', drift_detail = NULL
        WHERE workspace_id = $1`,
      [workspaceId, match.version, fingerprint],
    );
    return match.version;
  }

  /** Ledger rows 1..version must exist exactly once as APPLIED/BASELINED with the code's checksum. */
  private async assertChecksums(workspaceId: string, version: number): Promise<void> {
    const rows: Array<{ module_id: string; checksum: string }> = await this.db.query(
      `SELECT module_id, checksum FROM core.workspace_schema_migration WHERE workspace_id = $1 AND status IN ('APPLIED', 'BASELINED')`,
      [workspaceId],
    );
    const recorded = new Map(rows.map((r) => [r.module_id, r.checksum]));
    for (const module of modulesThrough(Math.max(version, 1)).slice(0, version)) {
      const sum = recorded.get(module.id);
      if (sum === undefined) throw new WorkspaceMigrationRefused('LEDGER_GAP', module.id);
      if (sum !== moduleChecksum(module)) throw new WorkspaceMigrationRefused('CHECKSUM_MISMATCH', module.id);
    }
    const known = new Set(WORKSPACE_SCHEMA_MODULES.map((m) => m.id));
    const unknown = rows.find((r) => !known.has(r.module_id));
    if (unknown) throw new WorkspaceMigrationRefused('UNKNOWN_MODULE', unknown.module_id.slice(0, 64));
  }

  private async verifyAndRecordFingerprint(workspaceId: string, version: number, requireExpected: boolean, phase: string): Promise<void> {
    const problem: Array<{ p: string | null }> = await this.db.query('SELECT core.verify_workspace_schema_v1($1) AS p', [workspaceId]);
    const mod = modulesThrough(version)[version - 1]!.id;
    if (problem[0]?.p) throw new WorkspaceMigrationRefused('VERIFY_FAILED', mod);
    const fp: Array<{ f: string | null }> = await this.db.query('SELECT core.workspace_schema_fingerprint($1) AS f', [workspaceId]);
    const fingerprint = fp[0]?.f ?? null;
    const expected = EXPECTED_WORKSPACE_FINGERPRINTS[version];
    if (!fingerprint || (requireExpected && expected !== undefined && fingerprint !== expected)) {
      throw new WorkspaceMigrationRefused(phase === 'provisioned' ? 'PROVISIONED_FINGERPRINT_MISMATCH' : 'FINGERPRINT_MISMATCH', mod);
    }
    await this.db.query(
      `UPDATE core.workspace_schema_registry
          SET expected_fingerprint = $2, observed_fingerprint = $2, fingerprint_checked_at = now(), drift_status = 'OK',
              drift_detail = NULL, migration_error = NULL
        WHERE workspace_id = $1`,
      [workspaceId, fingerprint],
    );
  }

  private async insertLedger(
    workspaceId: string,
    organisationId: string,
    schemaName: string,
    module: WorkspaceSchemaModule,
    previousVersion: number,
    targetVersion: number,
    status: 'APPLIED' | 'BASELINED' | 'FAILED' | 'REFUSED',
    startedAt: string,
    errorClass: string | null,
    appVersion: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO core.workspace_schema_migration
         (workspace_id, organisation_id, schema_name, module_id, version, checksum, previous_version, target_version, attempt,
          status, started_at, completed_at, error_class, app_version)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8,
              coalesce((SELECT max(m.attempt) FROM core.workspace_schema_migration m WHERE m.workspace_id = $1 AND m.module_id = $4), 0) + 1,
              $9, $10::timestamptz, greatest(pg_catalog.clock_timestamp(), $10::timestamptz), $11, $12`,
      [
        workspaceId,
        organisationId,
        schemaName,
        module.id,
        module.version,
        moduleChecksum(module),
        previousVersion,
        Math.max(targetVersion, module.version),
        status,
        startedAt,
        errorClass,
        appVersion,
      ],
    );
  }

  private async recordFailure(
    workspaceId: string,
    organisationId: string,
    schemaName: string,
    moduleId: string,
    fromVersion: number,
    through: number,
    status: 'FAILED' | 'REFUSED',
    errorClass: string,
    appVersion: string,
    savepoint: boolean,
  ): Promise<void> {
    const module = WORKSPACE_SCHEMA_MODULES.find((m) => m.id === moduleId) ?? WORKSPACE_SCHEMA_MODULES[Math.min(fromVersion, through - 1)]!;
    await this.db.query(savepoint ? 'SAVEPOINT workspace_schema_failure' : 'BEGIN');
    try {
      await this.bind(organisationId, workspaceId);
      const started: Array<{ t: string }> = await this.db.query('SELECT pg_catalog.clock_timestamp()::text AS t');
      await this.insertLedger(workspaceId, organisationId, schemaName, module, fromVersion, through, status, started[0]!.t, errorClass, appVersion);
      await this.db.query(
        `UPDATE core.workspace_schema_registry SET migration_error = $2 WHERE workspace_id = $1`,
        [workspaceId, `module ${module.id} ${status.toLowerCase()} (${errorClass})`.slice(0, 500)],
      );
      await this.db.query(savepoint ? 'RELEASE SAVEPOINT workspace_schema_failure' : 'COMMIT');
    } catch {
      // Recording is best-effort: the schema itself is already rolled back, so it fails closed either way.
      await this.db.query(savepoint ? 'ROLLBACK TO SAVEPOINT workspace_schema_failure' : 'ROLLBACK').catch(() => undefined);
      if (savepoint) await this.db.query('RELEASE SAVEPOINT workspace_schema_failure').catch(() => undefined);
    }
  }
}

/** Adapter for a node-postgres Client. */
export function pgClientRunner(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }): SqlRunner {
  return { query: async (sql, params) => (await client.query(sql, params)).rows };
}
