import { Injectable, Optional } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { installSessionRoleResetOnDataSource, RESET_ROLE_SQL } from '../../../database/postgres/session-role-reset';
import { databaseMetrics, DbPoolName } from '../../../database/runtime/database-metrics';
import { PgReplicaService } from '../../../database/runtime/replica/pg-replica.service';
import { EnvironmentService } from '../environment/environment.service';
import { timeStage } from '../../observability/request-context';
import { AuthContext } from './auth-context.interface';
import { bindBusinessSchema, BusinessTablesError, businessSearchPath, CORE_BUSINESS_SCHEMA, peekBusinessSchema, withBusinessSchema, withBusinessSchemaScope } from './business-tables';
import { SchemaResolverService, WorkspaceRoutingError } from './schema-resolver.service';
import { bindEntityManagerToSchema } from './schema-bound-entity-manager';
import { isUpgradeBlocked } from '../upgrade/workspace-upgrade-block';
import { CUTOVER_ROUTING_COLUMNS_SQL, cutoverStateRefused } from '../upgrade/hws-cutover-routing';

/**
 * Binds the request's tenant/actor identity into the Postgres session so
 * RLS policies (rab-workforce-architecture.md §5.7) can enforce it as a
 * second, database-level line of defence behind the guard → service →
 * org-scope-query chain (§5.2). Every service method that touches a
 * tenant-scoped table runs inside `runInTenantContext`, not a bare
 * `dataSource.manager` call.
 *
 * HWS runtime cutover (Part 2): search_path is ALWAYS set explicitly here, transaction-local, never left to whatever a
 * pooled connection happened to have before. There are exactly three cases, and they are mutually exclusive — never a
 * fallback chain like 'workspace, core':
 *   1. HWS_RUNTIME_ENABLED is false (legacy/compat deployments): search_path = 'core'. This is the same effective
 *      routing the removed DataSource-level `schema: 'core'` default gave every unqualified entity before Part 2.
 *   2. HWS_RUNTIME_ENABLED is true and ctx.workspaceId is set: the trusted physical schema is resolved from the
 *      registry (SchemaResolverService — FORCE RLS, fail closed if the workspace is missing, not READY, or an
 *      unsupported version) and search_path is set to EXACTLY that schema. No core fallback: a not-READY workspace
 *      throws here, before any business query runs.
 *   3. HWS_RUNTIME_ENABLED is true and ctx.workspaceId is null (a workspace-less actor — CEO/admin, pre-onboarding
 *      Manager, login/session resolution): search_path = 'core'. Such a caller was never routable to a workspace
 *      table in the first place (RequireWorkspaceGuard already refuses those endpoints); this only keeps core-only
 *      entity calls (ManagerProfile, ManagerWorkspace, ...) resolving exactly as before.
 *
 * Core entities (explicit `schema: 'core'`) and explicitly `core.`-qualified raw SQL are never affected by any of this.
 *
 * Part C2-1: the manager handed to the callback is SCHEMA-BOUND (schema-bound-entity-manager.ts): its entity metadata carries
 * the schema just recorded for businessTables() and bound as search_path, so the 14 workspace entities issue
 * `"<schema>"."<table>"` themselves instead of relying on search_path. Same connection, same transaction, same GUCs; only the
 * entity SQL text changes. Raw SQL through `manager.query` still resolves bare table names through search_path until its
 * own C2 PR (or uses businessTables(), which is bound on the handed-out manager too).
 *
 * `runInTenantContext` is the general-purpose entry point (core/global services, and anything that may legitimately
 * run with no workspace bound). `runInWorkspaceContext` (below) is the stricter boundary for the 15 physical
 * workspace-business tables: it requires a workspace and fails closed if one isn't bound, so a workspace-domain
 * service can never silently fall through to case 3 and operate on `core` because no workspace happened to be set.
 *
 * Phase B (B4/P5) — `{ useReplica: true }` (both entry points). Opt-in ONLY for the reads in the replica register
 * (src/database/runtime/replica/replica-read-register.ts; its spec fails on any other call site). Such a read:
 *   - runs in a READ ONLY transaction (first statement `SET TRANSACTION READ ONLY`) on the replica when PgReplicaService
 *     says it is validated and fresh, otherwise on the PRIMARY — also READ ONLY, so a hidden write in a registered read
 *     fails with 25006 everywhere (development without a replica included), never only in production;
 *   - binds exactly the same transaction-local GUCs (set_config(..., true)) and search_path, so RLS (FORCE) applies on
 *     the replica exactly as on the primary; nothing session-scoped is ever set;
 *   - with HWS_RUNTIME_ENABLED and a workspace, resolves the workspace schema on the PRIMARY first (a short read-only
 *     transaction, finished before the replica one opens — sequential, never nested), so a replica-lagged registry row is
 *     never what fills the workspace-metadata cache or picks the schema;
 *   - is re-run once on the primary when the replica transaction fails with a connection, recovery-conflict or
 *     not-yet-replayed-relation error (safe: the failed attempt was read-only).
 * Writes, auth/session/MFA/permission resolution, payroll, audit log, admin panel and read-your-writes paths never pass
 * the option (the register lists why).
 */
