import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Settings → Members → Roles: object-, field- and record-level permissions for custom workspace-member roles
 * (RoleObjectFieldPermissions1786716000000). Real PostgreSQL with RLS on, real HTTP, real Redis. Every control is
 * asserted on its DENIAL path: hidden fields are absent from list, detail and search; record filters narrow list,
 * detail (404), counts and search; invalid or tampered filters deny; changes apply on the very next request.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const STRONG = 'Correct-Horse-42-battery';

type Rule = { object: 'staff' | 'venue' | 'shift'; read: 'inherit' | 'grant' | 'deny'; fields?: Record<string, 'visible' | 'hidden'>; recordFilter?: unknown };

describeIfDb('Member roles: object, field and record-level permissions (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let tokenA: string;
  let tokenB: string;
  let staffLondon: TestIdentity;
  let staffLeeds: TestIdentity;
  let staffOtherWs: TestIdentity;
  let venue1: string;
  let venue2: string;
  let venueB: string;
  let jobRole: string;
  let shift1: string;
  let shift2: string;

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const email = (label = 'member') => `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const definition = (name: string, objects: Rule[], extra: Record<string, unknown> = {}) => ({ name, assignableToMembers: true, readAllObjects: false, objects, ...extra });
  const createRole = (token: string, body: unknown) => http().post('/rest/v1/roles').set(bearer(token)).send(body as object);
  const putRole = (token: string, id: string, body: unknown) => http().put(`/rest/v1/roles/${id}`).set(bearer(token)).send(body as object);
  const uniq = (label: string) => `${label} ${randomUUID().slice(0, 6)}`;

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
    const redis = new Redis(process.env.REDIS_URL!);
    const keys = await redis.keys('crewflow:test:invite-rate:*');
    if (keys.length) await redis.del(...keys);
    await redis.quit();

    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'rfp' });
    [managerA, managerB] = seeded.managers as [TestIdentity, TestIdentity];
    tokenA = await factory.login(managerA);
    tokenB = await factory.login(managerB);

    staffLondon = await factory.createStaff(seeded.organisation, { owner: managerA, label: 'london' });
    staffLeeds = await factory.createStaff(seeded.organisation, { owner: managerA, label: 'leeds' });
    staffOtherWs = await factory.createStaff(seeded.organisation, { owner: managerB, label: 'otherws' });
    await owner.query(`UPDATE core.staff_profile SET city = 'London', default_pay_rate_pence = 1550, notes = 'secret note' WHERE id = $1`, [staffLondon.profileId]);
    await owner.query(`UPDATE core.staff_profile SET city = 'Leeds', default_pay_rate_pence = 1400 WHERE id = $1`, [staffLeeds.profileId]);
    await owner.query(`UPDATE core."user" SET phone = '+447700900123' WHERE id = ANY($1::uuid[])`, [[staffLondon.userId, staffLeeds.userId]]);

    venue1 = (await http().post('/rest/v1/venues').set(bearer(tokenA)).send({ name: uniq('Venue One'), type: 'hotel' })).body.id;
    venue2 = (await http().post('/rest/v1/venues').set(bearer(tokenA)).send({ name: uniq('Venue Two'), type: 'hotel' })).body.id;
    venueB = (await http().post('/rest/v1/venues').set(bearer(tokenB)).send({ name: uniq('Venue B'), type: 'hotel' })).body.id;
    jobRole = (await http().post('/rest/v1/job-roles').set(bearer(tokenA)).send({ name: uniq('Waiter'), defaultRatePence: 1300 })).body.id;
    const start = new Date(Date.now() + 7 * 86_400_000);
    const shiftBody = (venueId: string) => ({
      venueId,
      jobRoleId: jobRole,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 4 * 3_600_000).toISOString(),
      requiredCount: 1,
      payRatePence: 1600,
    });
    shift1 = (await http().post('/rest/v1/shifts').set(bearer(tokenA)).send(shiftBody(venue1))).body.id;
    shift2 = (await http().post('/rest/v1/shifts').set(bearer(tokenA)).send(shiftBody(venue2))).body.id;
    if (![venue1, venue2, venueB, jobRole, shift1, shift2].every(Boolean)) throw new Error('fixture setup failed');
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
  });

  async function onboardMember(roleId: string): Promise<{ userId: string; token: string; address: string }> {
    const address = email();
    const sent = await http().post('/rest/v1/member-invitations').set(bearer(tokenA)).send({ emails: [address], roleId });
    expect(sent.status).toBe(200);
    expect(sent.body.results[0].outcome).toBe('invited');
    const [inv] = await owner.query(`SELECT id FROM core.member_invitation WHERE email = $1 ORDER BY created_at DESC LIMIT 1`, [address]);
    const [mail] = await owner.query(`SELECT rendered_html FROM core.email_outbox WHERE member_invitation_id = $1 ORDER BY created_at DESC LIMIT 1`, [inv.id]);
    const raw = decodeURIComponent(/accept-invitation\?token=([A-Za-z0-9_\-%]+)/.exec(mail.rendered_html as string)![1]!);
    expect((await http().post('/rest/v1/invitations/accept').send({ token: raw, firstName: 'Mem', lastName: 'Ber', newPassword: STRONG })).status).toBe(200);
    const token = await factory.login({ kind: 'internal_manager', email: address, password: STRONG });
    const [user] = await owner.query(`SELECT id FROM core."user" WHERE email = $1`, [address]);
    return { userId: user.id, token, address };
  }

  async function roleWith(objects: Rule[], extra: Record<string, unknown> = {}): Promise<string> {
    const res = await createRole(tokenA, definition(uniq('Role'), objects, extra));
    if (res.status !== 201) throw new Error(`role create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  }

  const staffIds = (res: request.Response) => (res.body.data as Array<{ id: string }>).map((s) => s.id).sort();

  // ─────────────────────────────────────────────── Defaults and object level

  describe('Object level', () => {
    it('O1. a new role grants nothing by default: no flags, and its member is refused every object', async () => {
      const roleId = await roleWith([]);
      const [{ count }] = await owner.query(`SELECT count(*)::int AS count FROM core.role_permission WHERE role_id = $1`, [roleId]);
      expect(count).toBe(0);
      const member = await onboardMember(roleId);
      expect((await http().get('/rest/v1/staff').set(bearer(member.token))).status).toBe(403);
      expect((await http().get('/rest/v1/venues').set(bearer(member.token))).status).toBe(403);
      expect((await http().get('/rest/v1/shifts').set(bearer(member.token))).status).toBe(403);
    });

    it('O2. "All Objects → See" grants every object; a per-object deny overrides it', async () => {
      const roleId = await roleWith([{ object: 'venue', read: 'deny' }], { readAllObjects: true });
      const def = (await http().get(`/rest/v1/roles/${roleId}/definition`).set(bearer(tokenA))).body;
      expect(def).toMatchObject({ readAllObjects: true, isMemberRole: true, objects: [expect.objectContaining({ object: 'venue', read: 'deny' })] });
      expect([...def.permissionKeys].sort()).toEqual(['schedule.view', 'staff.view']);
      const member = await onboardMember(roleId);
      expect((await http().get('/rest/v1/staff').set(bearer(member.token))).status).toBe(200);
      expect((await http().get('/rest/v1/venues').set(bearer(member.token))).status).toBe(403);
      expect((await http().get(`/rest/v1/venues/${venue1}`).set(bearer(member.token))).status).toBe(403);
    });

    it('O3. multiple roles intersect: a second role that denies Staff takes Staff away (list 403, detail 404, counts null)', async () => {
      const grant = await roleWith([{ object: 'staff', read: 'grant' }]);
      const member = await onboardMember(grant);
      expect((await http().get('/rest/v1/staff').set(bearer(member.token))).status).toBe(200);
      const deny = await roleWith([{ object: 'staff', read: 'deny' }, { object: 'venue', read: 'grant' }]);
      await owner.query(`INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [member.userId, deny, managerA.organisationId]);
      await owner.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [member.userId]);
      expect((await http().get('/rest/v1/staff').set(bearer(member.token))).status).toBe(403);
      expect((await http().get(`/rest/v1/staff/${staffLondon.profileId}`).set(bearer(member.token))).status).toBe(404);
      const summary = await http().get('/rest/v1/dashboard/summary').set(bearer(member.token));
      expect(summary.status).toBe(200);
      expect(summary.body.staffCount).toBeNull();
    });

    it('O4. members never see another workspace’s records, whatever their role allows', async () => {
      const member = await onboardMember(await roleWith([], { readAllObjects: true }));
      expect(staffIds(await http().get('/rest/v1/staff').set(bearer(member.token)))).not.toContain(staffOtherWs.profileId);
      expect((await http().get(`/rest/v1/staff/${staffOtherWs.profileId}`).set(bearer(member.token))).status).toBe(404);
      expect((await http().get(`/rest/v1/venues/${venueB}`).set(bearer(member.token))).status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────── Field level

  describe('Field level', () => {
    it('F1. sensitive fields are hidden by default on list, detail and search', async () => {
      const member = await onboardMember(await roleWith([{ object: 'staff', read: 'grant' }]));
      const list = await http().get('/rest/v1/staff').set(bearer(member.token));
      expect(list.status).toBe(200);
      const row = (list.body.data as Array<Record<string, unknown>>).find((s) => s.id === staffLondon.profileId)!;
      expect(row).toMatchObject({ firstName: expect.any(String), staffRef: expect.any(String), city: 'London' });
      for (const hidden of ['email', 'phone', 'defaultPayRatePence', 'notes', 'address', 'pendingInvite', 'createdByName']) expect(row).not.toHaveProperty(hidden);
      const detail = await http().get(`/rest/v1/staff/${staffLondon.profileId}`).set(bearer(member.token));
      expect(detail.status).toBe(200);
      for (const hidden of ['email', 'phone', 'dateOfBirth', 'defaultPayRatePence', 'notes', 'emergencyContactPhone', 'rightToWorkStatus']) expect(detail.body).not.toHaveProperty(hidden);

      // A hidden field is not a search target either (the owner finds the same person by email).
      const [{ email: londonEmail }] = await owner.query(`SELECT email::text AS email FROM core."user" WHERE id = $1`, [staffLondon.userId]);
      expect((await http().get('/rest/v1/staff').query({ q: londonEmail }).set(bearer(tokenA))).body.total).toBe(1);
      expect((await http().get('/rest/v1/staff').query({ q: londonEmail }).set(bearer(member.token))).body.total).toBe(0);
      const search = await http().get('/rest/v1/search').query({ q: londonEmail }).set(bearer(member.token));
      expect(search.status).toBe(200);
      expect(search.body.filter((r: { type: string }) => r.type === 'Staff')).toEqual([]);
      // Sorting by a hidden field is ignored, not an oracle.
      expect((await http().get('/rest/v1/staff').query({ sort: 'defaultPayRatePence' }).set(bearer(member.token))).status).toBe(200);
    });

    it('F2. a field made visible is returned; job-role and shift pay rates stay hidden unless granted', async () => {
      const member = await onboardMember(
        await roleWith([
          { object: 'staff', read: 'grant', fields: { phone: 'visible', email: 'visible' } },
          { object: 'shift', read: 'grant' },
        ]),
      );
      const detail = await http().get(`/rest/v1/staff/${staffLondon.profileId}`).set(bearer(member.token));
      expect(detail.body).toMatchObject({ phone: '+447700900123', email: expect.any(String) });
      expect(detail.body).not.toHaveProperty('defaultPayRatePence');
      const shifts = await http().get('/rest/v1/shifts').set(bearer(member.token));
      expect(shifts.status).toBe(200);
      for (const s of shifts.body.data) {
        expect(s).not.toHaveProperty('payRatePence');
        expect(s).not.toHaveProperty('chargeRatePence');
        expect(s).not.toHaveProperty('createdBy');
      }
      const shift = await http().get(`/rest/v1/shifts/${shift1}`).set(bearer(member.token));
      expect(shift.status).toBe(200);
      expect(shift.body).not.toHaveProperty('payRatePence');
      const roles = await http().get('/rest/v1/job-roles').set(bearer(member.token));
      expect(roles.body.find((r: { id: string }) => r.id === jobRole)).not.toHaveProperty('defaultRatePence');
    });

    it('F3. locked fields cannot be hidden, unknown fields are refused, and an editor cannot reveal a field they cannot see themselves', async () => {
      const locked = await createRole(tokenA, definition(uniq('Locked'), [{ object: 'staff', read: 'grant', fields: { name: 'hidden' } }]));
      expect(locked.status).toBe(400);
      const unknown = await createRole(tokenA, definition(uniq('Unknown'), [{ object: 'staff', read: 'grant', fields: { password_hash: 'visible' } }]));
      expect(unknown.status).toBe(400);
      const leanOrg = await factory.createOrganisation('rfp-lean');
      const lean = await factory.createInternalManager(leanOrg, {
        permissions: ['role.view', 'role.manage', 'staff.view'],
        workspace: true,
        label: 'lean-field',
      });
      const leanToken = await factory.login(lean);
      const escalate = await createRole(leanToken, definition(uniq('Esc'), [{ object: 'staff', read: 'grant', fields: { phone: 'visible' } }]));
      expect(escalate.status).toBe(403);
      expect(escalate.body.code).toBe('ROLE_ESCALATION');
      const pay = await createRole(leanToken, definition(uniq('Pay'), [{ object: 'staff', read: 'grant', fields: { payRate: 'visible' } }]));
      expect(pay.status).toBe(403);
      expect((await createRole(leanToken, definition(uniq('Ok'), [{ object: 'staff', read: 'grant', fields: { city: 'hidden' } }]))).status).toBe(201);
    });
  });

  // ─────────────────────────────────────────────── Record level

  describe('Record level', () => {
    it('RL1. a Staff filter narrows list, detail (404), dashboard counts and search', async () => {
      const member = await onboardMember(
        await roleWith([{ object: 'staff', read: 'grant', recordFilter: { op: 'and', conditions: [{ field: 'city', operator: 'eq', value: 'london' }] } }]),
      );
      expect(staffIds(await http().get('/rest/v1/staff').set(bearer(member.token)))).toEqual([staffLondon.profileId]);
      expect((await http().get('/rest/v1/staff').set(bearer(member.token))).body.total).toBe(1);
      expect((await http().get(`/rest/v1/staff/${staffLeeds.profileId}`).set(bearer(member.token))).status).toBe(404);
      expect((await http().get(`/rest/v1/staff/${staffLondon.profileId}`).set(bearer(member.token))).status).toBe(200);
      const summary = (await http().get('/rest/v1/dashboard/summary').set(bearer(member.token))).body;
      expect(summary.staffCount).toBe(1);
      const search = (await http().get('/rest/v1/search').query({ q: 'Staff' }).set(bearer(member.token))).body as Array<{ id: string; type: string }>;
      expect(search.filter((r) => r.type === 'Staff').map((r) => r.id)).toEqual([staffLondon.profileId]);
    });

    it('RL2. Venue and Shift relation filters narrow lists and details', async () => {
      const member = await onboardMember(
        await roleWith([
          { object: 'venue', read: 'grant', recordFilter: { op: 'and', conditions: [{ field: 'name', operator: 'in', value: [venue1] }] } },
          { object: 'shift', read: 'grant', recordFilter: { op: 'or', conditions: [{ field: 'venue', operator: 'in', value: [venue1] }] } },
        ]),
      );
      const venues = await http().get('/rest/v1/venues').set(bearer(member.token));
      expect(venues.body.data.map((v: { id: string }) => v.id)).toEqual([venue1]);
      expect((await http().get(`/rest/v1/venues/${venue2}`).set(bearer(member.token))).status).toBe(404);
      const shifts = await http().get('/rest/v1/shifts').set(bearer(member.token));
      expect(shifts.body.data.map((s: { id: string }) => s.id)).toEqual([shift1]);
      expect(shifts.body.total).toBe(1);
      expect((await http().get(`/rest/v1/shifts/${shift2}`).set(bearer(member.token))).status).toBe(404);
      expect((await http().get(`/rest/v1/shifts/${shift2}/requested-staff`).set(bearer(member.token))).status).toBe(404);
    });

    it('RL3. filters are validated strictly: unknown field, bad operator, extra property, deep nesting, too many conditions, foreign ids', async () => {
      const bad = async (recordFilter: unknown, object: Rule['object'] = 'staff') =>
        (await createRole(tokenA, definition(uniq('Bad'), [{ object, read: 'grant', recordFilter }]))).status;
      expect(await bad({ op: 'and', conditions: [{ field: 'email', operator: 'eq', value: 'x' }] })).toBe(400);
      expect(await bad({ op: 'and', conditions: [{ field: 'city', operator: 'like', value: 'x' }] })).toBe(400);
      expect(await bad({ op: 'and', conditions: [{ field: 'city', operator: 'eq', value: 'x', sql: '1=1' }] })).toBe(400);
      expect(await bad({ op: 'xor', conditions: [{ field: 'city', operator: 'eq', value: 'x' }] })).toBe(400);
      expect(await bad({ op: 'and', conditions: [] })).toBe(400);
      expect(await bad({ op: 'and', conditions: [{ op: 'or', conditions: [{ op: 'and', conditions: [{ field: 'city', operator: 'eq', value: 'x' }] }] }] })).toBe(400);
      expect(await bad({ op: 'or', conditions: Array.from({ length: 21 }, () => ({ field: 'city', operator: 'eq', value: 'x' })) })).toBe(400);
      expect(await bad({ op: 'and', conditions: [{ field: 'employmentStatus', operator: 'eq', value: 'superuser' }] })).toBe(400);
      expect(await bad({ op: 'and', conditions: [{ field: 'startDate', operator: 'gte', value: '2026-13-45' }] })).toBe(400);
      // Another workspace's venue id is refused (no probing other workspaces through filter ids).
      expect(await bad({ op: 'and', conditions: [{ field: 'name', operator: 'in', value: [venueB] }] }, 'venue')).toBe(400);
      expect(await bad({ op: 'and', conditions: [{ field: 'name', operator: 'in', value: [randomUUID()] }] }, 'venue')).toBe(400);
    });

    it('RL4. a value is always data, never SQL: an injection-shaped value matches nothing', async () => {
      const member = await onboardMember(
        await roleWith([{ object: 'staff', read: 'grant', recordFilter: { op: 'and', conditions: [{ field: 'city', operator: 'eq', value: "London' OR '1'='1" }] } }]),
      );
      const list = await http().get('/rest/v1/staff').set(bearer(member.token));
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(0);
    });

    it('RL5. a stored filter that no longer validates denies everything (fail closed), never allows everything', async () => {
      const roleId = await roleWith([{ object: 'staff', read: 'grant', recordFilter: { op: 'and', conditions: [{ field: 'city', operator: 'eq', value: 'London' }] } }]);
      const member = await onboardMember(roleId);
      expect((await http().get('/rest/v1/staff').set(bearer(member.token))).body.total).toBe(1);
      await owner.query(
        `UPDATE core.role_object_permission SET record_filter = '{"op":"and","conditions":[{"field":"password_hash","operator":"eq","value":"x"}]}'::jsonb WHERE role_id = $1`,
        [roleId],
      );
      const list = await http().get('/rest/v1/staff').set(bearer(member.token));
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(0);
      expect((await http().get(`/rest/v1/staff/${staffLondon.profileId}`).set(bearer(member.token))).status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────── Consistency, lifecycle, Team

  describe('Consistency and lifecycle', () => {
    it('C1. a role change applies on the member’s very next request (no stale cached permissions)', async () => {
      const roleId = await roleWith([{ object: 'staff', read: 'grant' }]);
      const member = await onboardMember(roleId);
      const before = await http().get(`/rest/v1/staff/${staffLondon.profileId}`).set(bearer(member.token));
      expect(before.status).toBe(200);
      const [{ permission_version: v1 }] = await owner.query(`SELECT permission_version FROM core.role WHERE id = $1`, [roleId]);
      const name = (await http().get(`/rest/v1/roles/${roleId}/definition`).set(bearer(tokenA))).body.name;
      expect((await putRole(tokenA, roleId, definition(name, [{ object: 'staff', read: 'grant', fields: { city: 'hidden' } }]))).status).toBe(200);
      const [{ permission_version: v2 }] = await owner.query(`SELECT permission_version FROM core.role WHERE id = $1`, [roleId]);
      expect(Number(v2)).toBeGreaterThan(Number(v1));
      expect((await http().get(`/rest/v1/staff/${staffLondon.profileId}`).set(bearer(member.token))).body).not.toHaveProperty('city');
      expect((await putRole(tokenA, roleId, definition(name, [{ object: 'staff', read: 'deny' }]))).status).toBe(200);
      expect((await http().get('/rest/v1/staff').set(bearer(member.token))).status).toBe(403);
    });

    it('C2. a failed save changes nothing (one transaction)', async () => {
      const roleId = await roleWith([{ object: 'staff', read: 'grant' }]);
      const before = (await http().get(`/rest/v1/roles/${roleId}/definition`).set(bearer(tokenA))).body;
      const res = await putRole(tokenA, roleId, definition('Renamed', [
        { object: 'venue', read: 'grant' },
        { object: 'staff', read: 'grant', recordFilter: { op: 'and', conditions: [{ field: 'nope', operator: 'eq', value: 'x' }] } },
      ]));
      expect(res.status).toBe(400);
      const after = (await http().get(`/rest/v1/roles/${roleId}/definition`).set(bearer(tokenA))).body;
      expect(after).toEqual(before);
    });

    it('C3. names are unique per workspace (case-insensitive) but may repeat across workspaces', async () => {
      const name = uniq('Dup');
      expect((await createRole(tokenA, definition(name, []))).status).toBe(201);
      const dup = await createRole(tokenA, definition(name.toUpperCase(), []));
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('ROLE_NAME_TAKEN');
      expect((await createRole(tokenB, definition(name, []))).status).toBe(201);
    });

    it('C4. deletion: refused while in use (409 with counts), allowed when unused, never for system roles or other workspaces', async () => {
      const used = await roleWith([{ object: 'staff', read: 'grant' }]);
      await onboardMember(used);
      const refused = await http().delete(`/rest/v1/roles/${used}`).set(bearer(tokenA));
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'ROLE_IN_USE', holders: 1, invitations: 1 });
      const unused = await roleWith([]);
      expect((await http().delete(`/rest/v1/roles/${unused}`).set(bearer(tokenB))).status).toBe(404);
      expect((await http().delete(`/rest/v1/roles/${unused}`).set(bearer(tokenA))).status).toBe(204);
      expect((await http().get(`/rest/v1/roles/${unused}`).set(bearer(tokenA))).status).toBe(404);
      const [audit] = await owner.query(`SELECT action FROM core.audit_log WHERE entity_id = $1 AND action = 'role.deleted'`, [unused]);
      expect(audit).toBeDefined();
    });

    it('C5. "Assignable to Workspace Members" off: the role cannot be invited or assigned', async () => {
      const roleId = await roleWith([{ object: 'staff', read: 'grant' }], { assignableToMembers: false });
      const sent = await http().post('/rest/v1/member-invitations').set(bearer(tokenA)).send({ emails: [email()], roleId });
      expect(sent.status).toBe(404);
      const member = await onboardMember(await roleWith([{ object: 'staff', read: 'grant' }]));
      expect((await http().patch(`/rest/v1/members/${member.userId}/role`).set(bearer(tokenA)).send({ roleId })).status).toBe(404);
    });

    it('C6. Team: the owner changes a member’s role (applies at once); others and other workspaces cannot', async () => {
      const staffRole = await roleWith([{ object: 'staff', read: 'grant' }]);
      const venueRole = await roleWith([{ object: 'venue', read: 'grant' }]);
      const member = await onboardMember(staffRole);
      expect((await http().get('/rest/v1/staff').set(bearer(member.token))).status).toBe(200);
      // Not the owner / not this workspace / not a member role / the member themselves.
      expect((await http().patch(`/rest/v1/members/${member.userId}/role`).set(bearer(tokenB)).send({ roleId: venueRole })).status).toBe(404);
      expect((await http().patch(`/rest/v1/members/${member.userId}/role`).set(bearer(member.token)).send({ roleId: venueRole })).status).toBe(403);
      const roles = (await http().get('/rest/v1/roles').set(bearer(tokenA))).body as Array<{ id: string; key: string }>;
      const managerRole = roles.find((r) => r.key === 'manager')!;
      expect((await http().patch(`/rest/v1/members/${member.userId}/role`).set(bearer(tokenA)).send({ roleId: managerRole.id })).status).toBe(404);
      expect((await http().patch(`/rest/v1/members/${managerA.userId}/role`).set(bearer(tokenA)).send({ roleId: venueRole })).status).toBe(404);
      expect((await http().patch(`/rest/v1/members/${staffLondon.userId}/role`).set(bearer(tokenA)).send({ roleId: venueRole })).status).toBe(409);
      expect((await http().patch(`/rest/v1/members/${member.userId}/role`).set(bearer(tokenA)).send({ roleId: venueRole, organisationId: randomUUID() })).status).toBe(400);

      expect((await http().patch(`/rest/v1/members/${member.userId}/role`).set(bearer(tokenA)).send({ roleId: venueRole })).status).toBe(204);
      expect((await http().get('/rest/v1/staff').set(bearer(member.token))).status).toBe(403);
      expect((await http().get('/rest/v1/venues').set(bearer(member.token))).status).toBe(200);
      const [audit] = await owner.query(`SELECT metadata FROM core.audit_log WHERE entity_id = $1 AND action = 'member.role_changed' ORDER BY created_at DESC LIMIT 1`, [member.userId]);
      expect(audit.metadata).toMatchObject({ toRoleId: venueRole, fromRoleIds: [staffRole] });
    });

    it('C7. Team: suspend blocks the member immediately and reinstate restores them; only the owner can do either', async () => {
      const member = await onboardMember(await roleWith([{ object: 'staff', read: 'grant' }]));
      expect((await http().post(`/rest/v1/members/${member.userId}/suspend`).set(bearer(tokenB))).status).toBe(404);
      expect((await http().post(`/rest/v1/members/${managerA.userId}/suspend`).set(bearer(tokenA))).status).toBe(404);
      expect((await http().post(`/rest/v1/members/${member.userId}/suspend`).set(bearer(tokenA))).status).toBe(204);
      expect([401, 403]).toContain((await http().get('/rest/v1/staff').set(bearer(member.token))).status);
      const team = (await http().get('/rest/v1/members').set(bearer(tokenA))).body.data as Array<{ userId: string; status: string }>;
      expect(team.find((m) => m.userId === member.userId)?.status).toBe('suspended');
      expect((await http().post(`/rest/v1/members/${member.userId}/reinstate`).set(bearer(tokenA))).status).toBe(204);
      // Old tokens may be invalidated by the security-version bump; a fresh sign-in must work again.
      const fresh = await factory.login({ kind: 'internal_manager', email: member.address, password: STRONG });
      expect((await http().get('/rest/v1/staff').set(bearer(fresh))).status).toBe(200);
    });
  });

  // ─────────────────────────────────────────────── Database backstops

  describe('Database backstops', () => {
    it('D1. role_object_permission / role_field_permission: zero rows without tenant context or from another workspace', async () => {
      const roleId = await roleWith([{ object: 'staff', read: 'grant', fields: { city: 'hidden' } }]);
      const runtime = app.get(DataSource);
      const qr = runtime.createQueryRunner();
      await qr.connect();
      try {
        await qr.startTransaction();
        expect(await qr.query(`SELECT * FROM core.role_object_permission WHERE role_id = $1`, [roleId])).toEqual([]);
        expect(await qr.query(`SELECT * FROM core.role_field_permission WHERE role_id = $1`, [roleId])).toEqual([]);
        await qr.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [
          managerB.organisationId,
          managerB.workspaceId,
          managerB.userId,
        ]);
        expect(await qr.query(`SELECT * FROM core.role_object_permission WHERE role_id = $1`, [roleId])).toEqual([]);
        await expect(
          qr.query(
            `INSERT INTO core.role_object_permission (role_id, workspace_id, organisation_id, object_key, can_read) VALUES ($1, $2, $3, 'staff', true)`,
            [roleId, managerA.workspaceId, managerA.organisationId],
          ),
        ).rejects.toThrow();
      } finally {
        await qr.rollbackTransaction().catch(() => undefined);
        await qr.release();
      }
    });

    it('D2. the database refuses object grants on a system role and malformed filters', async () => {
      const roles = (await http().get('/rest/v1/roles').set(bearer(tokenA))).body as Array<{ id: string; key: string }>;
      const managerRole = roles.find((r) => r.key === 'manager')!;
      await expect(
        owner.query(`INSERT INTO core.role_object_permission (role_id, workspace_id, organisation_id, object_key, can_read) VALUES ($1, $2, $3, 'staff', true)`, [
          managerRole.id,
          managerA.workspaceId,
          managerA.organisationId,
        ]),
      ).rejects.toThrow();
      const roleId = await roleWith([]);
      await expect(
        owner.query(`INSERT INTO core.role_object_permission (role_id, workspace_id, organisation_id, object_key, can_read, record_filter) VALUES ($1, $2, $3, 'staff', true, '[1,2]'::jsonb)`, [
          roleId,
          managerA.workspaceId,
          managerA.organisationId,
        ]),
      ).rejects.toThrow();
    });
  });
});
