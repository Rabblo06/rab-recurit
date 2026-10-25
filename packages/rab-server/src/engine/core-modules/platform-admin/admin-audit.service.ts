import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import { assertActivePlatformAdmin, decodeCursor, encodeCursor, mapAdminFunctionError } from './admin-actor';
import { ADMIN_TIMELINE_ACTIONS } from './admin-panel-audit-actions';
import { AdminAuditItem, RawAuditRow, toAuditItem } from './admin-panel.mappers';
import { PlatformAdminService } from './platform-admin.service';

type Actor = Pick<AuthContext, 'userId' | 'organisationId'>;

/**
 * Crewflow Platform Admin Panel — the admin activity timeline (Audit tab). Read-only: `audit_log` is insert-only and no
 * route here (or anywhere) updates or deletes it. Reads only through `core.admin_list_audit_events` (admin-gated SECURITY
 * DEFINER, fixed action allowlist, keyset pages ≤50, FORCE RLS honoured by binding one organisation at a time) inside a
 * READ ONLY transaction; layer 2 re-checks the actor; rows are re-filtered against the same allowlist and mapped field by
 * field (only `metadata.reason` and a few typed detail keys ever leave the database, never the metadata object).
 */
@Injectable()
export class AdminAuditService {
  constructor(
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

  async listAudit(
    actor: Actor,
    query: { action?: string; user?: string; cursor?: string; limit?: number },
  ): Promise<{ items: AdminAuditItem[]; nextCursor: string | null }> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const cursor = decodeCursor(query.cursor);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 50);
    const rows = await this.readTx(actor, (m) =>
      m.query<RawAuditRow[]>('SELECT * FROM core.admin_list_audit_events($1::text[], $2, $3, $4, $5)', [
        query.action ? [query.action] : null,
        query.user ?? null,
        cursor?.at ?? null,
        cursor?.id ?? null,
        limit,
      ]),
    );
    const items = rows.map((r) => toAuditItem(r, ADMIN_TIMELINE_ACTIONS)).filter((i): i is AdminAuditItem => i !== null);
    const last = rows[rows.length - 1];
    return { items, nextCursor: rows.length === limit && last ? encodeCursor(last.createdAt, String(last.id)) : null };
  }
}
