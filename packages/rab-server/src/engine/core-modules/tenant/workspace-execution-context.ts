import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AuthContext } from './auth-context.interface';
import { SchemaResolverService, WorkspaceRoutingError } from './schema-resolver.service';

/**
 * One transaction-routing mechanism for workspace-scoped work (Hyper Workspace Phase 3, step 4).
 *
 * Inside ONE transaction, on ONE connection:
 *   1. bind rab.organisation_id, rab.workspace_id, rab.user_id, rab.role (transaction-local);
 *   2. resolve the trusted physical schema from the authoritative registry (SchemaResolverService);
 *   3. set search_path to EXACTLY that schema (transaction-local). Never 'workspace, core', never 'workspace, public'.
 *   4. run the callback with the transactional EntityManager (the only handle business code may use here).
 *
 * Everything is transaction-local, so nothing survives COMMIT, ROLLBACK or an error on a pooled connection.
 *
 * Cutover status: this mechanism is built and tested, but it is NOT yet used for normal business traffic. Business
 * entities still resolve through the DataSource default schema 'core' until the controlled cutover phase.
 */
@Injectable()
export class WorkspaceExecutionContext {
  constructor(
    private readonly dataSource: DataSource,
    private readonly schemaResolver: SchemaResolverService,
  ) {}

  run<T>(ctx: AuthContext, fn: (manager: EntityManager, schema: string) => Promise<T>): Promise<T> {
    if (!ctx.organisationId || !ctx.workspaceId || !ctx.userId || !ctx.role) {
      return Promise.reject(new WorkspaceRoutingError('missing-context'));
    }
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true),
                set_config('rab.user_id', $3, true), set_config('rab.role', $4, true)`,
        [ctx.organisationId, ctx.workspaceId, ctx.userId, ctx.role],
      );
      // Organisation context is bound above, so the registry's FORCE RLS can show the row to this organisation only.
      const schema = await this.schemaResolver.resolve(manager, ctx.workspaceId);
      // Exactly one schema. No core, no public, no pg_catalog listed here: catalog objects are always searched by Postgres.
      await manager.query(`SELECT set_config('search_path', $1, true)`, [schema]);
      return fn(manager, schema);
    });
  }
}
