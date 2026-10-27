import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuditAction, AuditService } from '../../engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Foundation fix P1 (2026-10-22) — an audit entry may only name users of ITS OWN organisation, except when the actor is an
 * ACTIVE platform administrator (`AuditLogRecordedIdentityOrganisationCheck1786719610000`). Proven at every layer:
 *   - service (`AuditService.record`): same-org accepted; cross-org actor or target refused; platform-admin cross-org
 *     accepted; a REVOKED admin and an actor-less system entry are not exempt;
 *   - database, bypassing the service: the `audit_log_recorded_identities` trigger refuses the same rows for the runtime
 *     role (`crewflow_app`), the table owner (`crewflow`, FORCE RLS) and even the superuser fixture connection, and the
 *     organisation-parameterised rule function is not executable by any login role (no cross-org membership oracle);
 *   - API: a manager addressing another organisation's staff gets a 404 and no audit row; the legitimate
 *     platform-admin cross-organisation actions (grant/revoke, organisation suspension/reactivation) still audit.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('audit_log cross-organisation identity references (integration, P1)', () => {
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

  async function twoOrganisations(): Promise<{ orgA: { id: string; slug: string }; orgB: { id: string; slug: string }; managerA: TestIdentity; managerB: TestIdentity }> {
    const orgA = await factory.createOrganisation();
    const orgB = await factory.createOrganisation();
    const managerA = await factory.createInternalManager(orgA, { label: 'p1-a', permissions: 'all' });
    const managerB = await factory.createInternalManager(orgB, { label: 'p1-b', permissions: 'all' });
    return { orgA, orgB, managerA, managerB };
  }

  function recordAs(organisationId: string, userId: string, action: (typeof AuditAction)[keyof typeof AuditAction], opts: Parameters<AuditService['record']>[3]) {
    return tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId, role: '' }, (m) =>
      auditService.record(m, { organisationId, userId }, action, opts),
    );
  }

  async function auditRows(where: string, params: unknown[]): Promise<Array<{ organisation_id: string; actor_user_id: string | null; target_user_id: string | null }>> {
    return adminDataSource.manager.query(`SELECT organisation_id, actor_user_id, target_user_id FROM core.audit_log WHERE ${where}`, params);
  }

  /** One INSERT on its own connection/transaction, always rolled back; returns the SQLSTATE (or 'ok'). */
  async function tryDirectInsert(
    ds: DataSource,
    opts: { setRole?: 'crewflow'; bindOrganisationId?: string; organisationId: string; actorUserId: string | null; targetUserId: string | null },
  ): Promise<string> {
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      if (opts.setRole) await qr.query(`SET LOCAL ROLE ${opts.setRole}`);
      if (opts.bindOrganisationId) await qr.query(`SELECT set_config('rab.organisation_id', $1, true)`, [opts.bindOrganisationId]);
      await qr.query(
        `INSERT INTO core.audit_log (organisation_id, actor_user_id, target_user_id, action, metadata) VALUES ($1, $2, $3, 'p1.direct_insert_probe', '{}'::jsonb)`,
        [opts.organisationId, opts.actorUserId, opts.targetUserId],
      );
      return 'ok';
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    } finally {
      await qr.rollbackTransaction().catch(() => undefined);
      await qr.release();
    }
  }

  describe('service layer — AuditService.record()', () => {
    it('accepts a real actor and target from the SAME organisation', async () => {
      const org = await factory.createOrganisation();
      const a = await factory.createInternalManager(org, { label: 'p1-same-a' });
      const b = await factory.createInternalManager(org, { label: 'p1-same-b' });
      await recordAs(org.id, a.userId, AuditAction.ACCOUNT_SUSPENDED, { targetUserId: b.userId });
      expect(await auditRows(`action = $1 AND target_user_id = $2`, [AuditAction.ACCOUNT_SUSPENDED, b.userId])).toEqual([
        { organisation_id: org.id, actor_user_id: a.userId, target_user_id: b.userId },
      ]);
    });

    it('refuses a real TARGET from another organisation and writes nothing', async () => {
      const { orgA, managerA, managerB } = await twoOrganisations();
      await expect(recordAs(orgA.id, managerA.userId, AuditAction.ACCOUNT_SUSPENDED, { targetUserId: managerB.userId })).rejects.toThrow(
        /do not resolve to an existing core\.user row in this entry's organisation \(other_organisation\)/,
      );
      expect(await auditRows(`target_user_id = $1`, [managerB.userId])).toHaveLength(0);
    });

    it("refuses a real ACTOR from another organisation (org A's entry attributed to org B's user) and writes nothing", async () => {
      const { orgA, managerA, managerB } = await twoOrganisations();
      await expect(
        recordAs(orgA.id, managerA.userId, AuditAction.ACCOUNT_SUSPENDED, { targetUserId: managerA.userId, actorUserId: managerB.userId }),
      ).rejects.toThrow(/other_organisation/);
      expect(await auditRows(`actor_user_id = $1`, [managerB.userId])).toHaveLength(0);
    });

    it('an actor-less (system) entry is NOT exempt — it may only reference its own organisation', async () => {
      const { orgA, managerA, managerB } = await twoOrganisations();
      await expect(
        recordAs(orgA.id, managerA.userId, AuditAction.ACCOUNT_SUSPENDED, { targetUserId: managerB.userId, actorUserId: null }),
      ).rejects.toThrow(/other_organisation/);
    });

    it('an ACTIVE platform admin may reference another organisation (the legitimate cross-org shape); a REVOKED one may not', async () => {
      const { orgA, managerA, managerB } = await twoOrganisations();
      await factory.grantPlatformAdmin(managerA.userId);
      await recordAs(orgA.id, managerA.userId, AuditAction.PLATFORM_ADMIN_GRANTED, { targetUserId: managerB.userId, metadata: { via: 'p1_test' } });
      expect(await auditRows(`action = $1 AND target_user_id = $2`, [AuditAction.PLATFORM_ADMIN_GRANTED, managerB.userId])).toEqual([
        { organisation_id: orgA.id, actor_user_id: managerA.userId, target_user_id: managerB.userId },
      ]);

      await adminDataSource.manager.query(`UPDATE core.platform_admin SET revoked_at = now(), security_version = security_version + 1 WHERE user_id = $1`, [managerA.userId]);
      await expect(recordAs(orgA.id, managerA.userId, AuditAction.PLATFORM_ADMIN_REVOKED, { targetUserId: managerB.userId })).rejects.toThrow(/other_organisation/);
      expect(await auditRows(`action = $1 AND target_user_id = $2`, [AuditAction.PLATFORM_ADMIN_REVOKED, managerB.userId])).toHaveLength(0);
    });
  });

  describe('database layer — direct inserts that bypass AuditService', () => {
    it('crewflow_app (runtime role, tenant context bound) cannot insert a cross-organisation or fabricated identity; a same-org one is accepted', async () => {
      const { orgA, managerA, managerB } = await twoOrganisations();
      const base = { bindOrganisationId: orgA.id, organisationId: orgA.id };
      expect(await tryDirectInsert(dataSource, { ...base, actorUserId: managerA.userId, targetUserId: managerB.userId })).toBe('23503');
      expect(await tryDirectInsert(dataSource, { ...base, actorUserId: managerB.userId, targetUserId: null })).toBe('23503');
      expect(await tryDirectInsert(dataSource, { ...base, actorUserId: null, targetUserId: managerB.userId })).toBe('23503');
      expect(await tryDirectInsert(dataSource, { ...base, actorUserId: randomUUID(), targetUserId: null })).toBe('23503');
      expect(await tryDirectInsert(dataSource, { ...base, actorUserId: managerA.userId, targetUserId: managerA.userId })).toBe('ok');
      // RLS is unchanged: writing a row into ANOTHER organisation is still refused by audit_log_tenant (42501).
      expect(await tryDirectInsert(dataSource, { ...base, organisationId: managerB.organisationId, actorUserId: managerB.userId, targetUserId: null })).toBe('42501');
    });

    it('the table owner (crewflow) and even the superuser fixture connection are refused too — the trigger fires for every role', async () => {
      const { orgA, managerA, managerB } = await twoOrganisations();
      expect(
        await tryDirectInsert(adminDataSource, { setRole: 'crewflow', bindOrganisationId: orgA.id, organisationId: orgA.id, actorUserId: managerA.userId, targetUserId: managerB.userId }),
      ).toBe('23503');
      expect(await tryDirectInsert(adminDataSource, { organisationId: orgA.id, actorUserId: managerA.userId, targetUserId: managerB.userId })).toBe('23503');
      expect(await tryDirectInsert(adminDataSource, { organisationId: orgA.id, actorUserId: managerA.userId, targetUserId: managerA.userId })).toBe('ok');
    });

    it('an active platform-admin actor passes the database rule as well (service and trigger agree)', async () => {
      const { orgA, managerA, managerB } = await twoOrganisations();
      await factory.grantPlatformAdmin(managerA.userId);
      expect(await tryDirectInsert(dataSource, { bindOrganisationId: orgA.id, organisationId: orgA.id, actorUserId: managerA.userId, targetUserId: managerB.userId })).toBe('ok');
      await adminDataSource.manager.query(`UPDATE core.platform_admin SET revoked_at = now(), security_version = security_version + 1 WHERE user_id = $1`, [managerA.userId]);
    });

    it('no login role can ask the organisation-parameterised rule about another organisation; the runtime pre-check fails closed without tenant context', async () => {
      const { orgB, managerB } = await twoOrganisations();
      const client = dataSource.createQueryRunner();
      await client.connect();
      try {
        await expect(client.query(`SELECT * FROM core.audit_identity_violations_in($1, $2, NULL)`, [orgB.id, managerB.userId])).rejects.toMatchObject({ code: '42501' });
        // No organisation bound → every supplied id is reported (never "valid").
        const rows = await client.query(`SELECT user_id, reason FROM core.audit_identity_violations($1, NULL)`, [managerB.userId]);
        expect(rows).toEqual([{ user_id: managerB.userId, reason: 'no_organisation' }]);
      } finally {
        await client.release();
      }
      const crewflow = adminDataSource.createQueryRunner();
      await crewflow.connect();
      await crewflow.startTransaction();
      try {
        await crewflow.query('SET LOCAL ROLE crewflow');
        await expect(crewflow.query(`SELECT * FROM core.audit_identity_violations_in($1, $2, NULL)`, [orgB.id, managerB.userId])).rejects.toMatchObject({ code: '42501' });
      } finally {
        await crewflow.rollbackTransaction().catch(() => undefined);
        await crewflow.release();
      }
    });
  });

  describe('API layer', () => {
    it("a manager addressing another organisation's staff member gets 404 and no audit row is written about that person", async () => {
      const { managerA, managerB } = await twoOrganisations();
      const ownerB = await factory.createInternalManager({ id: managerB.organisationId }, { label: 'p1-owner-b', permissions: 'all', workspace: true });
      const staffB = await factory.createStaff({ id: managerB.organisationId }, { owner: ownerB, label: 'p1-staff-b' });
      const tokenA = await factory.login(managerA);

      const res = await request(app.getHttpServer()).post(`/rest/v1/staff/${staffB.profileId}/deactivate`).set('Authorization', `Bearer ${tokenA}`).send({});
      expect(res.status).toBe(404);
      expect(await auditRows(`target_user_id = $1 OR actor_user_id = $1`, [staffB.userId])).toHaveLength(0);
      const [{ status }] = await adminDataSource.manager.query(`SELECT status FROM core."user" WHERE id = $1`, [staffB.userId]);
      expect(status).toBe('active');
    });

    it('legitimate platform-admin cross-organisation actions still audit: grant/revoke (row in the admin org) and suspend/reactivate (row in the target org)', async () => {
      const { orgA, orgB, managerA, managerB } = await twoOrganisations();
      await factory.grantPlatformAdmin(managerA.userId);
      const adminToken = await factory.login(managerA);
      const server = app.getHttpServer();

      const grant = await request(server).post(`/rest/v1/admin/platform-admins/${managerB.userId}`).set('Authorization', `Bearer ${adminToken}`).send({ reason: 'P1 cross-organisation audit test' });
      expect(grant.status).toBe(201);
      const revoke = await request(server).delete(`/rest/v1/admin/platform-admins/${managerB.userId}`).set('Authorization', `Bearer ${adminToken}`).send({ reason: 'P1 cross-organisation audit test' });
      expect([200, 204]).toContain(revoke.status);
      expect(await auditRows(`action IN ($1, $2) AND target_user_id = $3 ORDER BY created_at`, [AuditAction.PLATFORM_ADMIN_GRANTED, AuditAction.PLATFORM_ADMIN_REVOKED, managerB.userId])).toEqual([
        { organisation_id: orgA.id, actor_user_id: managerA.userId, target_user_id: managerB.userId },
        { organisation_id: orgA.id, actor_user_id: managerA.userId, target_user_id: managerB.userId },
      ]);

      const suspend = await request(server)
        .post(`/rest/v1/admin/organisations/${orgB.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'P1 cross-organisation audit test', confirmSlug: orgB.slug });
      expect(suspend.status).toBe(201);
      const reactivate = await request(server)
        .post(`/rest/v1/admin/organisations/${orgB.id}/reactivate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'P1 cross-organisation audit test' });
      expect(reactivate.status).toBe(200);
      expect(await auditRows(`entity_id = $1 AND action IN ($2, $3) ORDER BY created_at`, [orgB.id, AuditAction.ORGANISATION_SUSPENDED, AuditAction.ORGANISATION_REACTIVATED])).toEqual([
        { organisation_id: orgB.id, actor_user_id: managerA.userId, target_user_id: null },
        { organisation_id: orgB.id, actor_user_id: managerA.userId, target_user_id: null },
      ]);

      await adminDataSource.manager.query(`UPDATE core.platform_admin SET revoked_at = now(), security_version = security_version + 1 WHERE user_id = $1 AND revoked_at IS NULL`, [managerA.userId]);
    });
  });
});
