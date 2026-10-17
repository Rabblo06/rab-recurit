import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Organisation isolation (owner policy, 2026-10-15) — database layer of "an Organisation 1 invitation, manager, workspace or
 * session never grants anything in Organisation 2". Supersedes P2.9C's "a Platform Admin may onboard ANY organisation's Initial
 * Manager"; organisation creation + CEO onboarding (a separate, explicitly authorised platform workflow) is unchanged.
 *
 * 1. RLS — the two top-level platform-admin bypass branches added for cross-organisation onboarding are narrowed:
 *    - `manager_workspace_write` (FOR ALL): the branch is REMOVED. It was added only for P2.9C's invite-time workspace
 *      provisioning (`ManagerWorkspacePlatformAdminRls1786712000000`), which the self-service checkpoint already retired — no
 *      code path needs it, and it let any platform-admin session read/write every organisation's workspaces (it was never
 *      organisation-scoped). Owners and an org-scoped `manager.manage` holder keep exactly their previous reach.
 *    - `manager_profile_tenant` (FOR ALL): the branch now reaches `type = 'ceo'` rows only — what organisation creation, CEO
 *      invite resend/revoke and the organisation list need — never an Internal (Initial) Manager or Venue Manager profile of
 *      another organisation. Every ordinary branch is byte-for-byte unchanged.
 * 2. Composite same-organisation keys: every identity row that names both a user (or workspace) and an organisation must agree
 *    with it. Single-column FKs allowed e.g. a manager_profile in Organisation 1 for a user of Organisation 2. Added NOT VALID then
 *    VALIDATEd (read-only diagnostics on the dev database found zero violations); a user's organisation can no longer change
 *    underneath its rows (no ON UPDATE action), which is the "never reassign a user into a different organisation" invariant.
 * 3. CHECK: only an internal Manager can be an Initial Manager (`manager_profile_one_current_initial_manager` already covers the
 *    one-current-slot rule for internal rows, but the flag itself could be set on a CEO or Venue Manager row).
 *
 * No data is changed. No RLS policy is disabled or loosened; FORCE/ENABLE are untouched.
 */
const COMPOSITE_KEYS: ReadonlyArray<{ table: string; name: string; columns: string; references: string; onDelete: string }> = [
  { table: 'core.manager_profile', name: 'manager_profile_user_org_fkey', columns: 'user_id, organisation_id', references: 'core."user"(id, organisation_id)', onDelete: 'CASCADE' },
  { table: 'core.manager_profile', name: 'manager_profile_workspace_org_fkey', columns: 'workspace_id, organisation_id', references: 'core.manager_workspace(id, organisation_id)', onDelete: 'NO ACTION' },
  { table: 'core.manager_workspace', name: 'manager_workspace_owner_org_fkey', columns: 'owner_user_id, organisation_id', references: 'core."user"(id, organisation_id)', onDelete: 'CASCADE' },
  { table: 'core.user_role', name: 'user_role_user_org_fkey', columns: 'user_id, organisation_id', references: 'core."user"(id, organisation_id)', onDelete: 'CASCADE' },
  { table: 'core.organisation_member', name: 'organisation_member_user_org_fkey', columns: 'user_id, organisation_id', references: 'core."user"(id, organisation_id)', onDelete: 'CASCADE' },
  { table: 'core.account_invite', name: 'account_invite_user_org_fkey', columns: 'user_id, organisation_id', references: 'core."user"(id, organisation_id)', onDelete: 'CASCADE' },
  { table: 'core.user_session', name: 'user_session_user_org_fkey', columns: 'user_id, organisation_id', references: 'core."user"(id, organisation_id)', onDelete: 'CASCADE' },
  { table: 'core.user_session', name: 'user_session_workspace_org_fkey', columns: 'workspace_id, organisation_id', references: 'core.manager_workspace(id, organisation_id)', onDelete: 'SET NULL (workspace_id)' },
  { table: 'core.refresh_token', name: 'refresh_token_user_org_fkey', columns: 'user_id, organisation_id', references: 'core."user"(id, organisation_id)', onDelete: 'CASCADE' },
];

