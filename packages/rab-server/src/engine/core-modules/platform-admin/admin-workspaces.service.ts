import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import { assertActivePlatformAdmin, decodeCursor, encodeCursor, mapAdminFunctionError } from './admin-actor';
import { AdminWorkspaceListItem, RawWorkspaceRow, toWorkspaceListItem } from './admin-panel.mappers';
import { PlatformAdminService } from './platform-admin.service';

type Actor = Pick<AuthContext, 'userId' | 'organisationId'>;

export interface AdminPlatformOverview {
  organisations: { total: number; active: number; suspended: number };
  users: { total: number; signedInLast7Days: number };
  sessions: { active: number; platformAdminSessionsToday: number };
  platformAdmins: { active: number };
  workspaces: { ready: number; creating: number; failed: number; other: number };
}

export interface CoreMigrationsInfo {
  applied: number;
  latest: string | null;
  /** Migrations this build knows about that the database has not applied (null when it cannot be computed). */
  pending: number | null;
}

/**
 * Crewflow Platform Admin Panel — platform overview, core migrations and workspace schemas (General + Workspaces tabs).
 * Read-only. Layer 2 in every method; reads only through the admin-gated SECURITY DEFINER
 * functions (which raise 42501 for a non-admin themselves) inside a READ ONLY transaction, plus `core.migrations`
 * (no tenant data, `crewflow_app` SELECT).
 *
 * D6 (owner): no Retry here. A FAILED workspace is retried automatically by the provisioner; the panel says so.
 */
@Injectable()
export class AdminWorkspacesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly platformAdmin: PlatformAdminService,
  ) {}

  private readTx<T>(actor: Actor, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return this.tenantContext.runInTenantContext({ organisationId: actor.organisationId, workspaceId: null, userId: actor.userId, role: '' }, async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      try {
        return await fn(manager);
      } catch (error) {
        return mapAdminFunctionError(error);
      }
    });
  }

  async overview(actor: Actor): Promise<AdminPlatformOverview> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const [r] = await this.readTx(actor, (m) => m.query<Array<Record<string, number>>>('SELECT * FROM core.admin_platform_overview()'));
    const n = (k: string) => Number(r?.[k] ?? 0);
    return {
      organisations: { total: n('organisationsTotal'), active: n('organisationsTotal') - n('organisationsSuspended'), suspended: n('organisationsSuspended') },
      users: { total: n('usersTotal'), signedInLast7Days: n('usersSignedIn7d') },
      sessions: { active: n('activeSessions'), platformAdminSessionsToday: n('platformAdminSessionsToday') },
      platformAdmins: { active: n('platformAdminsActive') },
      workspaces: { ready: n('workspacesReady'), creating: n('workspacesCreating'), failed: n('workspacesFailed'), other: n('workspacesOther') },
    };
  }

  /** `core.migrations` holds migration names only (no RLS, no tenant data). "Pending" compares with this build's list. */
  async coreMigrations(actor: Actor): Promise<CoreMigrationsInfo> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const rows = await this.readTx(actor, (m) => m.query<Array<{ name: string }>>('SELECT name FROM core.migrations ORDER BY "timestamp" DESC, id DESC'));
    const applied = new Set(rows.map((r) => String(r.name)));
    let pending: number | null = null;
    try {
      const known = this.dataSource.migrations.map((m) => m.name ?? m.constructor.name);
      pending = known.length > 0 ? known.filter((k) => !applied.has(k)).length : null;
    } catch {
      pending = null;
    }
    const latest = rows[0]?.name ?? null;
    return { applied: rows.length, latest: latest && /^[A-Za-z0-9]{1,120}$/.test(latest) ? latest : null, pending };
  }

  async listWorkspaces(
    actor: Actor,
    query: { status?: string; organisationId?: string; cursor?: string; limit?: number },
  ): Promise<{ items: AdminWorkspaceListItem[]; nextCursor: string | null }> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const cursor = decodeCursor(query.cursor);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 50);
    const rows = await this.readTx(actor, (m) =>
      m.query<RawWorkspaceRow[]>('SELECT * FROM core.admin_list_workspace_schemas($1, $2, $3, $4, $5)', [
        query.status ?? null,
        query.organisationId ?? null,
        cursor?.at ?? null,
        cursor?.id ?? null,
        limit,
      ]),
    );
    const items = rows.map(toWorkspaceListItem);
    const last = items[items.length - 1];
    return { items, nextCursor: items.length === limit && last ? encodeCursor(last.updatedAt, last.workspaceId) : null };
  }
}
