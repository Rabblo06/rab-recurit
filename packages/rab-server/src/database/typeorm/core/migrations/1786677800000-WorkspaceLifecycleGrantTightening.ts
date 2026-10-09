import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P0 finalization (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8A.9, Check A — Phase 0.6's
 * workspace-lifecycle SECURITY DEFINER finding). Confirmed by direct inspection this session:
 * `core.register_workspace_schema`, `core.begin_workspace_schema_attempt`,
 * `core.mark_workspace_schema_ready`, and `core.mark_workspace_schema_failed` were each
 * `GRANT EXECUTE ... TO rab_app` since the migrations that created them
 * (`WorkspaceSchemaRegistry1786674900000`, `WorkspaceSchemaLifecycleGate1786677000000`), despite
 * every one of them being state-machine-only (no structural schema verification — that lives
 * entirely in `provisionWorkspaceSchema()`, TypeScript, before it calls these as the LAST step of
 * its own transaction) and despite `provisionWorkspaceSchema()`'s own doc comment already
 * claiming "Runs as `rab_owner` only... never reachable from a request path" — a claim the grants
 * themselves never actually enforced.
 *
 * Confirmed by a full repo grep of every real caller in both `rab-server` and `rab-worker`: only
 * `provisionWorkspaceSchema()`'s own internal calls and `workspace-provisioning.job.ts` (the
 * worker's provisioning sweep) ever invoke these four functions, and BOTH already run on an
 * `rab_owner`-connected client (`provisioningClient`/`DATABASE_URL_UNPOOLED`), never `rab_app`.
 * This migration is therefore expected to be a pure hardening change with zero behavioural impact
 * on any currently-working path.
 *
 * NOT touched, and must not be touched by any future migration without a fresh dependency
 * analysis:
 *   - `core.workspace_schema_routable(uuid)` — a genuine per-request runtime need
 *     (`SchemaResolverService.resolve()` calls it live, as `rab_app`, on every HWS-mode request).
 *   - `core.provision_workspace_schema(uuid)` — its own internal checks (schema-ownership
 *     verification, `CREATE SCHEMA`/`GRANT USAGE` only, never `CREATE`) already make it safe
 *     regardless of caller role, and the real call pattern already authenticates as `rab_owner`
 *     regardless; revoking it was not asked for and is not required to close this finding.
 *
 * down() restores the EXACT previous grant state (`GRANT EXECUTE ... TO rab_app`) — nothing else
 * about these four functions (body, search_path, SECURITY DEFINER, PUBLIC revocation) changes in
 * either direction.
 */
export class WorkspaceLifecycleGrantTightening1786677800000 implements MigrationInterface {
  name = 'WorkspaceLifecycleGrantTightening1786677800000';

  private readonly functions = [
    'core.register_workspace_schema(uuid)',
    'core.begin_workspace_schema_attempt(uuid)',
    'core.mark_workspace_schema_ready(uuid, integer)',
    'core.mark_workspace_schema_failed(uuid, text)',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const fn of this.functions) {
      await queryRunner.query(`REVOKE EXECUTE ON FUNCTION ${fn} FROM rab_app;`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const fn of this.functions) {
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${fn} TO rab_app;`);
    }
  }
}
