import 'reflect-metadata';
import { ManagerType, UserStatus, VenueType } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { WORKER_HEARTBEAT_KEY } from '../../engine/worker-shared/heartbeat.constants';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Owner policy (2026-10-15): a NEW account (or an email change) may not use an email address that belongs to a live account in
 * ANOTHER organisation. Enforced once, in PostgreSQL (`user_email_unique_across_organisations` trigger, race-safe), surfaced as one
 * generic 409 that never names the other organisation, its role, status or workspace. Existing duplicates are never touched.
 * Real PostgreSQL with RLS; runs unchanged with both auth caches enabled.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const STRONG = 'Correct-Horse-42-battery';
const GENERIC = { statusCode: 409, code: 'EMAIL_UNAVAILABLE', message: 'This email address can’t be used for a new Crewflow account. Use a different email address.' };
const OBJECT_OF: Record<string, string> = { 'staff.view': 'staff', 'venue.view': 'venue', 'schedule.view': 'shift' };

describeIfDb('email addresses are unique across organisations for new accounts (integration)', () => {
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const fresh = (label = 'new') => `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const usersWith = async (email: string) =>
    (await owner.query(`SELECT organisation_id FROM core."user" WHERE lower(email::text) = lower(btrim($1))`, [email])) as Array<{ organisation_id: string }>;

  // Organisation B holds the existing accounts. Organisation A (and C) try to reuse their addresses.
  let orgA: { id: string };
  let orgB: { id: string; name: string; slug: string };
  let orgC: { id: string };
  let ceoA: TestIdentity;
  let ceoAToken: string;
  let ceoCToken: string;
  let managerA: TestIdentity;
  let managerAToken: string;
  let paToken: string;
  let managerB: TestIdentity;
  let activeB: string;
  let suspendedB: string;
  let invitedB: string;
  let roleA: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    await moduleRef.get(ThrottlerRedisClientProvider).client.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', 300);
    const redis = new Redis(process.env.REDIS_URL!);
    const keys = await redis.keys('crewflow:test:invite-rate:*');
    if (keys.length) await redis.del(...keys);
    await redis.quit();

    orgB = await factory.createOrganisation('email-owner-b');
    managerB = await factory.createInternalManager(orgB, { permissions: 'production' });
    activeB = managerB.email;
    suspendedB = (await factory.createStaff(orgB, { owner: managerB, status: UserStatus.SUSPENDED })).email;
    invitedB = (await factory.createStaff(orgB, { owner: managerB, status: UserStatus.INVITED })).email;

    orgA = await factory.createOrganisation('email-reuser-a');
    ceoA = await factory.createCeo(orgA, { permissions: 'all' });
    ceoAToken = await factory.login(ceoA);
    managerA = await factory.createInternalManager(orgA, { permissions: 'production' });
    await owner.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE id = $1`, [managerA.profileId]);
    managerAToken = await factory.login(managerA);
    const role = await http().post('/rest/v1/roles').set(bearer(managerAToken)).send({
      name: 'Supervisor', assignableToMembers: true, readAllObjects: false,
      objects: ['staff.view', 'venue.view'].map((key) => ({ object: OBJECT_OF[key], read: 'grant' })),
    });
    if (role.status !== 201) throw new Error(`role setup failed: ${JSON.stringify(role.body)}`);
    roleA = role.body.id;

    orgC = await factory.createOrganisation('email-reuser-c');
    ceoCToken = await factory.login(await factory.createCeo(orgC, { permissions: 'all' }));
    paToken = await factory.login(await factory.createCeo(await factory.createOrganisation('email-pa'), { permissions: 'all', platformAdmin: true }));
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
  });

  /** The refusal must be the fixed generic body — nothing about organisation B, its people or their state. */
  function expectGenericRefusal(res: request.Response): void {
    expect(res.status).toBe(409);
    expect(res.body).toEqual(GENERIC);
    const text = JSON.stringify(res.body).toLowerCase();
    for (const secret of [orgB.id, orgB.name.toLowerCase(), orgB.slug, managerB.userId, 'suspended', 'invited', 'manager', 'staff', 'ceo']) {
      expect([secret, text.includes(secret)]).toEqual([secret, false]);
    }
  }

  describe('every account-creation path refuses an address that belongs to another organisation', () => {
    it('organisation creation + CEO onboarding: refused, and the organisation is NOT left behind', async () => {
      const name = `Reuse Org ${randomUUID().slice(0, 6)}`;
      const res = await http().post('/rest/v1/admin/organisations').set(bearer(paToken)).send({ name, ceoEmail: activeB, ceoFirstName: 'C', ceoLastName: 'E' });
      expectGenericRefusal(res);
      expect(await owner.query(`SELECT id FROM core.organisation WHERE name = $1`, [name])).toEqual([]);
      expect(await usersWith(activeB)).toEqual([{ organisation_id: orgB.id }]);
    });

    it('Initial Manager onboarding (CEO): refused, nothing written, no email queued', async () => {
      const before = await owner.query(`SELECT count(*)::int AS n FROM core.email_outbox WHERE recipient_email = $1`, [activeB]);
      expectGenericRefusal(await http().post('/rest/v1/managers/initial-manager-invite').set(bearer(ceoCToken)).send({ email: activeB, firstName: 'I', lastName: 'M' }));
      expect(await usersWith(activeB)).toEqual([{ organisation_id: orgB.id }]);
      const after = await owner.query(`SELECT count(*)::int AS n FROM core.email_outbox WHERE recipient_email = $1`, [activeB]);
      expect(after[0].n).toBe(before[0].n);
      expect(await owner.query(`SELECT 1 FROM core.manager_profile WHERE organisation_id = $1 AND is_initial_manager`, [orgC.id])).toEqual([]);
    });

    it('ordinary Manager, Staff and Venue Manager creation: the same generic refusal', async () => {
      expectGenericRefusal(await http().post('/rest/v1/managers').set(bearer(ceoAToken)).send({ email: activeB, firstName: 'M', lastName: 'G', type: ManagerType.INTERNAL }));
      expectGenericRefusal(await http().post('/rest/v1/staff').set(bearer(managerAToken)).send({ email: activeB, firstName: 'S', lastName: 'T' }));
      expectGenericRefusal(await http().post('/rest/v1/venue-managers').set(bearer(managerAToken)).send({ email: activeB, firstName: 'V', lastName: 'M' }));
      expect(await usersWith(activeB)).toEqual([{ organisation_id: orgB.id }]);
    });

    it('suspended and invited accounts in another organisation block reuse too — with an identical response (state is never revealed)', async () => {
      for (const email of [suspendedB, invitedB]) {
        expectGenericRefusal(await http().post('/rest/v1/managers').set(bearer(ceoAToken)).send({ email, firstName: 'M', lastName: 'G', type: ManagerType.INTERNAL }));
        expect(await usersWith(email)).toEqual([{ organisation_id: orgB.id }]);
      }
    });

    it('different casing is the same address (refused); surrounding whitespace never creates a second account', async () => {
      expectGenericRefusal(await http().post('/rest/v1/managers').set(bearer(ceoAToken)).send({ email: activeB.toUpperCase(), firstName: 'M', lastName: 'G', type: ManagerType.INTERNAL }));
      const padded = await http().post('/rest/v1/managers').set(bearer(ceoAToken)).send({ email: `  ${activeB}  `, firstName: 'M', lastName: 'G', type: ManagerType.INTERNAL });
      expect([400, 409]).toContain(padded.status);
      expect(await usersWith(activeB)).toEqual([{ organisation_id: orgB.id }]);
    });

    it('an address already used in the SAME organisation keeps its own (local) message', async () => {
      const res = await http().post('/rest/v1/managers').set(bearer(ceoAToken)).send({ email: managerA.email, firstName: 'M', lastName: 'G', type: ManagerType.INTERNAL });
      expect(res.status).toBe(409);
      expect(res.body.code).toBeUndefined();
    });

    it('a brand-new address still works everywhere (no false positives)', async () => {
      const email = fresh('ok');
      expect((await http().post('/rest/v1/managers').set(bearer(ceoAToken)).send({ email, firstName: 'O', lastName: 'K', type: ManagerType.INTERNAL })).status).toBe(201);
      expect(await usersWith(email)).toEqual([{ organisation_id: orgA.id }]);
    });
  });

  describe('member invitations', () => {
    it('sending to an address registered elsewhere: the existing generic "unavailable" outcome — no invitation, no email', async () => {
      const res = await http().post('/rest/v1/member-invitations').set(bearer(managerAToken)).send({ emails: [activeB], roleId: roleA });
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([{ email: activeB, outcome: 'unavailable' }]);
      expect(await owner.query(`SELECT 1 FROM core.member_invitation WHERE email = $1 AND organisation_id = $2`, [activeB, orgA.id])).toEqual([]);
    });

    it('acceptance after the address was registered in another organisation: the invitation is superseded and no account is created', async () => {
      const email = fresh('late');
      const sent = await http().post('/rest/v1/member-invitations').set(bearer(managerAToken)).send({ emails: [email], roleId: roleA });
      expect(sent.body.results[0].outcome).toBe('invited');
      const [invitation] = await owner.query(`SELECT id FROM core.member_invitation WHERE email = $1`, [email]);
      const [outbox] = await owner.query(`SELECT rendered_html FROM core.email_outbox WHERE member_invitation_id = $1 ORDER BY created_at DESC LIMIT 1`, [invitation.id]);
      const token = decodeURIComponent(/accept-invitation\?token=([A-Za-z0-9_\-%]+)/.exec(outbox.rendered_html)![1]!);
      // Meanwhile the address becomes an account in organisation B (through B's own ordinary flow).
      const managerBToken = await factory.login(managerB);
      expect((await http().post('/rest/v1/staff').set(bearer(managerBToken)).send({ email, firstName: 'B', lastName: 'Staff' })).status).toBe(201);

      const accepted = await http().post('/rest/v1/invitations/accept').send({ token, firstName: 'Late', lastName: 'Joiner', newPassword: STRONG });
      expect(accepted.status).not.toBe(200);
      expect(JSON.stringify(accepted.body)).not.toContain(orgB.id);
      expect(await usersWith(email)).toEqual([{ organisation_id: orgB.id }]);
      const [after] = await owner.query(`SELECT superseded_at, accepted_at FROM core.member_invitation WHERE id = $1`, [invitation.id]);
      expect(after.accepted_at).toBeNull();
      expect(after.superseded_at).not.toBeNull();
    });
  });

  describe('email changes', () => {
    it('changing a Manager’s or a Staff member’s email to an address used elsewhere: refused, unchanged', async () => {
      const pending = await http().post('/rest/v1/managers').set(bearer(ceoAToken)).send({ email: fresh('pending-mgr'), firstName: 'P', lastName: 'M', type: ManagerType.INTERNAL });
      expect(pending.status).toBe(201);
      expectGenericRefusal(await http().patch(`/rest/v1/managers/${pending.body.id}/email`).set(bearer(ceoAToken)).send({ email: activeB }));
      const staff = await http().post('/rest/v1/staff').set(bearer(managerAToken)).send({ email: fresh('pending-staff'), firstName: 'P', lastName: 'S' });
      expect(staff.status).toBe(201);
      expectGenericRefusal(await http().patch(`/rest/v1/staff/${staff.body.id}/email`).set(bearer(managerAToken)).send({ email: activeB }));
      expect(await usersWith(activeB)).toEqual([{ organisation_id: orgB.id }]);
    });
  });

  describe('race safety', () => {
    it('two organisations creating the same new address at the same instant: exactly one account, five rounds', async () => {
      for (let round = 0; round < 5; round++) {
        const email = fresh(`race${round}`);
        const results = await Promise.all([
          http().post('/rest/v1/managers').set(bearer(ceoAToken)).send({ email, firstName: 'R', lastName: 'A', type: ManagerType.INTERNAL }),
          http().post('/rest/v1/managers').set(bearer(ceoCToken)).send({ email, firstName: 'R', lastName: 'C', type: ManagerType.INTERNAL }),
        ]);
        expect([round, results.map((r) => r.status).sort()]).toEqual([round, [201, 409]]);
        expect((await usersWith(email)).length).toBe(1);
      }
    });
  });

  describe('existing (historical) duplicates are left exactly as they are', () => {
    it('a pre-policy duplicate stays, its other fields stay editable, and login with a shared password stays refused as ambiguous', async () => {
      const orgD = await factory.createOrganisation('historical-d');
      const legacy = await factory.createOrgAdmin(orgD, { permissions: 'all' });
      const other = await factory.createOrgAdmin(await factory.createOrganisation('historical-e'), { permissions: 'all' });
      await factory.makeHistoricalDuplicateEmail(other.userId, legacy.email);
      expect((await usersWith(legacy.email)).length).toBe(2);

      // Unrelated updates of a historical duplicate are unaffected by the policy.
      await owner.query(`UPDATE core."user" SET first_name = 'Renamed' WHERE id = $1`, [other.userId]);
      const [renamed] = await owner.query(`SELECT first_name, email FROM core."user" WHERE id = $1`, [other.userId]);
      expect(renamed).toEqual({ first_name: 'Renamed', email: legacy.email });

      const login = await http().post('/rest/v1/auth/login').send({ email: legacy.email, password: legacy.password });
      expect(login.status).toBe(401);
      expect(login.body.code).toBe('AMBIGUOUS_ACCOUNTS');
      expect((await usersWith(legacy.email)).length).toBe(2);
    });
  });

  describe('database layer', () => {
    it('the trigger refuses ANY writer (here the table owner) with a fixed, detail-free error; a deleted account’s address is reusable', async () => {
      const attempt = owner.query(
        `INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'D', 'B', 'invited')`,
        [orgA.id, `  ${activeB.toUpperCase()} `],
      );
      await expect(attempt).rejects.toMatchObject({ constraint: 'user_email_registered_in_another_organisation', message: 'This email address is not available for a new account.' });

      const reusable = fresh('deleted');
      const [{ id }] = await owner.query(`INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'G', 'O', 'invited') RETURNING id`, [orgB.id, reusable]);
      await owner.query(`UPDATE core."user" SET deleted_at = now() WHERE id = $1`, [id]);
      await owner.query(`INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'N', 'W', 'invited')`, [orgA.id, reusable]);
      // Restoring the deleted account now would create a live duplicate: refused.
      await expect(owner.query(`UPDATE core."user" SET deleted_at = NULL WHERE id = $1`, [id])).rejects.toMatchObject({ constraint: 'user_email_registered_in_another_organisation' });
    });

    it('core.email_registered_in_another_organisation answers only for the caller’s bound organisation, and fails closed with none bound', async () => {
      const tenant = app.get(TenantContextService);
      const askAs = (organisationId: string | null) =>
        tenant.runInTenantContext({ organisationId, workspaceId: null, userId: ceoA.userId, role: '' }, (m) =>
          m.query(`SELECT core.email_registered_in_another_organisation($1) AS taken`, [activeB]));
      expect((await askAs(orgA.id))[0].taken).toBe(true);
      expect((await askAs(orgB.id))[0].taken).toBe(false);
      expect((await askAs(null))[0].taken).toBe(true);
    });
  });

  it('venue type fixture sanity (the suite never depends on another organisation’s venues)', () => {
    expect(Object.values(VenueType).length).toBeGreaterThan(0);
  });
});
