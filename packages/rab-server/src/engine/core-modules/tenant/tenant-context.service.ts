import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AuthContext } from './auth-context.interface';

/**
 * Binds the request's tenant/actor identity into the Postgres session so
 * RLS policies (rab-workforce-architecture.md §5.7) can enforce it as a
 * second, database-level line of defence behind the guard → service →
 * org-scope-query chain (§5.2). Every service method that touches a
 * tenant-scoped table runs inside `runInTenantContext`, not a bare
 * `dataSource.manager` call.
 */
@Injectable()
export class TenantContextService {
  constructor(private readonly dataSource: DataSource) {}

  async runInTenantContext<T>(
    ctx: AuthContext,
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      // SET LOCAL (via set_config's third arg = true) is transaction-scoped,
      // so a pooled connection can never leak one request's tenant context
      // into the next. Parameterised, never interpolated — these values
      // reach SQL, and `role` in particular is a client-influenced string.
      // All four in one round trip, not four — this wrapper runs on every
      // tenant-scoped call in the app (guards included), so four separate
      // awaits here means four Neon round trips paid repeatedly per
      // request; a single SELECT with all four set_config() calls in its
      // target list sets the same four values with the same transaction-
      // scoped semantics, in one round trip.
      await manager.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true)`,
        [ctx.organisationId ?? '', ctx.workspaceId ?? '', ctx.userId, ctx.role],
      );
      return fn(manager);
    });
  }
}
