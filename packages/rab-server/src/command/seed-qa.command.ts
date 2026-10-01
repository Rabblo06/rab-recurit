import { ManagerType, PermissionFlag, UserStatus } from '@rab/shared';
import { Command, CommandRunner } from 'nest-commander';
import { DataSource } from 'typeorm';

import {
  Organisation,
  Permission,
  Role,
  RolePermission,
  User,
  UserRole,
} from '../modules/identity/entities';
import { PasswordHashingService } from '../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { ManagerWorkspace } from '../modules/manager-workspace/entities/manager-workspace.entity';
import { ROLE_DEFS } from '../modules/manager/services/manager.service';
import { STAFF_ROLE_KEY, STAFF_ROLE_PERMISSIONS } from '../modules/staff/services/staff.service';
import { JobRole } from '../modules/scheduling/entities/job-role.entity';
import { Venue } from '../modules/venue/entities/venue.entity';

const SEED_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Manual-QA-only fixture: ONE organisation, ONE Internal Manager (+
 * workspace), ONE Venue Manager, ONE Venue, ONE Job Role, FIVE Staff — the
 * minimum topology a human needs to run the Venue Manager -> Internal
 * Manager -> 5 staff -> clock in/out -> report/timesheet workflow by hand.
 *
 * Deliberately NOT `TestIdentityFactory` reused verbatim (that class needs a
 * running `INestApplication`/supertest harness for its login helpers, which
 * a one-shot CLI command doesn't have) — but every write below follows its
 * exact same shape: real `Role`/`RolePermission` rows from the PRODUCTION
 * `ROLE_DEFS`/`STAFF_ROLE_PERMISSIONS` constants (imported, never copied),
 * real `ManagerWorkspace`/`Venue`/`JobRole` entity saves (not raw SQL for
 * anything with a decorated entity), and the same `runInTenantContext`
 * pattern every real request uses — so this fixture can never drift from
 * what production code actually considers a valid Internal
 * Manager/Workspace/Venue Manager/Staff shape. Idempotent: safe to re-run.
 */
@Command({
  name: 'seed-qa',
  description: 'Seed the minimal manual-QA fixture (ADOLPHUS QA org, 1 Internal Manager, 1 Venue Manager, 1 Venue, 1 Job Role, 5 Staff)',
})
export class SeedQaCommand extends CommandRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly passwordHashing: PasswordHashingService,
  ) {
    super();
  }

  async run(): Promise<void> {
    for (const key of Object.values(PermissionFlag)) {
      const existing = await this.dataSource.manager.findOne(Permission, { where: { key } });
      if (existing) continue;
      const [resource, action] = key.split('.');
      await this.dataSource.manager.insert(Permission, { key, resource, action });
    }

    const slug = 'adolphus-qa';
    let organisation = await this.dataSource.manager.findOne(Organisation, { where: { slug } });
    if (!organisation) {
      const result = await this.dataSource.manager.insert(Organisation, { name: 'ADOLPHUS QA', slug });
      organisation = await this.dataSource.manager.findOneByOrFail(Organisation, { id: result.identifiers[0]!.id as string });
    }
    const organisationId = organisation.id;
    const password = process.env.SEED_QA_PASSWORD ?? 'QaManualTest123!';
    const passwordHash = await this.passwordHashing.hash(password);

    const bootstrapCtx: AuthContext = { organisationId, workspaceId: null, userId: SEED_ACTOR_ID, role: '' };

    // ---- Internal Manager + Workspace ----------------------------------
    let managerUserId!: string;
    let workspaceId!: string;
    await this.tenantContext.runInTenantContext(bootstrapCtx, async (m) => {
      const def = ROLE_DEFS[ManagerType.INTERNAL]!;
      let role = await m.findOne(Role, { where: { organisationId, key: def.key } });
      if (!role) {
        const permissions = await Promise.all(def.permissions.map((k) => m.findOneByOrFail(Permission, { key: k })));
        const result = await m.insert(Role, { organisationId, key: def.key, name: def.name, isSystem: true });
        role = await m.findOneByOrFail(Role, { id: result.identifiers[0]!.id as string });
        await m.insert(RolePermission, permissions.map((p) => ({ roleId: role!.id, permissionId: p.id, organisationId })));
      }

      let user = await m.findOne(User, { where: { organisationId, email: 'manager.qa@example.test' } });
      if (!user) {
        const result = await m.insert(User, {
          organisationId,
          email: 'manager.qa@example.test',
          passwordHash,
          firstName: 'Internal',
          lastName: 'Manager QA',
          status: UserStatus.ACTIVE,
        });
        user = await m.findOneByOrFail(User, { id: result.identifiers[0]!.id as string });
        await m.insert(UserRole, { userId: user.id, roleId: role.id, organisationId });
      }
      managerUserId = user.id;

      let workspace = await m.findOne(ManagerWorkspace, { where: { ownerUserId: managerUserId } });
      if (!workspace) {
        await m.query(`SELECT set_config('rab.user_id', $1, true)`, [managerUserId]);
        workspace = await m.save(ManagerWorkspace, {
          organisationId,
          ownerUserId: managerUserId,
          name: 'ADOLPHUS QA Workspace',
          subdomain: 'adolphus-qa',
          status: 'active',
        });
      }
      workspaceId = workspace.id;

      const existingProfile = await m.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [managerUserId]);
      if (existingProfile.length === 0) {
        await m.query(
          `INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4)`,
          [organisationId, managerUserId, ManagerType.INTERNAL, workspaceId],
        );
      }
    });

    // ---- Venue + Job Role (owner's tenant context) ---------------------
    let venueId!: string;
    let jobRoleId!: string;
    try {
      await this.tenantContext.runInTenantContext({ organisationId, workspaceId, userId: managerUserId, role: '' }, async (m) => {
        let venue = await m.findOne(Venue, { where: { organisationId, workspaceId, name: 'ADOLPHUS QA Venue' } });
        if (!venue) {
          venue = await m.save(Venue, { organisationId, workspaceId, name: 'ADOLPHUS QA Venue', createdBy: managerUserId });
        }
        venueId = venue.id;

        let jobRole = await m.findOne(JobRole, { where: { organisationId, workspaceId, name: 'Bartender' } });
        if (!jobRole) {
          jobRole = await m.save(JobRole, { organisationId, workspaceId, name: 'Bartender', defaultRatePence: 1300, createdBy: managerUserId });
        }
        jobRoleId = jobRole.id;
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('seed-qa: venue/job-role transaction failed:', err);
      throw err;
    }

    // ---- Venue Manager ---------------------------------------------------
    let venueManagerUserId!: string;
    await this.tenantContext.runInTenantContext({ organisationId, workspaceId, userId: managerUserId, role: '' }, async (m) => {
      const def = ROLE_DEFS[ManagerType.VENUE]!;
      let role = await m.findOne(Role, { where: { organisationId, key: def.key } });
      if (!role) {
        const permissions = await Promise.all(def.permissions.map((k) => m.findOneByOrFail(Permission, { key: k })));
        const result = await m.insert(Role, { organisationId, key: def.key, name: def.name, isSystem: true });
        role = await m.findOneByOrFail(Role, { id: result.identifiers[0]!.id as string });
        await m.insert(RolePermission, permissions.map((p) => ({ roleId: role!.id, permissionId: p.id, organisationId })));
      }

      let user = await m.findOne(User, { where: { organisationId, email: 'venue.qa@example.test' } });
      if (!user) {
        const result = await m.insert(User, {
          organisationId,
          email: 'venue.qa@example.test',
          passwordHash,
          firstName: 'Venue',
          lastName: 'Manager QA',
          status: UserStatus.ACTIVE,
        });
        user = await m.findOneByOrFail(User, { id: result.identifiers[0]!.id as string });
        await m.insert(UserRole, { userId: user.id, roleId: role.id, organisationId });
      }
      venueManagerUserId = user.id;

      const existingProfile = await m.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [venueManagerUserId]);
      let venueManagerProfileId: string;
      if (existingProfile.length === 0) {
        const inserted = await m.query(
          `INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`,
          [organisationId, venueManagerUserId, ManagerType.VENUE, workspaceId],
        );
        venueManagerProfileId = inserted[0].id as string;
      } else {
        venueManagerProfileId = existingProfile[0].id as string;
      }

      const existingAssignment = await m.query(
        `SELECT 1 FROM core.manager_venue WHERE manager_profile_id = $1 AND venue_id = $2`,
        [venueManagerProfileId, venueId],
      );
      if (existingAssignment.length === 0) {
        await m.query(
          `INSERT INTO core.manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id) VALUES ($1, $2, $3, $4)`,
          [organisationId, venueManagerProfileId, venueId, workspaceId],
        );
      }
    });

    // ---- 5 Staff -----------------------------------------------------
    await this.tenantContext.runInTenantContext({ organisationId, workspaceId, userId: managerUserId, role: '' }, async (m) => {
      let role = await m.findOne(Role, { where: { organisationId, key: STAFF_ROLE_KEY } });
      if (!role) {
        const permissions = await Promise.all(STAFF_ROLE_PERMISSIONS.map((k) => m.findOneByOrFail(Permission, { key: k })));
        const result = await m.insert(Role, { organisationId, key: STAFF_ROLE_KEY, name: 'Staff', isSystem: true });
        role = await m.findOneByOrFail(Role, { id: result.identifiers[0]!.id as string });
        await m.insert(RolePermission, permissions.map((p) => ({ roleId: role!.id, permissionId: p.id, organisationId })));
      }

      for (let i = 1; i <= 5; i++) {
        const email = `staff0${i}.qa@example.test`;
        let user = await m.findOne(User, { where: { organisationId, email } });
        if (!user) {
          const result = await m.insert(User, {
            organisationId,
            email,
            passwordHash,
            firstName: 'Staff',
            lastName: `QA ${i}`,
            status: UserStatus.ACTIVE,
          });
          user = await m.findOneByOrFail(User, { id: result.identifiers[0]!.id as string });
          await m.insert(UserRole, { userId: user.id, roleId: role!.id, organisationId });
        }
        const existingProfile = await m.query(`SELECT id FROM core.staff_profile WHERE user_id = $1`, [user.id]);
        if (existingProfile.length === 0) {
          await m.query(
            `INSERT INTO core.staff_profile (organisation_id, user_id, staff_ref, created_by, workspace_id, employment_status, job_role_id)
             VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
            [organisationId, user.id, `QA-STF-0${i}`, managerUserId, workspaceId, jobRoleId],
          );
        }
      }
    });

    // eslint-disable-next-line no-console
    console.log(
      [
        'Seeded QA fixture — organisation "adolphus-qa"',
        `  manager.qa@example.test (Internal Manager, workspace ${workspaceId})`,
        `  venue.qa@example.test (Venue Manager, venue ${venueId})`,
        '  staff01.qa@example.test .. staff05.qa@example.test (Staff, Bartender role)',
        `  shared password: see SEED_QA_PASSWORD env var or the default used this run`,
      ].join('\n'),
    );
  }
}
