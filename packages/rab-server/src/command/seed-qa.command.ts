import { ManagerType, PermissionFlag, UserStatus } from '@rab/shared';
import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource, EntityManager } from 'typeorm';

import {
  Permission,
  Role,
  RolePermission,
  User,
  UserRole,
} from '../modules/identity/entities';
import { AuditAction, AuditService } from '../engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { ManagerWorkspace } from '../modules/manager-workspace/entities/manager-workspace.entity';
import { ROLE_DEFS } from '../modules/manager/services/manager.service';
import { STAFF_ROLE_KEY, STAFF_ROLE_PERMISSIONS } from '../modules/staff/services/staff.service';
import { JobRole } from '../modules/scheduling/entities/job-role.entity';
import { Venue } from '../modules/venue/entities/venue.entity';

const SEED_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
export const QA_ORGANISATION_NAME = 'ADOLPHUS QA';
export const QA_ORGANISATION_SLUG = 'adolphus-qa';

interface SeedQaOptions {
  adminEmail?: string;
}

/**
 * Who may authorise the QA organisation: exactly one live account with this email that holds an unrevoked platform
 * administrator grant (`core.is_active_platform_admin`, the same predicate `core.create_organisation()` re-checks, CF-13).
 * ACTIVE or INVITED: a fresh deploy's first administrator is created INVITED by `bootstrap-admin` and is already an
 * active platform administrator to the database. Any other account status is refused here.
 */
const ADMIN_STATUSES: ReadonlySet<string> = new Set<string>([UserStatus.ACTIVE, UserStatus.INVITED]);

/**
 * USER → WORKSPACE membership for a QA fixture user (Hyper Workspace Phase 3). Same row the production write paths
 * write; the workspace is bound transaction-locally for this one INSERT, matching the RLS insert predicate.
 */
async function insertQaMembership(m: EntityManager, organisationId: string, userId: string, workspaceId: string): Promise<void> {
  await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [organisationId, workspaceId]);
  await m.query(
    `INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source)
     VALUES ($1, $2, $3, 'active', 'write_path')
     ON CONFLICT (user_id, workspace_id) DO NOTHING`,
    [organisationId, userId, workspaceId],
  );
}

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
 *
 * Runs as the restricted runtime identity (`crewflow_app`), like every API/Worker request: no owner, superuser or
 * BYPASSRLS connection. The organisation is the one row that identity cannot INSERT directly (`organisation_self` RLS,
 * `id = current_org()`, can never hold for a row that does not exist yet), so it is created the way production creates
 * one: `core.create_organisation()` (CreateOrganisationFunction1786706000000; CF-13 in DatabaseDefenceInDepth1786717900000)
 * under the authority of the active platform administrator named by `--admin-email`, followed by the
 * `organisation.created` audit entry (the call pattern of `OrganisationOnboardingService.acceptCeoInvitationTx` and
 * `seed-ai-demo`). On a fresh database, create that administrator first with `bootstrap-admin` (the one-time operator step).
 */