const MANAGE_IN_ORG = `EXISTS (
            SELECT 1
              FROM core.user_role ur
              JOIN core.role_permission rp ON rp.role_id = ur.role_id
              JOIN core.permission p ON p.id = rp.permission_id
             WHERE ur.user_id = core.current_uid()
               AND ur.organisation_id = manager_workspace.organisation_id
               AND p.key = 'manager.manage'
          )`;

const PROFILE_MANAGE = `EXISTS (
              SELECT 1
                FROM core.user_role ur
                JOIN core.role_permission rp ON rp.role_id = ur.role_id
                JOIN core.permission p ON p.id = rp.permission_id
               WHERE ur.user_id = core.current_uid() AND p.key = 'manager.manage'
            )`;

const profileUsing = (adminBranch: string) => `(
          ${adminBranch}
          OR (
            organisation_id = core.current_org()
            AND (user_id = core.current_uid() OR workspace_id = core.current_workspace() OR ${PROFILE_MANAGE})
          )
        )`;
const profileCheck = (adminBranch: string) => `(
          ${adminBranch}
          OR (
            organisation_id = core.current_org()
            AND (workspace_id IS NULL OR workspace_id = core.current_workspace() OR ${PROFILE_MANAGE})
          )
        )`;

const ADMIN_ANY = 'core.is_active_platform_admin(core.current_uid())';
const ADMIN_CEO_ONLY = `(type = 'ceo' AND core.is_active_platform_admin(core.current_uid()))`;

export class OrganisationIsolationHardening1786717300000 implements MigrationInterface {
  name = 'OrganisationIsolationHardening1786717300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY manager_workspace_write ON core.manager_workspace
        USING (owner_user_id = core.current_uid() OR ${MANAGE_IN_ORG})
        WITH CHECK (owner_user_id = core.current_uid() OR ${MANAGE_IN_ORG});
    `);
    await queryRunner.query(`
      ALTER POLICY manager_profile_tenant ON core.manager_profile
        USING ${profileUsing(ADMIN_CEO_ONLY)}
        WITH CHECK ${profileCheck(ADMIN_CEO_ONLY)};
    `);

    for (const key of COMPOSITE_KEYS) {
      await queryRunner.query(
        `ALTER TABLE ${key.table} ADD CONSTRAINT ${key.name} FOREIGN KEY (${key.columns}) REFERENCES ${key.references} ON DELETE ${key.onDelete} NOT VALID`,
      );
      await queryRunner.query(`ALTER TABLE ${key.table} VALIDATE CONSTRAINT ${key.name}`);
    }
    await queryRunner.query(`
      ALTER TABLE core.manager_profile
        ADD CONSTRAINT manager_profile_initial_manager_is_internal CHECK (NOT is_initial_manager OR type = 'internal');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.manager_profile DROP CONSTRAINT IF EXISTS manager_profile_initial_manager_is_internal`);
    for (const key of [...COMPOSITE_KEYS].reverse()) {
      await queryRunner.query(`ALTER TABLE ${key.table} DROP CONSTRAINT IF EXISTS ${key.name}`);
    }
    await queryRunner.query(`
      ALTER POLICY manager_profile_tenant ON core.manager_profile
        USING ${profileUsing(ADMIN_ANY)}
        WITH CHECK ${profileCheck(ADMIN_ANY)};
    `);
    await queryRunner.query(`
      ALTER POLICY manager_workspace_write ON core.manager_workspace
        USING (${ADMIN_ANY} OR owner_user_id = core.current_uid() OR ${MANAGE_IN_ORG})
        WITH CHECK (${ADMIN_ANY} OR owner_user_id = core.current_uid() OR ${MANAGE_IN_ORG});
    `);
  }
}
