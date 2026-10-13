import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Worker credential isolation checkpoint, item 1's standalone-process test found this live, as a
 * follow-on to `WorkerPendingWorkspaceSchemaDiscovery1786693000000`: once the provisioner could
 * finally SEE a pending workspace, it then failed every single attempt (`attempted=1 ready=0
 * failed=0`, no registry row ever created) when run as the real `crewflow` credential
 * (`DATABASE_URL_UNPOOLED`) — the same credential `provisionWorkspaceSchema()`'s own code
 * (`provision-workspace-schema.ts`) calls `core.begin_workspace_schema_attempt`,
 * `core.register_workspace_schema`, `core.mark_workspace_schema_ready` and
 * `core.mark_workspace_schema_failed` directly on, as top-level statements in its own transaction
 * (never nested inside another SECURITY DEFINER function, which would make the caller's own grants
 * irrelevant).
 *
 * All four are owned by `rab_secure_owner`. `crewflow` is not a member of that role and has never
 * held EXECUTE on any of them — confirmed directly against `information_schema.routine_privileges`
 * on an independently fresh bootstrap database never touched by this session's other work: the
 * ONLY grantee on all four, on every environment this was checked against, is `rab_secure_owner`
 * itself (the implicit owner grant). `WorkspaceLifecycleGrantTightening1786677800000` only ever
 * revoked them from `rab_app` (today's `crewflow_app`) — correctly, since the ordinary runtime role
 * must never hold them — but its own doc comment's claim that the real provisioning path "already
 * run[s] on an `rab_owner`-connected client" never meant that connection had its own explicit grant;
 * it apparently assumed ownership or inherited access that was never actually established. The
 * practical result: calling `provisionWorkspaceSchema()` as `crewflow` has never worked, on any
 * environment with this migration chain applied — every existing integration test for it passes
 * only because it calls the job function with the disposable test database's SUPERUSER connection
 * (`TEST_DATABASE_URL_UNPOOLED`), which bypasses every privilege check unconditionally and silently
 * masked this. Confirmed live by running the real standalone `workspace-provisioner.main.ts` process
 * as the real `crewflow` credential against a genuinely pending workspace.
 *
 * Fix: grant EXECUTE on these four to `crewflow` specifically — the one process (the standalone
 * provisioner) that ever calls them, via its own direct, un-nested statements. `crewflow_app` is
 * deliberately NOT granted here, consistent with `WorkspaceLifecycleGrantTightening1786677800000`'s
 * own intent, which this migration does not reverse or weaken in any way.
 */
export class WorkspaceProvisionerLifecycleGrants1786694000000 implements MigrationInterface {
  name = 'WorkspaceProvisionerLifecycleGrants1786694000000';

  private readonly functions = [
    'core.begin_workspace_schema_attempt(uuid)',
    'core.register_workspace_schema(uuid)',
    'core.mark_workspace_schema_ready(uuid, integer)',
    'core.mark_workspace_schema_failed(uuid, text)',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const fn of this.functions) {
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${fn} TO crewflow;`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const fn of this.functions) {
      await queryRunner.query(`REVOKE EXECUTE ON FUNCTION ${fn} FROM crewflow;`);
    }
  }
}
