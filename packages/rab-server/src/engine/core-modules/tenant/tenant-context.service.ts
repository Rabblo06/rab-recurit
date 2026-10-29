import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { EnvironmentService } from '../environment/environment.service';
import { timeStage } from '../../observability/request-context';
import { AuthContext } from './auth-context.interface';
import { SchemaResolverService, WorkspaceRoutingError } from './schema-resolver.service';

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
 * `runInTenantContext` is the general-purpose entry point (core/global services, and anything that may legitimately
 * run with no workspace bound). `runInWorkspaceContext` (below) is the stricter boundary for the 15 physical
 * workspace-business tables: it requires a workspace and fails closed if one isn't bound, so a workspace-domain
 * service can never silently fall through to case 3 and operate on `core` because no workspace happened to be set.
 */
@Injectable()
export class TenantContextService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly schemaResolver: SchemaResolverService,
    private readonly environment: EnvironmentService,
  ) {}

  async runInTenantContext<T>(
    ctx: AuthContext,
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await timeStage('tenant_context_setup', async () => {
        await this.enforceInspectReadOnly(manager, ctx);
        await this.bindGucs(manager, ctx);
        const schema =
          this.environment.get('HWS_RUNTIME_ENABLED') && ctx.workspaceId
            ? await this.schemaResolver.resolve(manager, ctx.workspaceId)
            : 'core';
        await this.bindSearchPath(manager, schema);
      });
      return fn(manager);
    });
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
  ): Promise<T> {
    if (!ctx.workspaceId) throw new WorkspaceRoutingError('missing-context');
    return this.dataSource.transaction(async (manager) => {
      const schema = await timeStage('tenant_context_setup', async () => {
        await this.enforceInspectReadOnly(manager, ctx);
        await this.bindGucs(manager, ctx);
        const resolved = this.environment.get('HWS_RUNTIME_ENABLED')
          ? await this.schemaResolver.resolve(manager, ctx.workspaceId)
          : 'core';
        await this.bindSearchPath(manager, resolved);
        return resolved;
      });
      return fn(manager, schema);
    });
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
  async bindCoreIdentityGucs(manager: EntityManager, ctx: Pick<AuthContext, 'organisationId' | 'workspaceId' | 'userId' | 'role' | 'actorType'>): Promise<void> {
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

  private async bindGucs(manager: EntityManager, ctx: AuthContext): Promise<void> {
    // Reset the optional read-only roster capability and the org-admin Assigned Staff scope (VenueManagerService) on every
    // transaction; only the service method that needs one binds it, after this.
    await manager.query(
      `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true), set_config('rab.actor_type', $5, true), set_config('rab.team_shift_id', '', true), set_config('rab.team_staff_id', '', true), set_config('rab.admin_scope', '', true)`,
      [ctx.organisationId ?? '', ctx.workspaceId ?? '', ctx.userId, ctx.role, ctx.actorType ?? ''],
    );
  }

  private async bindSearchPath(manager: EntityManager, schema: string): Promise<void> {
    await manager.query(`SELECT set_config('search_path', $1, true)`, [schema]);
  }
}