/**
 * Owner-login pool safety (M0 §6.4 control 3, G-09): the session acted as another role when a tenant transaction started —
 * a session-level SET ROLE survived from an earlier request, or something re-set it. Thrown before the tenant is bound, so
 * nothing runs.
 */
export class TenantSessionRoleError extends Error {
  constructor(currentUser: string, sessionUser: string) {
    super(`refusing the tenant transaction: the session acts as "${currentUser}", not its login "${sessionUser}" (pool safety)`);
    this.name = 'TenantSessionRoleError';
  }
}

export interface TenantContextOptions {
  /** Route this read to the read replica when it is validated and fresh. Register-listed reads only. */
  useReplica?: boolean;
  /**
   * T-1 / ST-02: make this transaction READ ONLY from the binding SELECT on, in the same round trip
   * (`set_config('transaction_read_only', 'on', true)`, the documented equivalent of SET TRANSACTION READ ONLY; read-write
   * to read-only may happen at any point in a transaction). Any later INSERT/UPDATE/DELETE fails with 25006. For the
   * Worker's hot read-only scans; such a caller no longer sends its own `SET TRANSACTION READ ONLY` (that is the round trip
   * this removes). Admin Inspect (CF-02) and `useReplica` keep their own first-statement `SET TRANSACTION READ ONLY`.
   */
  readOnly?: boolean;
}

/** What bindGucs folds into its one SELECT besides the identity GUCs (T-1). Absent = not bound there. */
export interface BindExtras {
  /** ST-01: a schema already known BEFORE the bind ('core', or a schema validated before this transaction opened). */
  searchPath?: string;
  /** ST-02: switch the transaction to READ ONLY in the same SELECT. */
  readOnly?: boolean;
}

/**
 * T-1: the one binding statement. The GUC names and the `'on'` literal are constants; every request-derived value is a
 * bound parameter ($1-$5, and $6 = the search_path when it is folded in). Exported for the exact-text tests.
 */
export function bindGucsSql(extras: BindExtras = {}): string {
  return (
    `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true), set_config('rab.actor_type', $5, true), set_config('rab.team_shift_id', '', true), set_config('rab.team_staff_id', '', true), set_config('rab.admin_scope', '', true), set_config('rab.upgrade_scope', '', true), ` +
    (extras.searchPath !== undefined ? `set_config('search_path', $6, true), ` : '') +
    (extras.readOnly ? `set_config('transaction_read_only', 'on', true), ` : '') +
    `current_user::text AS cu, session_user::text AS su`
  );
}

/** The identity a binding statement carries. `actorType` is set only by trusted server code (auth-context.interface.ts). */
export type BindIdentity = Pick<AuthContext, 'organisationId' | 'workspaceId' | 'userId' | 'role' | 'actorType'>;

/** Runs one statement with bound parameters and returns its rows (a TypeORM EntityManager, or a pg Client adapted to it). */
export type BindQuery = (sql: string, params: unknown[]) => Promise<unknown>;

/**
 * The binding statement itself (bindGucsSql), with its parameters built in exactly one place. Shared by TenantContextService's
 * own binder and bindMaintenanceSessionGucs below, so there is still only ONE statement that writes the identity GUCs
 * (rab.actor_type included) and one place that maps a context onto its parameters.
 */
async function runBindStatement(query: BindQuery, ctx: BindIdentity, extras: BindExtras): Promise<{ cu: string; su: string } | undefined> {
  const params: string[] = [ctx.organisationId ?? '', ctx.workspaceId ?? '', ctx.userId, ctx.role, ctx.actorType ?? ''];
  if (extras.searchPath !== undefined) params.push(extras.searchPath);
  const rows = (await query(bindGucsSql(extras), params)) as Array<{ cu: string; su: string }> | undefined;
  return rows?.[0];
}

