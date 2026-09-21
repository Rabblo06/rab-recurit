import { ManagerType, ManagerTypeType, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { ApplicationTarget } from '../../../engine/core-modules/auth/application-access';
import { PasswordHashingService } from '../../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { Organisation, Permission, Role, RolePermission, User, UserRole } from '../../../modules/identity/entities';
import { ROLE_DEFS } from '../../../modules/manager/services/manager.service';
import { ManagerWorkspace } from '../../../modules/manager-workspace/entities/manager-workspace.entity';
import { STAFF_ROLE_KEY, STAFF_ROLE_PERMISSIONS } from '../../../modules/staff/services/staff.service';

/**
 * THE shared production-style identity factory for integration/security
 * suites. One place that knows how a real RAB identity is shaped, so no
 * suite hand-rolls roles, workspaces or login again.
 *
 * Why this exists (proven, see the auth-flow trace in the production
 * readiness report): `POST /auth/login` resolves the account's ROLE KEYS and
 * hands them to `applicationAllowed()` (`engine/core-modules/auth/
 * application-access.ts`), which matches them EXACTLY:
 *
 *   venue_manager -> venue_manager_app only
 *   manager | ceo | org_admin | super_admin | admin -> every app
 *   staff -> staff_app only
 *
 * A suite that minted `owner-<uuid>`, `manager-<uuid>` or `everything` as a
 * role key therefore got `403 APPLICATION_ACCESS_DENIED` at login, before a
 * single security assertion ran. The fix is never to loosen that gate — it
 * is to build identities exactly the way production does:
 *
 *   Internal Manager: role `manager` (production permission set) + User +
 *     ManagerWorkspace (they own it) + ManagerProfile(type INTERNAL).
 *   CEO:              same, role `ceo`, ManagerProfile(type CEO).
 *   Venue Manager:    role `venue_manager` + User + ManagerProfile(type VENUE)
 *     (+ optional `manager_venue` rows).
 *   Staff:            role `staff` + User + StaffProfile in the owning
 *     Manager's workspace.
 *
 * Role permissions default to the PRODUCTION sets (`ROLE_DEFS`,
 * `STAFF_ROLE_PERMISSIONS` — imported, not copied, so they can never drift).
 * A suite that needs a narrower or wider permission set (e.g. "a manager
 * without offer.confirm", "a manager holding every flag") passes
 * `permissions` — the ROLE KEY stays canonical, which is what application
 * access checks; permissions are what the PermissionGuard checks.
 *
 * Login never silently degrades: a setup/login failure throws
 * `TestSetupError` naming the identity, role and target, so a suite can
 * never look like an assertion failure when it actually never reached one.
 */

export const TEST_PASSWORD = 'correct horse battery staple 1!';

export class TestSetupError extends Error {
  constructor(message: string) {
    super(`TEST SETUP FAILED (not a security assertion): ${message}`);
    this.name = 'TestSetupError';
  }
}

export type TestIdentityKind = 'internal_manager' | 'ceo' | 'venue_manager' | 'staff' | 'org_admin';

export interface TestIdentity {
  kind: TestIdentityKind;
  organisationId: string;
  userId: string;
  email: string;
  password: string;
  roleKey: string;
  /** The workspace this identity operates inside (owner's own for managers, the creator's for staff/venue managers). */
  workspaceId: string | null;
  /** `manager_profile.id` (managers) or `staff_profile.id` (staff). */
  profileId: string | null;
  /** The application a real client would sign this identity into by default. */
  defaultApplication: ApplicationTarget;
}

export interface TestInfra {
  app: INestApplication;
  dataSource: DataSource;
  /** `rab_owner` connection — bootstrap-only writes (organisation, platform_admin). */
  adminDataSource: DataSource;
  tenantContext: TenantContextService;
  passwordHashing: PasswordHashingService;
}

/** Every factory method only needs the org id; suites that carry just an id can pass `{ id }`. */
export type OrgRef = Pick<Organisation, 'id'>;

export type PermissionSpec = 'production' | 'all' | readonly string[];

interface ProbeState {
  logins: number;
  loginFailures: number;
}
const probe = ((globalThis as unknown as { __RAB_TEST_PROBE__?: ProbeState }).__RAB_TEST_PROBE__ ??= { logins: 0, loginFailures: 0 });

const bootstrapContext = (organisationId: string, workspaceId: string | null = null) => ({
  organisationId,
  workspaceId,
  userId: randomUUID(),
  role: '',
});

export class TestIdentityFactory {
  constructor(private readonly infra: TestInfra) {}

  // ---------------------------------------------------------------- basics

  async createOrganisation(label = 'test'): Promise<Organisation> {
    const slug = `${label}-${randomUUID()}`;
    const result = await this.infra.adminDataSource.manager.insert(Organisation, { name: slug, slug });
    return this.infra.adminDataSource.manager.findOneByOrFail(Organisation, { id: result.identifiers[0]!.id as string });
  }

  private async ensurePermissions(keys: readonly string[]): Promise<Permission[]> {
    const out: Permission[] = [];
    for (const key of keys) {
      let permission = await this.infra.dataSource.manager.findOne(Permission, { where: { key } });
      if (!permission) {
        const [resource, action] = key.split('.');
        permission = await this.infra.dataSource.manager.save(Permission, { key, resource: resource!, action: action ?? key });
      }
      out.push(permission);
    }
    return out;
  }

  private resolvePermissions(spec: PermissionSpec | undefined, production: readonly string[]): readonly string[] {
    if (!spec || spec === 'production') return production;
    if (spec === 'all') return Object.values(PermissionFlag);
    return spec;
  }

  /**
   * Find-or-create the CANONICAL role for this organisation (`core.role` is
   * `UNIQUE (organisation_id, key)`, so every identity of one kind in an org
   * shares one role, exactly as production does). If the role already exists
   * with a DIFFERENT permission set, throw rather than silently keeping or
   * widening it — two identities in one org that need different permissions
   * must be a deliberate, visible test-authoring decision.
   */
  async provisionRole(m: EntityManager, organisationId: string, key: string, name: string, permissionKeys: readonly string[]): Promise<Role> {
    const permissions = await this.ensurePermissions(permissionKeys);
    // Concurrent identity creation (e.g. a load test seeding staff in parallel) must not race the
    // find-then-insert below into a unique-key violation: serialise per (organisation, role key).
    // Transaction-scoped, so it is released when the caller's transaction commits and the next
    // caller then sees the committed role.
    await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`test-identity-role:${organisationId}:${key}`]);
    const existing = await m.findOne(Role, { where: { organisationId, key } });
    if (existing) {
      const current = await m
        .createQueryBuilder(RolePermission, 'rp')
        .innerJoin(Permission, 'p', 'p.id = rp.permission_id')
        .where('rp.role_id = :roleId', { roleId: existing.id })
        .select('p.key', 'key')
        .getRawMany<{ key: string }>();
      const have = new Set(current.map((r) => r.key));
      const want = new Set(permissionKeys);
      if (have.size !== want.size || [...want].some((k) => !have.has(k))) {
        throw new TestSetupError(
          `role "${key}" already exists in organisation ${organisationId} with a different permission set — ` +
            'two identities sharing one canonical role must share its permissions (pick a different organisation or the same permissions).',
        );
      }
      return existing;
    }
    const result = await m.insert(Role, { organisationId, key, name, isSystem: true });
    const role = await m.findOneByOrFail(Role, { id: result.identifiers[0]!.id as string });
    if (permissions.length) {
      await m.insert(
        RolePermission,
        permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id, organisationId })),
      );
    }
    return role;
  }

  private async insertUser(m: EntityManager, organisationId: string, email: string, firstName: string, lastName: string, status: string): Promise<string> {
    const result = await m.insert(User, {
      organisationId,
      email,
      passwordHash: await this.infra.passwordHashing.hash(TEST_PASSWORD),
      firstName,
      lastName,
      status: status as never,
    });
    return result.identifiers[0]!.id as string;
  }

  // ------------------------------------------------------------- managers

  /**
   * Internal Manager (`manager`) or CEO — owns a real `ManagerWorkspace`,
   * has a `ManagerProfile`, and can sign into every application.
   * `platformAdmin: true` additionally grants the platform-admin claim
   * (written via the owner connection, exactly like the bootstrap CLI).
   */
  async createInternalManager(
    org: OrgRef,
    opts: { permissions?: PermissionSpec; platformAdmin?: boolean; label?: string; type?: ManagerTypeType; workspace?: boolean } = {},
  ): Promise<TestIdentity> {
    const type = opts.type ?? ManagerType.INTERNAL;
    const def = ROLE_DEFS[type]!;
    const label = opts.label ?? (type === ManagerType.CEO ? 'ceo' : 'mgr');
    const email = `${label}-${randomUUID()}@example.test`;
    let userId!: string;
    let workspaceId: string | undefined;
    let profileId!: string;

    await this.infra.tenantContext.runInTenantContext(bootstrapContext(org.id), async (m) => {
      const role = await this.provisionRole(m, org.id, def.key, def.name, this.resolvePermissions(opts.permissions, def.permissions));
      userId = await this.insertUser(m, org.id, email, type === ManagerType.CEO ? 'Ceo' : 'Manager', 'Test', UserStatus.ACTIVE);
      await m.insert(UserRole, { userId, roleId: role.id, organisationId: org.id });
      if (opts.workspace !== false) {
        // `manager_workspace_write`'s WITH CHECK needs owner_user_id = current_uid():
        // rebind from this transaction's throwaway bootstrap identity to the real user.
        await m.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
        const workspace = await m.save(ManagerWorkspace, {
          organisationId: org.id,
          ownerUserId: userId,
          name: `Test Workspace ${userId}`,
          subdomain: `test-${userId.slice(0, 8)}`,
          status: 'active',
        });
        workspaceId = workspace.id;
      }
      // `workspace: false` models a Manager who has not completed workspace onboarding yet.
      const profile = await m.query(
        `INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [org.id, userId, type, workspaceId ?? null],
      );
      profileId = profile[0].id as string;
    });

    if (opts.platformAdmin) await this.grantPlatformAdmin(userId);

    return {
      kind: type === ManagerType.CEO ? 'ceo' : 'internal_manager',
      organisationId: org.id,
      userId,
      email,
      password: TEST_PASSWORD,
      roleKey: def.key,
      workspaceId: workspaceId ?? null,
      profileId,
      defaultApplication: 'manager_web',
    };
  }

  /** N Internal Managers in ONE organisation sharing the canonical `manager` role; the first optionally a platform admin (what most abuse suites need for admin-only endpoints). */
  async createOrganisationWithManagers(
    count: number,
    opts: { permissions?: PermissionSpec; firstIsPlatformAdmin?: boolean; workspace?: boolean; label?: string } = {},
  ): Promise<{ organisation: Organisation; managers: TestIdentity[] }> {
    const organisation = await this.createOrganisation();
    const managers: TestIdentity[] = [];
    for (let i = 0; i < count; i++) {
      managers.push(
        await this.createInternalManager(organisation, {
          permissions: opts.permissions,
          workspace: opts.workspace,
          label: opts.label,
          platformAdmin: !!opts.firstIsPlatformAdmin && i === 0,
        }),
      );
    }
    return { organisation, managers };
  }

  createCeo(org: OrgRef, opts: { permissions?: PermissionSpec; platformAdmin?: boolean } = {}): Promise<TestIdentity> {
    return this.createInternalManager(org, { ...opts, type: ManagerType.CEO });
  }

  /** Org owner/admin — the production `org_admin` role key (every application), for suites about org-level administration. */
  async createOrgAdmin(org: OrgRef, opts: { permissions?: PermissionSpec; platformAdmin?: boolean } = {}): Promise<TestIdentity> {
    const email = `admin-${randomUUID()}@example.test`;
    let userId!: string;
    await this.infra.tenantContext.runInTenantContext(bootstrapContext(org.id), async (m) => {
      const role = await this.provisionRole(m, org.id, 'org_admin', 'Org Admin', this.resolvePermissions(opts.permissions, []));
      userId = await this.insertUser(m, org.id, email, 'Org', 'Admin', UserStatus.ACTIVE);
      await m.insert(UserRole, { userId, roleId: role.id, organisationId: org.id });
    });
    if (opts.platformAdmin) await this.grantPlatformAdmin(userId);
    return { kind: 'org_admin', organisationId: org.id, userId, email, password: TEST_PASSWORD, roleKey: 'org_admin', workspaceId: null, profileId: null, defaultApplication: 'manager_web' };
  }

  /** Written via `rab_owner`: `platform_admin`'s write policy needs an ACTING admin, impossible for a first grant — same as the real bootstrap CLI. */
  async grantPlatformAdmin(userId: string): Promise<void> {
    await this.infra.adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  }

  // -------------------------------------------------------- venue manager

  /**
   * Venue Manager: `venue_manager` role, `ManagerProfile(type VENUE)` inside
   * the owning Internal Manager's workspace. `venueIds` are assigned through
   * `manager_venue` under the owner's tenant context (same rows the real
   * assign-venue endpoint writes).
   */
  async createVenueManager(
    org: OrgRef,
    opts: { owner: TestIdentity; venueIds?: string[]; permissions?: PermissionSpec; label?: string },
  ): Promise<TestIdentity> {
    if (!opts.owner.workspaceId) throw new TestSetupError('createVenueManager needs an owner identity that has a workspace');
    const def = ROLE_DEFS[ManagerType.VENUE]!;
    const email = `${opts.label ?? 'venuemgr'}-${randomUUID()}@example.test`;
    let userId!: string;
    let profileId!: string;
    await this.infra.tenantContext.runInTenantContext(bootstrapContext(org.id, opts.owner.workspaceId), async (m) => {
      const role = await this.provisionRole(m, org.id, def.key, def.name, this.resolvePermissions(opts.permissions, def.permissions));
      userId = await this.insertUser(m, org.id, email, 'VenueMgr', 'Test', UserStatus.ACTIVE);
      await m.insert(UserRole, { userId, roleId: role.id, organisationId: org.id });
      const profile = await m.query(
        `INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [org.id, userId, ManagerType.VENUE, opts.owner.workspaceId],
      );
      profileId = profile[0].id as string;
    });
    for (const venueId of opts.venueIds ?? []) await this.assignVenue(org, opts.owner, profileId, venueId);
    return {
      kind: 'venue_manager',
      organisationId: org.id,
      userId,
      email,
      password: TEST_PASSWORD,
      roleKey: def.key,
      workspaceId: opts.owner.workspaceId,
      profileId,
      defaultApplication: 'venue_manager_app',
    };
  }

  async assignVenue(org: OrgRef, owner: TestIdentity, managerProfileId: string, venueId: string): Promise<void> {
    await this.infra.tenantContext.runInTenantContext(
      { organisationId: org.id, workspaceId: owner.workspaceId, userId: owner.userId, role: '' },
      (m) =>
        m.query(`INSERT INTO core.manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id) VALUES ($1, $2, $3, $4)`, [
          org.id,
          managerProfileId,
          venueId,
          owner.workspaceId,
        ]),
    );
  }

  // ---------------------------------------------------------------- staff

  /** Staff: `staff` role (production permission set), `StaffProfile` created by and inside the owner's workspace. */
  async createStaff(org: OrgRef, opts: { owner: Pick<TestIdentity, 'userId' | 'workspaceId'>; permissions?: PermissionSpec; label?: string; status?: string }): Promise<TestIdentity> {
    if (!opts.owner.workspaceId) throw new TestSetupError('createStaff needs an owner identity that has a workspace');
    const email = `${opts.label ?? 'staff'}-${randomUUID()}@example.test`;
    let userId!: string;
    let profileId!: string;
    await this.infra.tenantContext.runInTenantContext(bootstrapContext(org.id, opts.owner.workspaceId), async (m) => {
      const role = await this.provisionRole(m, org.id, STAFF_ROLE_KEY, 'Staff', this.resolvePermissions(opts.permissions, STAFF_ROLE_PERMISSIONS));
      userId = await this.insertUser(m, org.id, email, 'Staff', 'Member', opts.status ?? UserStatus.ACTIVE);
      await m.insert(UserRole, { userId, roleId: role.id, organisationId: org.id });
      const profile = await m.query(
        `INSERT INTO core.staff_profile (organisation_id, user_id, staff_ref, created_by, workspace_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [org.id, userId, `STF-${randomUUID().slice(0, 8)}`, opts.owner.userId, opts.owner.workspaceId],
      );
      profileId = profile[0].id as string;
    });
    return {
      kind: 'staff',
      organisationId: org.id,
      userId,
      email,
      password: TEST_PASSWORD,
      roleKey: STAFF_ROLE_KEY,
      workspaceId: opts.owner.workspaceId,
      profileId,
      defaultApplication: 'staff_app',
    };
  }

  // ---------------------------------------------------------------- login

  /**
   * The real login request a real client of this kind makes. Staff and Venue
   * Manager use the mobile platform header (server derives `staff_app` /
   * `venue_manager_app` from the account's real roles); Internal
   * Manager/CEO/org admin sign into the web console (default `manager_web`).
   * `applicationTarget` sends an explicit target instead — used to exercise
   * an Internal Manager's deliberate multi-app access, or to prove a role is
   * DENIED an app it must not reach.
   */
  loginRaw(
    identity: Pick<TestIdentity, 'kind' | 'email' | 'password'>,
    opts: { applicationTarget?: ApplicationTarget; email?: string; password?: string; mobile?: boolean } = {},
  ) {
    const req = request(this.infra.app.getHttpServer()).post('/rest/v1/auth/login');
    const mobileClient = identity.kind === 'staff' || identity.kind === 'venue_manager';
    // `mobile: true` forces the mobile platform header (the API then returns the refresh token in the body, as the real app receives it).
    if ((mobileClient && !opts.applicationTarget) || opts.mobile) req.set('x-client-platform', 'mobile');
    const body: Record<string, unknown> = { email: opts.email ?? identity.email, password: opts.password ?? identity.password };
    if (opts.applicationTarget) body.applicationTarget = opts.applicationTarget;
    return req.send(body);
  }

  /** Returns the access token, or throws `TestSetupError` — never a bare `expect` failure that looks like a security assertion. */
  async login(
    identity: Pick<TestIdentity, 'kind' | 'email' | 'password'> & Partial<Pick<TestIdentity, 'roleKey' | 'defaultApplication'>>,
    opts: { applicationTarget?: ApplicationTarget } = {},
  ): Promise<string> {
    const res = await this.loginRaw(identity, opts);
    if (res.status !== 200) {
      probe.loginFailures++;
      const target = opts.applicationTarget ?? identity.defaultApplication ?? '(default for kind)';
      throw new TestSetupError(
        `login as ${identity.kind} (role "${identity.roleKey ?? 'unknown'}", application ${target}) returned ${res.status} ` +
          `${JSON.stringify(res.body?.code ?? res.body?.message ?? res.body)}. ` +
          'This suite never reached its assertions — fix the identity, do not loosen application access.',
      );
    }
    probe.logins++;
    return res.body.accessToken as string;
  }

  /** Access + refresh token as a mobile client receives them (refresh token in the JSON body). */
  async loginTokens(
    identity: Pick<TestIdentity, 'kind' | 'email' | 'password'> & Partial<Pick<TestIdentity, 'roleKey' | 'defaultApplication'>>,
    opts: { applicationTarget?: ApplicationTarget } = {},
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // The mobile header alone would derive `staff_app`/`venue_manager_app`; managers keep their console target explicitly
    // so manager-only routes still accept the token while the refresh token comes back in the body.
    const managerKind = identity.kind === 'internal_manager' || identity.kind === 'ceo' || identity.kind === 'org_admin';
    const applicationTarget = opts.applicationTarget ?? (managerKind ? 'manager_web' : undefined);
    const res = await this.loginRaw(identity, { applicationTarget, mobile: true });
    if (res.status !== 200) {
      probe.loginFailures++;
      throw new TestSetupError(
        `login (mobile) as ${identity.kind} returned ${res.status} ${JSON.stringify(res.body?.code ?? res.body?.message ?? res.body)}. This suite never reached its assertions.`,
      );
    }
    probe.logins++;
    return { accessToken: res.body.accessToken as string, refreshToken: res.body.refreshToken as string };
  }

  /** For suites that only carry an email (their own seed helpers return one): same real login path, same loud failure. */
  loginByEmail(email: string, kind: TestIdentityKind = 'internal_manager', opts: { applicationTarget?: ApplicationTarget } = {}): Promise<string> {
    return this.login({ kind, email, password: TEST_PASSWORD }, opts);
  }
}

/** Convenience for suites that build their own infra object in `beforeAll`. */
export function createTestIdentityFactory(infra: TestInfra): TestIdentityFactory {
  return new TestIdentityFactory(infra);
}
