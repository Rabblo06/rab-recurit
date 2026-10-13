import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuditAction, AuditService } from '../../engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * `AuditLogImmutableHistoricalIdentifiers1786692000000` removed the live FK that used to back
 * `actor_user_id`/`target_user_id` (it 500'd on deletion — see that migration and
 * `user-deletion-abuse-cases.integration.spec.ts` for the full story). `AuditService.record()` is
 * now the ONLY place "was this actually a real user" is ever checked, and only at the moment the
 * event is recorded — this suite proves that check does its job (rejects a fabricated or
 * out-of-tenant id) without rejecting any of the legitimate shapes real call sites actually use
 * (a real same-org actor/target, and the deliberate actor-less system/bootstrap case).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('AuditService.record() — insertion-time identity validation (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let auditService: AuditService;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    auditService = moduleRef.get(AuditService);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('rejects a fabricated actorUserId that does not exist in core.user, and inserts nothing', async () => {
    const organisation = await factory.createOrganisation();
    const fabricatedActorId = randomUUID();

    await expect(
      tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: '', role: '' }, (manager) =>
        auditService.record(manager, { organisationId: organisation.id, userId: fabricatedActorId }, AuditAction.USER_LOGIN, {}),
      ),
    ).rejects.toThrow(/do not resolve to an existing core\.user row/);

    const rows = await adminDataSource.manager.query(`SELECT 1 FROM core.audit_log WHERE action = $1 AND actor_user_id = $2`, [AuditAction.USER_LOGIN, fabricatedActorId]);
    expect(rows.length).toBe(0);
  });

  it('rejects a fabricated targetUserId that does not exist in core.user, and inserts nothing', async () => {
    const organisation = await factory.createOrganisation();
    const manager = await factory.createInternalManager(organisation, { label: 'audit-val-target' });
    const fabricatedTargetId = randomUUID();

    await expect(
      tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: manager.userId, role: '' }, (m) =>
        auditService.record(m, { organisationId: organisation.id, userId: manager.userId }, AuditAction.ACCOUNT_SUSPENDED, { targetUserId: fabricatedTargetId }),
      ),
    ).rejects.toThrow(/do not resolve to an existing core\.user row/);

    const rows = await adminDataSource.manager.query(`SELECT 1 FROM core.audit_log WHERE action = $1 AND target_user_id = $2`, [AuditAction.ACCOUNT_SUSPENDED, fabricatedTargetId]);
    expect(rows.length).toBe(0);
  });

  it('rejects a REAL user id that belongs to a different organisation — a cross-tenant reference is as invalid as a fabricated one', async () => {
    const orgA = await factory.createOrganisation();
    const orgB = await factory.createOrganisation();
    const managerA = await factory.createInternalManager(orgA, { label: 'audit-val-xa' });
    const managerB = await factory.createInternalManager(orgB, { label: 'audit-val-xb' });

    await expect(
      tenantContext.runInTenantContext({ organisationId: orgA.id, workspaceId: null, userId: managerA.userId, role: '' }, (m) =>
        auditService.record(m, { organisationId: orgA.id, userId: managerA.userId }, AuditAction.ACCOUNT_SUSPENDED, { targetUserId: managerB.userId }),
      ),
    ).rejects.toThrow(/do not resolve to an existing core\.user row/);
  });

  it('does NOT reject the deliberate actor-less system/bootstrap case (actorUserId: null) — only a non-null id is validated', async () => {
    const organisation = await factory.createOrganisation();
    const manager = await factory.createInternalManager(organisation, { label: 'audit-val-null' });

    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: manager.userId, role: '' }, (m) =>
      auditService.record(m, { organisationId: organisation.id, userId: manager.userId }, AuditAction.PLATFORM_ADMIN_GRANTED, {
        targetUserId: manager.userId,
        actorUserId: null,
        metadata: { via: 'test_bootstrap' },
      }),
    );

    const rows = await adminDataSource.manager.query(`SELECT actor_user_id FROM core.audit_log WHERE action = $1 AND target_user_id = $2`, [AuditAction.PLATFORM_ADMIN_GRANTED, manager.userId]);
    expect(rows.length).toBe(1);
    expect(rows[0].actor_user_id).toBeNull();
  });

  it('does NOT reject a legitimate real actor and target within the same tenant — the common, everyday path', async () => {
    const organisation = await factory.createOrganisation();
    const managerA = await factory.createInternalManager(organisation, { label: 'audit-val-ok-a' });
    const managerB = await factory.createInternalManager(organisation, { label: 'audit-val-ok-b' });

    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: managerA.userId, role: '' }, (m) =>
      auditService.record(m, { organisationId: organisation.id, userId: managerA.userId }, AuditAction.ACCOUNT_SUSPENDED, { targetUserId: managerB.userId }),
    );

    const rows = await adminDataSource.manager.query(`SELECT actor_user_id, target_user_id FROM core.audit_log WHERE action = $1 AND target_user_id = $2`, [
      AuditAction.ACCOUNT_SUSPENDED,
      managerB.userId,
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].actor_user_id).toBe(managerA.userId);
    expect(rows[0].target_user_id).toBe(managerB.userId);
  });
});