/**
 * The trusted binder for a MAINTENANCE session that cannot go through a TenantContextService transaction: a dedicated pg Client
 * or a transaction a maintenance job already holds (the Worker's workspace -> core orphan check, the account-invite cleanup's
 * level-22 pass). Binds the same nine transaction-local GUCs with the same one statement and the same parameter mapping as
 * every tenant-context transaction (bindGucsSql: rab.organisation_id, workspace_id, user_id, role, actor_type, and
 * team_shift_id / team_staff_id / admin_scope / upgrade_scope reset to ''). The caller must be inside a transaction (the
 * values are transaction-local and vanish on COMMIT / ROLLBACK, or on ROLLBACK TO SAVEPOINT).
 *
 * Unlike TenantContextService's own binder it does NOT run RESET ROLE and does not require current_user = session_user:
 * those sessions are not pooled request connections, and the orphan check's connection deliberately acts as `crewflow`
 * through a session-level SET ROLE on the owner login (workspace-provisioning.loops.ts actAsProvisioningRole) that RESET
 * ROLE would silently drop for the rest of the connection. It changes no role, opens no transaction and sets no search_path.
 * Never call it from a request path: those use runInTenantContext / runInWorkspaceContext.
 */
export async function bindMaintenanceSessionGucs(query: BindQuery, ctx: BindIdentity): Promise<void> {
  await runBindStatement(query, ctx, {});
}

