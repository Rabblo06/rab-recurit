import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ManagerType } from '@rab/shared';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Role } from '../../modules/identity/entities/index';
import { ManagerService, ROLE_DEFS } from '../../modules/manager/services/manager.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * The first Manager / Venue Manager / CEO of a type in an organisation creates that type's system role. Two creates at
 * the same instant can both miss the role lookup; the second used to fail with 23505 (`role_organisation_id_key_key`) →
 * 500. Same backstop as StaffService.ensureStaffRole (ON CONFLICT DO NOTHING, then re-select).
 *
 * Deterministic: transaction A creates the role and holds its transaction open; transaction B is started and observed
 * blocked on A's uncommitted row (pg_stat_activity); then A commits and B must return A's role.
 */
describe('Manager system role: concurrent first create (integration)', () => {
  jest.setTimeout(120_000);
  let app: INestApplication;
  let owner: DataSource;
  let tenant: TenantContextService;
  let service: ManagerService;
  let factory: TestIdentityFactory;

  type EnsureRole = (manager: EntityManager, organisationId: string, type: string) => Promise<Role>;
  const ensureRole = (m: EntityManager, organisationId: string, type: string) =>
    (service as unknown as { ensureRole: EnsureRole }).ensureRole(m, organisationId, type);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    tenant = moduleRef.get(TenantContextService);
    service = moduleRef.get(ManagerService);
    factory = new TestIdentityFactory({
      app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext: tenant, passwordHashing: moduleRef.get(PasswordHashingService),
    });
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  /** Waits until another backend is blocked by the winner's transaction (`winnerPid`) while inserting a role. */
  async function waitForBlockedRoleInsert(winnerPid: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const [row] = await owner.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))
            AND query ILIKE '%insert into%role%'`,
        [winnerPid],
      );
      if (row.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the second role insert never blocked on the first');
  }

  it.each([ManagerType.INTERNAL, ManagerType.VENUE, ManagerType.CEO])(
    'two concurrent first creates of a %s role both succeed with one role and its full default permissions',
    async (type) => {
      const org = await factory.createOrganisation('role-race');
      const ctx: AuthContext = { organisationId: org.id, workspaceId: null, userId: '', role: '' };
      const def = ROLE_DEFS[type]!;

      let markInserted!: (pid: number) => void;
      const inserted = new Promise<number>((resolve) => (markInserted = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));

      const first = tenant.runInTenantContext(ctx, async (m) => {
        const role = await ensureRole(m, org.id, type);
        const [{ pid }] = await m.query(`SELECT pg_backend_pid() AS pid`);
        markInserted(Number(pid));
        await released; // keep the winner's insert uncommitted while the second create runs
        return role;
      });
      const winnerPid = await inserted;
      const second = tenant.runInTenantContext(ctx, (m) => ensureRole(m, org.id, type));
      // Never let a rejected `second` go unobserved while we wait.
      second.catch(() => undefined);
      try {
        await waitForBlockedRoleInsert(winnerPid);
      } finally {
        release(); // always end the winner's transaction, even if the wait failed
      }

      const [winner, loser] = await Promise.all([first, second]);
      expect(loser.id).toBe(winner.id);
      expect(loser.key).toBe(def.key);
      expect(loser.isSystem).toBe(true);

      const roles = await owner.query(`SELECT id FROM core.role WHERE organisation_id = $1 AND key = $2`, [org.id, def.key]);
      expect(roles).toHaveLength(1);
      const granted: Array<{ key: string }> = await owner.query(
        `SELECT p.key FROM core.role_permission rp JOIN core.permission p ON p.id = rp.permission_id WHERE rp.role_id = $1`,
        [winner.id],
      );
      expect(granted.map((g) => g.key).sort()).toEqual([...new Set(def.permissions)].sort());
    },
  );

  it('an existing role is returned unchanged (no second role row)', async () => {
    const org = await factory.createOrganisation('role-existing');
    const ctx: AuthContext = { organisationId: org.id, workspaceId: null, userId: '', role: '' };
    const created = await tenant.runInTenantContext(ctx, (m) => ensureRole(m, org.id, ManagerType.INTERNAL));
    const again = await tenant.runInTenantContext(ctx, (m) => ensureRole(m, org.id, ManagerType.INTERNAL));
    expect(again.id).toBe(created.id);
    const roles = await owner.query(`SELECT id FROM core.role WHERE organisation_id = $1 AND key = 'manager'`, [org.id]);
    expect(roles).toHaveLength(1);
  });
});