@Command({
  name: 'seed-qa',
  description:
    'Seed the minimal manual-QA fixture (ADOLPHUS QA org, 1 Internal Manager, 1 Venue Manager, 1 Venue, 1 Job Role, 5 Staff); ' +
    'requires --admin-email <active platform administrator>',
})
export class SeedQaCommand extends CommandRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly passwordHashing: PasswordHashingService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  @Option({ flags: '--admin-email <email>', description: 'An active platform administrator who authorises creating the QA organisation (required)' })
  parseAdminEmail(value: string): string {
    return value.trim().toLowerCase();
  }

  async run(_params: string[] = [], options: SeedQaOptions = {}): Promise<void> {
    // Every refusal comes before the first write.
    // No default: QA accounts take a generated per-run credential from the operator, never a shared literal.
    const password = process.env.SEED_QA_PASSWORD;
    if (!password || password.length < 12) {
      throw new Error('SEED_QA_PASSWORD is required (at least 12 characters). Generate one per run; it is never a default.');
    }
    if (!options.adminEmail) {
      throw new Error(
        'seed-qa refused: --admin-email <active platform administrator> is required (on a fresh database, create one with bootstrap-admin first). Nothing was changed.',
      );
    }

    // `core.permission` is global reference data (no RLS, no organisation_id); the runtime role holds SELECT, INSERT on it
    // (ReconcileCoreOwnershipAndRuntimeGrants1786717700000). The catalogue migrations normally already wrote every key.
    for (const key of Object.values(PermissionFlag)) {
      const existing = await this.dataSource.manager.findOne(Permission, { where: { key } });
      if (existing) continue;
      const [resource, action] = key.split('.');
      await this.dataSource.manager.insert(Permission, { key, resource, action });
    }

    const organisationId = await this.ensureOrganisation(options.adminEmail);
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

      // The workspace and the manager's own profile are written as that manager, in that workspace, exactly as the
      // ordinary onboarding write path binds them (manager_workspace / manager_profile RLS).
      await m.query(`SELECT set_config('rab.user_id', $1, true)`, [managerUserId]);
      let workspace = await m.findOne(ManagerWorkspace, { where: { ownerUserId: managerUserId } });
      if (!workspace) {
        workspace = await m.save(ManagerWorkspace, {
          organisationId,
          ownerUserId: managerUserId,
          name: 'ADOLPHUS QA Workspace',
          subdomain: 'adolphus-qa',
          status: 'active',
          // As ManagerWorkspaceService.create writes it: the schema is built next, on the server path.
          schemaStatus: 'CREATING',
        });
      }
      workspaceId = workspace.id;
      // Part C1: the workspace's schema, built the way the API builds it (core.provision_workspace, server path; the same
      // definer seed-ai-demo calls), in this transaction with the organisation and the OWNER bound — the function's own
      // predicate refuses anything else. Without a READY schema every workspace-routed write below is refused once HWS
      // runtime routing is on (the default outside production). Idempotent: ALREADY_READY on a re-run.
      if (workspace.schemaStatus !== 'READY') {
        const [{ outcome }] = await m.query<Array<{ outcome: string }>>('SELECT core.provision_workspace($1) AS outcome', [workspaceId]);
        if (outcome !== 'READY' && outcome !== 'ALREADY_READY') {
          throw new Error(`seed-qa: workspace provisioning ended ${outcome}. Nothing was committed.`);
        }
      }
      await m.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);

      const existingProfile = await m.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [managerUserId]);
      if (existingProfile.length === 0) {
        await m.query(
          `INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4)`,
          [organisationId, managerUserId, ManagerType.INTERNAL, workspaceId],
        );
      }
      await insertQaMembership(m, organisationId, managerUserId, workspaceId);
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
      await insertQaMembership(m, organisationId, venueManagerUserId, workspaceId);

      const existingAssignment = await m.query(
        `SELECT 1 FROM manager_venue WHERE manager_profile_id = $1 AND venue_id = $2`,
        [venueManagerProfileId, venueId],
      );
      if (existingAssignment.length === 0) {
        await m.query(
          `INSERT INTO manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id) VALUES ($1, $2, $3, $4)`,
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
        const existingProfile = await m.query(`SELECT id FROM staff_profile WHERE user_id = $1`, [user.id]);
        if (existingProfile.length === 0) {
          await m.query(
            `INSERT INTO staff_profile (organisation_id, user_id, staff_ref, created_by, workspace_id, employment_status, job_role_id)
             VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
            [organisationId, user.id, `QA-STF-0${i}`, managerUserId, workspaceId, jobRoleId],
          );
        }
        await insertQaMembership(m, organisationId, user.id, workspaceId);
      }
    });

    // eslint-disable-next-line no-console
    console.log(
      [
        `Seeded QA fixture — organisation "${QA_ORGANISATION_SLUG}"`,
        `  manager.qa@example.test (Internal Manager, workspace ${workspaceId})`,
        `  venue.qa@example.test (Venue Manager, venue ${venueId})`,
        '  staff01.qa@example.test .. staff05.qa@example.test (Staff, Bartender role)',
        '  shared password: taken from SEED_QA_PASSWORD (value not printed)',
      ].join('\n'),
    );
  }

  /**
   * The QA organisation, found or created under the named platform administrator's authority, in ONE transaction.
   * Found through `core.list_organisations_for_admin()` (the runtime RLS on `organisation` hides every row while no
   * tenant is bound); created through `core.create_organisation()`, which re-checks the administrator itself (CF-13).
   */
  private async ensureOrganisation(adminEmail: string): Promise<string> {
    return this.dataSource.transaction(async (m) => {
      const adminUserId = await this.resolveAdmin(m, adminEmail);
      const [existing] = await m.query<Array<{ id: string }>>(`SELECT id FROM core.list_organisations_for_admin() WHERE slug = $1`, [QA_ORGANISATION_SLUG]);
      if (existing) return existing.id;

      const [{ create_organisation: organisationId }] = await m.query<Array<{ create_organisation: string }>>(
        'SELECT core.create_organisation($1, $2) AS create_organisation',
        [QA_ORGANISATION_NAME, QA_ORGANISATION_SLUG],
      );
      const ctx: AuthContext = { organisationId, workspaceId: null, userId: adminUserId, role: '' };
      await this.tenantContext.bindCoreIdentityGucs(m, ctx);
      await this.audit.record(m, ctx, AuditAction.ORGANISATION_CREATED, {
        entityType: 'organisation',
        entityId: organisationId,
        metadata: { name: QA_ORGANISATION_NAME, slug: QA_ORGANISATION_SLUG, via: 'seed-qa' },
      });
      return organisationId;
    });
  }

  /** Binds `rab.user_id` to the administrator on this transaction and returns its id, or refuses. */
  private async resolveAdmin(m: EntityManager, email: string): Promise<string> {
    // The pre-auth lookup definer (the runtime `user` RLS hides other organisations' rows); only id + status are read.
    const users = await m.query<Array<{ id: string; status: string }>>(`SELECT id, status FROM core.auth_find_users_by_email($1)`, [email]);
    const user = users.length === 1 && ADMIN_STATUSES.has(users[0]!.status) ? users[0] : undefined;
    if (user) {
      await m.query(`SELECT set_config('rab.user_id', $1, true)`, [user.id]);
      const [admin] = await m.query<Array<{ ok: boolean }>>(`SELECT core.is_active_platform_admin($1) AS ok`, [user.id]);
      if (admin?.ok) return user.id;
    }
    throw new Error('seed-qa refused: --admin-email is not an active platform administrator. Nothing was changed.');
  }
}