@Injectable()
export class TenantContextService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly schemaResolver: SchemaResolverService,
    private readonly environment: EnvironmentService,
    @Optional() private readonly replica?: PgReplicaService,
  ) {
    // Owner login: RESET ROLE on every checkout of this DataSource's pool (database/postgres/session-role-reset.ts). The
    // per-transaction reset + assertion in bindGucs is the second layer; it also covers DataSources built elsewhere.
    if (this.dataSource.isInitialized) installSessionRoleResetOnDataSource(this.dataSource);
  }

  /**
   * Part D (owner D2/D3): whether a workspace is blocked by a failed upgrade step, read inside the caller's tenant transaction
   * (the registry row is visible only to its organisation). Same rule as SchemaResolverService: only where workspaces are
   * routed to their schemas (HWS_RUNTIME_ENABLED); otherwise the workspace schema serves nothing and nothing is blocked.
   * For Worker jobs that must DEFER (not fail) before they claim anything.
   */
  async isWorkspaceUpgradeBlocked(manager: EntityManager, workspaceId: string): Promise<boolean> {
    if (!this.environment.get('HWS_RUNTIME_ENABLED')) return false;
    // Part C3 (review H-1b): same fail-closed cutover rule as SchemaResolverService (hws-cutover-routing.ts).
    const rows: Array<{ migration_error: string | null; cutover_state: string | null; cutover_active: boolean }> = await manager.query(
      // sql-injection-reviewed: CUTOVER_ROUTING_COLUMNS_SQL is a code constant (hws-cutover-routing.ts); the only value is $1
      `SELECT r.migration_error, ${CUTOVER_ROUTING_COLUMNS_SQL}
         FROM core.workspace_schema_registry r WHERE r.workspace_id = $1`,
      [workspaceId],
    );
    return isUpgradeBlocked(rows[0]?.migration_error) || cutoverStateRefused(rows[0]?.cutover_state, rows[0]?.cutover_active);
  }

  async runInTenantContext<T>(
    ctx: AuthContext,
    fn: (manager: EntityManager) => Promise<T>,
    options?: TenantContextOptions,
  ): Promise<T> {
    if (options?.useReplica) return this.runRoutedRead(ctx, (manager) => fn(manager));
    const readOnly = options?.readOnly === true;
    return this.observe('primary', () => this.dataSource.transaction((manager) => withBusinessSchemaScope(manager, async () => {
      // ST-05: this stage times the in-transaction binding only. The pool checkout (with its RESET ROLE) and TypeORM's
      // START TRANSACTION run before it, and COMMIT after the callback; none of them is inside it.
      await timeStage('tenant_context_setup', async () => {
        await this.enforceInspectReadOnly(manager, ctx);
        if (this.environment.get('HWS_RUNTIME_ENABLED') && ctx.workspaceId) {
          // HWS on with a workspace: the registry is FORCE RLS and needs the GUCs bound first, so search_path stays its own
          // statement after resolve().
          await this.bindGucs(manager, ctx, { readOnly });
          await this.bindBusinessSchemaAndPath(manager, ctx, await this.schemaResolver.resolve(manager, ctx.workspaceId));
          return;
        }
        // ST-01: the schema is the constant 'core', bound in the same SELECT as the identity GUCs (C2-0: recorded first).
        bindBusinessSchema(manager, CORE_BUSINESS_SCHEMA, ctx.workspaceId);
        await this.bindGucs(manager, ctx, { searchPath: businessSearchPath(CORE_BUSINESS_SCHEMA), readOnly });
      });
      return this.handOut(manager, ctx, (bound) => fn(bound));
    })));
  }

  /**
   * The one canonical boundary for a WORKSPACE-BUSINESS operation (the 15 physical tables — staff, venue, shift,
   * offer, attendance, ... — see rab-workforce-architecture.md). Unlike `runInTenantContext`, this method REQUIRES
   * `ctx.workspaceId` and throws `WorkspaceRoutingError('missing-context')` if it is null — a workspace-domain
   * service calling this with no workspace bound is a bug or an attack (an endpoint that should have been behind
   * `RequireWorkspaceGuard` wasn't, or a worker job forgot to pass a discovered workspace id), and it fails closed
   * here rather than silently defaulting to 'core' and running the mutation against the legacy table instead of the
   * caller's actual physical schema.
   *
   * Two modes, same as `runInTenantContext`, but the business/core split for workspace-domain services never
   * ambiguously falls through to case 3 (no-workspace → core) — that case doesn't exist here, by construction:
   *   - `HWS_RUNTIME_ENABLED=false`: search_path = 'core' (workspace business tables still physically live in core
   *     — this is the documented "legacy runtime may remain for controlled compatibility" case).
   *   - `HWS_RUNTIME_ENABLED=true`: search_path = the resolved physical workspace schema, fail-closed via
   *     `SchemaResolverService` (missing registry row, not-READY, unsupported version all throw before `fn` runs).
   *
   * Returns the resolved schema alongside the manager so callers that need it (e.g. to build a schema-qualified
   * reference for a cross-schema audit log entry) don't have to re-derive it.
   */
  async runInWorkspaceContext<T>(
    ctx: AuthContext,
    fn: (manager: EntityManager, schema: string) => Promise<T>,
    options?: TenantContextOptions,
  ): Promise<T> {
    if (!ctx.workspaceId) throw new WorkspaceRoutingError('missing-context');
    if (options?.useReplica) return this.runRoutedRead(ctx, fn);
    const readOnly = options?.readOnly === true;
    return this.observe('primary', () => this.dataSource.transaction((manager) => withBusinessSchemaScope(manager, async () => {
      const schema = await timeStage('tenant_context_setup', async () => {
        await this.enforceInspectReadOnly(manager, ctx);
        if (this.environment.get('HWS_RUNTIME_ENABLED')) {
          // HWS on: the registry is FORCE RLS and needs the GUCs bound first, so search_path stays its own statement.
          await this.bindGucs(manager, ctx, { readOnly });
          const resolved = await this.schemaResolver.resolve(manager, ctx.workspaceId);
          await this.bindBusinessSchemaAndPath(manager, ctx, resolved);
          return resolved;
        }
        // ST-01: HWS off, the schema is the constant 'core', bound in the same SELECT as the identity GUCs (C2-0: recorded first).
        bindBusinessSchema(manager, CORE_BUSINESS_SCHEMA, ctx.workspaceId);
        await this.bindGucs(manager, ctx, { searchPath: businessSearchPath(CORE_BUSINESS_SCHEMA), readOnly });
        return CORE_BUSINESS_SCHEMA;
      });
      return this.handOut(manager, ctx, (bound) => fn(bound, schema));
    })));
  }

  /**
   * B4: the read path for `{ useReplica: true }` (see the class comment). Never nests: the optional primary schema
   * resolution finishes before the replica transaction opens, and the primary retry starts after the replica
   * transaction has ended.
   */
  private async runRoutedRead<T>(ctx: AuthContext, fn: (manager: EntityManager, schema: string) => Promise<T>): Promise<T> {
    const route = this.replica?.routeRead() ?? ({ dataSource: null, reason: 'not-configured' } as const);
    if (route.dataSource) {
      const replicaDataSource = route.dataSource;
      const hws = this.environment.get('HWS_RUNTIME_ENABLED') && ctx.workspaceId;
      const schema = hws ? await this.resolveSchemaOnPrimary(ctx) : CORE_BUSINESS_SCHEMA;
      try {
        const value = await this.observe('replica', () => this.readOnlyTransaction(replicaDataSource, ctx, schema, fn));
        databaseMetrics.recordReplicaRead();
        return value;
      } catch (error) {
        if (!this.replica!.shouldRetryOnPrimary(error)) throw error;
        databaseMetrics.recordReplicaFallback('replica-error');
      }
    } else if (route.reason !== 'not-configured') {
      databaseMetrics.recordReplicaFallback(route.reason);
    }
    return this.observe('primary', () => this.readOnlyTransaction(this.dataSource, ctx, null, fn));
  }

  /** A READ ONLY tenant transaction on `dataSource`. `schema` null = resolve inside (primary), else bind as given. */
  private readOnlyTransaction<T>(
    dataSource: DataSource,
    ctx: AuthContext,
    schema: string | null,
    fn: (manager: EntityManager, schema: string) => Promise<T>,
  ): Promise<T> {
    return dataSource.transaction((manager) => withBusinessSchemaScope(manager, async () => {
      const bound = await timeStage('tenant_context_setup', async () => {
        await manager.query('SET TRANSACTION READ ONLY');
        // ST-01: a schema known before the bind (resolved and validated on the primary already, or 'core') is folded into
        // the binding SELECT; one resolved here (HWS on with a workspace, on the primary) needs the GUCs first.
        const known = schema ?? (this.environment.get('HWS_RUNTIME_ENABLED') && ctx.workspaceId ? null : CORE_BUSINESS_SCHEMA);
        if (known !== null) {
          bindBusinessSchema(manager, known, ctx.workspaceId); // C2-0: validated and recorded before it reaches set_config
          await this.bindGucs(manager, ctx, { searchPath: businessSearchPath(known) });
          return known;
        }
        await this.bindGucs(manager, ctx);
        const resolved = await this.schemaResolver.resolve(manager, ctx.workspaceId);
        await this.bindBusinessSchemaAndPath(manager, ctx, resolved);
        return resolved;
      });
      return this.handOut(manager, ctx, (boundManager) => fn(boundManager, bound));
    }));
  }

  /** The trusted workspace schema, resolved on the primary in its own short read-only transaction (same RLS binding). */
  private resolveSchemaOnPrimary(ctx: AuthContext): Promise<string> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      await this.bindGucs(manager, ctx);
      return this.schemaResolver.resolve(manager, ctx.workspaceId);
    });
  }

  /** Counts timeout-class failures per pool (B5 metrics); the error itself is rethrown untouched. */
  private async observe<T>(pool: DbPoolName, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      databaseMetrics.recordQueryError(pool, error);
      throw error;
    }
  }

  /**
   * P1C: exposes GUC binding alone — no search_path, no new transaction — for a caller that
   * already holds an open transaction's manager and needs ONLY the core RLS identity bound,
   * never a physical workspace schema. `AuthSecuritySnapshotService` is the canonical caller: it
   * must call a pre-auth SECURITY DEFINER function (`resolve_membership_for_session`) BEFORE
   * `ctx` is even fully known, inside the SAME transaction its later reads need to stay
   * consistent with (one coherent snapshot) — `runInTenantContext` can't be used there, since it
   * always requires a complete, already-resolved `ctx` up front and always opens its own fresh
   * transaction. This is a thin public wrapper around the exact same private `bindGucs` every
   * other tenant-context entry point already uses — not a second binding implementation.
   *
   * Every query run against these bound GUCs must schema-qualify its own tables explicitly
   * (`core.xxx`) or use an entity with an explicit `schema: 'core'` option — deliberately no
   * search_path is bound here, since the security snapshot never touches a physical workspace
   * schema by design (HWS routing boundary, P1C §11).
   */
  async bindCoreIdentityGucs(manager: EntityManager, ctx: BindIdentity): Promise<void> {
    await this.bindGucs(manager, ctx);
  }

  // SET LOCAL (via set_config's third arg = true) is transaction-scoped, so a pooled connection can never leak one
  // request's tenant context into the next. Parameterised, never interpolated — these values reach SQL, and `role`
  // in particular is a client-influenced string. All four in one round trip, not four — this wrapper runs on every
  // tenant-scoped call in the app (guards included), so four separate awaits here means four Neon round trips paid
  // repeatedly per request; a single SELECT with all four set_config() calls in its target list sets the same four
  // values with the same transaction-scoped semantics, in one round trip.
  /**
   * CF-02, database layer: a transaction that runs AS an inspected user (Admin Inspect) is READ ONLY in PostgreSQL. It
   * must be the transaction's first statement. Any INSERT/UPDATE/DELETE then fails with 25006 however it was reached,
   * so read-only no longer depends on every route or service remembering a check.
   */
  private async enforceInspectReadOnly(manager: EntityManager, ctx: AuthContext): Promise<void> {
    if (ctx.inspectedBy) await manager.query('SET TRANSACTION READ ONLY');
  }

  private async bindGucs(manager: EntityManager, ctx: BindIdentity, extras: BindExtras = {}): Promise<void> {
    // Owner-login pool safety (G-09): a session-level SET ROLE / set_config('role', …, false) left behind by an earlier
    // request on this pooled connection must not carry into this tenant transaction. RESET ROLE (session level, inside the
    // transaction: it persists on COMMIT, reverts on ROLLBACK — allowed in READ ONLY transactions, never DISCARD ALL), then
    // the binding SELECT below also returns current_user / session_user and the transaction fails closed if they differ.
    await manager.query(RESET_ROLE_SQL);
    // Reset the optional read-only roster capability and the org-admin Assigned Staff scope (VenueManagerService) on every
    // transaction; only the service method that needs one binds it, after this.
    // T-1: when the schema is already known (ST-01) search_path is set in this same SELECT, and when the caller asked for a
    // read-only transaction (ST-02) so is transaction_read_only; both transaction-local, like the identity GUCs.
    // The search_path value is a bound parameter, which stops SQL injection but NOT a comma-separated list ('a, core' would
    // be two schemas). C2-0: every caller now passes it through businessSearchPath(), which refuses anything but 'core' or
    // `workspace_` + 32 lowercase hex (and returns '' under the test-only trap); provenance is still decided where it comes
    // from, and only there:
    //   - the literal constant 'core' in the callers above; or
    //   - a schema returned by SchemaResolverService.resolve(): `workspaceSchemaName()` (`workspace_` + 32 lowercase hex, from
    //     a UUID) plus an exact match with the registry row, and, for a cached value, the same exact-name comparison (ST-07).
    // Never pass anything else here (no request field, header, claim or other string).
    // RESET ROLE above stays its own statement (both layers kept, G-09).
    const identity = await runBindStatement((sql, params) => manager.query(sql, params), ctx, extras);
    if (!identity || identity.cu !== identity.su) throw new TenantSessionRoleError(String(identity?.cu), String(identity?.su));
  }

  /**
   * C2-1: the callback gets the SCHEMA-BOUND manager for the schema C2-0 just recorded (and validated: 'core' or exactly the
   * canonical name of ctx.workspaceId) on `manager` — the real schema, never the trap's ''. businessTables() is recorded on
   * the bound manager too, for the callback only; nested transactions get the same manager (queryRunner.manager).
   */
  private async handOut<T>(manager: EntityManager, ctx: Pick<AuthContext, 'workspaceId'>, run: (bound: EntityManager) => Promise<T>): Promise<T> {
    // Fail closed: every binder path records the schema before it reaches here. (bindEntityManagerToSchema itself refuses a
    // manager outside an open transaction.)
    const schema = peekBusinessSchema(manager);
    if (schema === undefined) throw new BusinessTablesError('unbound');
    const bound = await bindEntityManagerToSchema(manager, schema);
    return withBusinessSchema(bound, schema, ctx.workspaceId, () => run(bound));
  }

  /**
   * C2-0: records `schema` for businessTables(manager) FIRST (bindBusinessSchema validates it: 'core' or exactly the
   * canonical name of ctx.workspaceId), then binds search_path to it — or to '' under the test-only trap (business-tables.ts).
   * The enclosing withBusinessSchemaScope puts the entry binding back when the transaction callback settles.
   */
  private async bindBusinessSchemaAndPath(manager: EntityManager, ctx: Pick<AuthContext, 'workspaceId'>, schema: string): Promise<void> {
    bindBusinessSchema(manager, schema, ctx.workspaceId);
    await manager.query(`SELECT set_config('search_path', $1, true)`, [businessSearchPath(schema)]);
  }
}
