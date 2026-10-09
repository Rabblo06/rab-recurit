import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities/index';
import { createAdminDataSource } from './helpers/admin-datasource';
import { BootstrapTimer } from './helpers/bootstrap-trace';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Legacy core.manager_venue: a link row must belong to a workspace, and must be bound to a manager profile in that SAME workspace.
 * The composite FK (manager_profile_id, organisation_id, workspace_id) -> core.manager_profile(id, organisation_id, workspace_id)
 * and workspace_id NOT NULL enforce this at the database. RLS refuses a link into another workspace as well (defence in depth).
 */
describe('core.manager_venue workspace binding (integration)', () => {
  let app: INestApplication;
  let runtime: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let venueB: string;

  const ctxOf = (m: TestIdentity) => ({ organisationId: org.id, workspaceId: m.workspaceId!, userId: m.userId, role: '' });

  beforeAll(async () => {
    const __bt = new BootstrapTimer('manager-venue-workspace-binding');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    __bt.mark('compile');
    app = moduleRef.createNestApplication();
    await app.init();
    __bt.mark('init');
    await app.get(DataSource).query('SELECT 1');
    __bt.mark('dbPing');
    __bt.log();
    runtime = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: runtime,
      adminDataSource,
      tenantContext,
      passwordHashing: app.get(PasswordHashingService),
    });
    org = await factory.createOrganisation('mv-binding');
    managerA = await factory.createInternalManager(org, { permissions: 'production', label: 'mv-a' });
    managerB = await factory.createInternalManager(org, { permissions: 'production', label: 'mv-b' });
    const rows = await tenantContext.runInTenantContext(ctxOf(managerB), (m) =>
      m.query(`INSERT INTO core.venue (organisation_id, workspace_id, name) VALUES ($1, $2, 'mv-binding venue B') RETURNING id`, [
        org.id,
        managerB.workspaceId,
      ]),
    );
    venueB = rows[0].id as string;
  }, 120_000);

  afterAll(async () => {
    await adminDataSource?.destroy();
    await app?.close();
  });

  const link = (m: TestIdentity, profileId: string | null, workspaceId: string | null, venueId: string) =>
    tenantContext.runInTenantContext(ctxOf(m), (q) =>
      q.query(`INSERT INTO core.manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id) VALUES ($1, $2, $3, $4)`, [
        org.id,
        profileId,
        venueId,
        workspaceId,
      ]),
    );

  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ACCEPTED';
    } catch (e) {
      return (e as { code?: string }).code ?? 'NO-CODE';
    }
  };

  it('workspace_id is NOT NULL in the catalogue', async () => {
    const [row] = await adminDataSource.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'core' AND table_name = 'manager_venue' AND column_name = 'workspace_id'`,
    );
    expect(row.is_nullable).toBe('NO');
  });

  it('a link with NULL workspace_id is refused', async () => {
    const code = await codeOf(link(managerB, managerB.profileId, null, venueB));
    expect(['42501', '23502', '23503', '23514']).toContain(code);
  });

  it('a Workspace B venue cannot be linked to a Workspace A manager profile (constraint layer, bound to Workspace B)', async () => {
    const code = await codeOf(link(managerB, managerA.profileId, managerB.workspaceId, venueB));
    expect(code).toBe('23503');
  });

  it('the same link is refused by RLS when bound to Workspace A (policy layer)', async () => {
    const code = await codeOf(link(managerA, managerA.profileId, managerB.workspaceId, venueB));
    expect(code).toBe('42501');
  });

  it('a same-workspace link is accepted (positive control), then removed', async () => {
    const code = await codeOf(link(managerB, managerB.profileId, managerB.workspaceId, venueB));
    expect(code).toBe('ACCEPTED');
    await tenantContext.runInTenantContext(ctxOf(managerB), (q) =>
      q.query(`DELETE FROM core.manager_venue WHERE manager_profile_id = $1 AND venue_id = $2`, [managerB.profileId, venueB]),
    );
  });
});
