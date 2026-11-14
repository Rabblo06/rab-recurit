import 'reflect-metadata';
import { PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthService } from '../../engine/core-modules/auth/services/auth.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { erasedEmailFor, UserDeletionService } from '../../engine/core-modules/user-deletion/user-deletion.service';
import { AttendanceQrService } from '../../modules/attendance/services/attendance-qr.service';
import { ManagerService, ROLE_DEFS } from '../../modules/manager/services/manager.service';
import { StaffService } from '../../modules/staff/services/staff.service';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { createAdminDataSource } from './helpers/admin-datasource';
import { bookBeforeDeadline } from './helpers/book-before-deadline';
import { businessTable } from './helpers/hws-fixtures';
import { provisionFixtureWorkspace, TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Owner decision 0g (2026-11-14): user deletion the Twenty way (twentyhq/twenty @ eedb0a73 user.service.ts:259-283 —
 * soft delete, memberships removed, last-admin refusal). Abuse cases on real Postgres with RLS on, real HTTP routes and the
 * real sign-in paths, no mocks; run with HWS on (the default outside production) and off (HWS_RUNTIME_ENABLED=false):
 *   - a deleted user cannot sign in again: password, refresh token, live access token, existing web-session cookie, OIDC
 *     (linked identity and first-time link);
 *   - history (offer, attendance, payroll record) stays readable through the product's own list endpoints, naming the
 *     person, and reads "Deleted user" after GDPR erasure;
 *   - the soft delete takes NO lock on any workspace-schema relation, however many workspace schemas exist (pg_locks of
 *     the deleting transaction; control: the hard delete of an invite does lock them, so the probe sees such locks);
 *   - the last admin (the workspace owner), self, another tenant's user (404) and a second delete (404) are refused at the
 *     service layer itself (layer 2), not only through the routes;
 *   - GDPR erasure: refused before the delete, leaves no personal data in core."user", keeps the row, idempotent, tenant
 *     and creator scoped; e-mail reuse follows the documented rule (USER-DELETION.md §3.2).
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('user soft delete — owner 0g (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let userDeletion: UserDeletionService;
  let staffService: StaffService;
  let managerService: ManagerService;
  let authService: AuthService;
  let attendanceQr: AttendanceQrService;

  let orgId: string;
  let a: TestIdentity; // Internal Manager with workspace A (owner = the workspace's only admin)
  let tokenA: string;
  let otherOrg: { id: string };
  let otherMgr: TestIdentity;
  let venueId: string;
  let jobRoleId: string;

  const PERMS = [...ROLE_DEFS.internal!.permissions, PermissionFlag.MANAGER_MANAGE];
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const ctxOf = (who: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>): AuthContext =>
    ({ organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' }) as AuthContext;

  const userRow = async (userId: string) =>
    (await adminDataSource.query(`SELECT *, deleted_at IS NOT NULL AS is_deleted FROM core."user" WHERE id = $1`, [userId]))[0] as Record<string, any> | undefined;

  const deleteStaff = async (caller: TestIdentity, token: string, profileId: string) =>
    http().delete(`/rest/v1/staff/${profileId}`).set(auth(token)).send({ currentPassword: caller.password });
  const deleteManager = async (caller: TestIdentity, token: string, profileId: string) =>
    http().delete(`/rest/v1/managers/${profileId}`).set(auth(token)).send({ currentPassword: caller.password });

  /** A distinctive identity on the row, so "no personal data left" can be checked literally. */
  async function distinctivePersonalData(userId: string): Promise<{ first: string; last: string; phone: string }> {
    const tag = randomUUID().slice(0, 8);
    const pd = { first: `Zebulon${tag}`, last: `Quixote${tag}`, phone: `+4477009${tag.replace(/[^0-9]/g, '0').slice(0, 5).padEnd(5, '0')}` };
    await adminDataSource.query(`UPDATE core."user" SET first_name = $2, last_name = $3, phone = $4 WHERE id = $1`, [userId, pd.first, pd.last, pd.phone]);
    return pd;
  }

  async function newStaff(label: string, offerable = false): Promise<TestIdentity> {
    const s = await factory.createStaff({ id: orgId }, { owner: a, label });
    if (offerable) {
      await adminDataSource.query(`UPDATE ${businessTable(a.workspaceId!, 'staff_profile')} SET employment_status = 'active' WHERE id = $1`, [s.profileId]);
    }
    return s;
  }

  async function signQr(shiftId: string): Promise<string> {
    return tenantContext.runInTenantContext(ctxOf(a), async (m) => attendanceQr.sign(await m.findOneByOrFail(Shift, { id: shiftId })));
  }

  /** Real history through the product: shift → offer → accept → confirm → check-in → clock in/out → finalise (payroll record). */
  async function workShift(s: TestIdentity, staffToken: string): Promise<{ shiftId: string; offerId: string; attendanceId: string }> {
    const startsAt = new Date(Date.now() - 5 * 60_000);
    const endsAt = new Date(Date.now() + 8 * 3600_000);
    const shift = await http().post('/rest/v1/shifts').set(auth(tokenA)).send({ venueId, jobRoleId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), requiredCount: 1 });
    expect(shift.status).toBe(201);
    const shiftId = shift.body.id as string;
    expect((await http().post(`/rest/v1/shifts/${shiftId}/publish`).set(auth(tokenA))).status).toBe(201);
    const offerId = await bookBeforeDeadline(adminDataSource, shiftId, async () => {
      const offer = await http().post(`/rest/v1/shifts/${shiftId}/offers`).set(auth(tokenA)).send({ staffProfileId: s.profileId });
      expect({ status: offer.status, body: offer.body }).toMatchObject({ status: 201 });
      expect((await http().post(`/rest/v1/offers/${offer.body.id}/accept`).set(auth(staffToken))).status).toBe(201);
      expect((await http().post(`/rest/v1/offers/${offer.body.id}/confirm`).set(auth(tokenA))).status).toBe(201);
      return offer.body.id as string;
    });
    expect((await http().post('/rest/v1/attendance/check-in').set(auth(staffToken)).send({ shiftId })).status).toBe(200);
    expect((await http().post('/rest/v1/attendance/clock-in').set(auth(staffToken)).send({ shiftId, qrToken: await signQr(shiftId) })).status).toBe(201);
    const out = await http().post('/rest/v1/attendance/clock-out').set(auth(staffToken)).send({ qrToken: await signQr(shiftId) });
    expect(out.status).toBe(201);
    const attendanceId = out.body.id as string;
    const corrected = await http().post(`/rest/v1/attendance/${attendanceId}/correct`).set(auth(tokenA))
      .send({ field: 'clockInAt', newValue: new Date(new Date(out.body.clockOutAt).getTime() - 120 * 60_000).toISOString(), reason: '0g test: real worked time' });
    expect(corrected.status).toBe(201);
    expect((await http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${s.profileId}/attendance-review`).set(auth(tokenA))).status).toBe(200);
    const fin = await http().patch(`/rest/v1/attendance/report/shift/${shiftId}/finalise`).set(auth(tokenA));
    expect({ status: fin.status, body: fin.body }).toMatchObject({ status: 200, body: { reportStatus: 'finalised' } });
    return { shiftId, offerId, attendanceId };
  }

  const rowsOf = (body: unknown): Array<Record<string, any>> => (Array.isArray(body) ? body : ((body as { data?: unknown[] })?.data ?? [])) as Array<Record<string, any>>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    userDeletion = moduleRef.get(UserDeletionService);
    staffService = moduleRef.get(StaffService);
    managerService = moduleRef.get(ManagerService);
    authService = moduleRef.get(AuthService);
    attendanceQr = moduleRef.get(AttendanceQrService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    const org = await factory.createOrganisation('udel');
    orgId = org.id;
    a = await factory.createInternalManager(org, { permissions: PERMS, label: 'udel-a' });
    tokenA = await factory.login(a);
    otherOrg = await factory.createOrganisation('udel-other');
    otherMgr = await factory.createInternalManager(otherOrg, { permissions: PERMS, label: 'udel-x' });

    const venue = await http().post('/rest/v1/venues').set(auth(tokenA)).send({ name: `0g Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' });
    expect(venue.status).toBe(201);
    venueId = venue.body.id;
    const role = await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: `0g Role ${randomUUID()}`, defaultRatePence: 1500 });
    expect(role.status).toBe(201);
    jobRoleId = role.body.id;
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  describe('a deleted user cannot sign in again', () => {
    it('Staff: password login, refresh token and the live access token are all refused; the row is kept (soft)', async () => {
      const s = await newStaff('udel-signin');
      const { accessToken, refreshToken } = await factory.loginTokens(s);
      expect((await http().get('/rest/v1/auth/me').set(auth(accessToken))).status).toBe(200);

      const del = await deleteStaff(a, tokenA, s.profileId!);
      expect(del.status).toBe(204);

      const row = (await userRow(s.userId))!;
      expect(row).toMatchObject({ is_deleted: true, status: UserStatus.DEACTIVATED });
      expect((await http().get('/rest/v1/auth/me').set(auth(accessToken))).status).toBe(401);
      expect((await http().post('/rest/v1/auth/refresh').send({ refreshToken })).status).toBe(401);
      const relogin = await factory.loginRaw(s);
      expect(relogin.status).toBe(401);
      // Same response as an unknown e-mail (no account-existence oracle).
      const unknown = await factory.loginRaw(s, { email: `nobody-${randomUUID()}@example.test` });
      expect(relogin.body.message).toBe(unknown.body.message);
      // Every session row is revoked, nothing live is left.
      const [{ live }] = await adminDataSource.query(
        `SELECT (SELECT count(*) FROM core.refresh_token WHERE user_id = $1 AND revoked_at IS NULL)
              + (SELECT count(*) FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL) AS live`,
        [s.userId],
      );
      expect(Number(live)).toBe(0);
    });

    it('Manager: an existing web-session cookie stops working at once, and password login is refused', async () => {
      const m2 = await factory.createInternalManager({ id: orgId }, { permissions: PERMS, workspace: false, label: 'udel-cookie' });
      const loginRes = await factory.loginRaw(m2, { applicationTarget: 'manager_web' });
      expect(loginRes.status).toBe(200);
      const cookie = ([] as string[]).concat(loginRes.headers['set-cookie'] ?? []).find((c) => c.startsWith('crewflow_session='))!.split(';')[0]!;
      expect((await http().get('/rest/v1/auth/me').set('Cookie', [cookie])).status).toBe(200);

      const del = await deleteManager(a, tokenA, m2.profileId!);
      expect(del.status).toBe(204);

      expect((await http().get('/rest/v1/auth/me').set('Cookie', [cookie])).status).toBe(401);
      expect((await factory.loginRaw(m2, { applicationTarget: 'manager_web' })).status).toBe(401);
      expect((await userRow(m2.userId))!.is_deleted).toBe(true);
    });

    it('OIDC: the already-linked identity and a first-time link are both refused after the delete', async () => {
      const m3 = await factory.createInternalManager({ id: orgId }, { permissions: PERMS, workspace: false, label: 'udel-oidc' });
      const subject = randomUUID();
      await authService.signInWithProvider('google', { subject, email: m3.email, emailVerified: true }, {});

      expect((await adminDataSource.query(`SELECT 1 FROM core.user_auth_identity WHERE user_id = $1`, [m3.userId])).length).toBe(1);

      expect((await deleteManager(a, tokenA, m3.profileId!)).status).toBe(204);
      // The identity link (and its verified e-mail snapshot) is removed with the account's other ways in.
      expect(await adminDataSource.query(`SELECT 1 FROM core.user_auth_identity WHERE user_id = $1`, [m3.userId])).toEqual([]);

      await expect(authService.signInWithProvider('google', { subject, email: m3.email, emailVerified: true }, {})).rejects.toThrow(/could not sign you in/i);
      await expect(authService.signInWithProvider('microsoft', { subject: randomUUID(), email: m3.email, emailVerified: true }, {})).rejects.toThrow(/could not sign you in/i);
    });
  });

  describe('history stays readable', () => {
    it('offer, attendance and payroll record still list the deleted Staff member by name; after GDPR erasure they read "Deleted user"', async () => {
      const s = await newStaff('udel-history', true);
      const pd = await distinctivePersonalData(s.userId);
      const staffToken = await factory.login(s);
      const worked = await workShift(s, staffToken);

      const del = await deleteStaff(a, tokenA, s.profileId!);
      expect(del.status).toBe(204);
      // Soft: account row, staff profile and every history row are still there; the profile is inactive.
      expect((await userRow(s.userId))!.is_deleted).toBe(true);
      const [profile] = await adminDataSource.query(`SELECT employment_status FROM ${businessTable(a.workspaceId!, 'staff_profile')} WHERE id = $1`, [s.profileId]);
      expect(profile.employment_status).toBe('inactive');
      for (const [table, id] of [['job_offer', worked.offerId], ['attendance', worked.attendanceId]] as const) {
        expect(await adminDataSource.query(`SELECT 1 FROM ${businessTable(a.workspaceId!, table)} WHERE id = $1`, [id])).toHaveLength(1);
      }
      expect(await adminDataSource.query(`SELECT 1 FROM ${businessTable(a.workspaceId!, 'payroll_record')} WHERE attendance_id = $1`, [worked.attendanceId])).toHaveLength(1);

      const nameIn = async (expected: string) => {
        const offers = await http().get('/rest/v1/offers').set(auth(tokenA)).query({ limit: 100 });
        expect(offers.status).toBe(200);
        expect(rowsOf(offers.body).find((o) => o.id === worked.offerId)?.staffName).toBe(expected);
        const attendance = await http().get('/rest/v1/attendance').set(auth(tokenA)).query({ limit: 100 });
        expect(attendance.status).toBe(200);
        expect(rowsOf(attendance.body).find((r) => r.id === worked.attendanceId)?.staffName).toBe(expected);
        const payroll = await http().get('/rest/v1/payroll/records').set(auth(tokenA)).query({ limit: 100 });
        expect(payroll.status).toBe(200);
        expect(rowsOf(payroll.body).find((r) => r.attendanceId === worked.attendanceId)?.staffName).toBe(expected);
      };
      await nameIn(`${pd.first} ${pd.last}`);

      const erase = await http().post(`/rest/v1/staff/${s.profileId}/erase-personal-data`).set(auth(tokenA)).send({ currentPassword: a.password });
      expect(erase.status).toBe(204);
      await nameIn('Deleted user');
    });
  });

  describe('no locks outside the touched rows', () => {
    // Workspace schemas in the database (every schema's foreign keys to core."user" count for a DELETE). Locally run with
    // USER_DELETE_LOCK_TEST_WORKSPACES=300; CI keeps the default small (provisioning cost), the assertion is count-independent.
    const W = Number(process.env.USER_DELETE_LOCK_TEST_WORKSPACES ?? 12);

    const relationLocks = (m: EntityManager) =>
      m.query<Array<{ nspname: string; relname: string; mode: string }>>(
        `SELECT n.nspname, c.relname, l.mode FROM pg_catalog.pg_locks l
           JOIN pg_catalog.pg_class c ON c.oid = l.relation JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'relation'`,
      );

    it(`soft delete with ${W}+ workspace schemas: no relation lock in any workspace schema (control: an invite's hard delete takes them)`, async () => {
      const lockOrg = await factory.createOrganisation('udel-locks');
      for (let i = 0; i < W; i += 1) {
        const owner = await factory.createInternalManager(lockOrg, { label: `udel-lock-${i}`, provision: false });
        // Fixture only: core.provision_workspace (the server path, unchanged) on the superuser fixture connection with a
        // statement timeout raised for THIS statement — with hundreds of schemas the catalogue grows and one provisioning
        // can exceed the runtime's 30 s on a loaded host. The assertion below is untouched.
        await adminDataSource.transaction(async (m) => {
          await m.query(`SET LOCAL statement_timeout = '600s'`);
          await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [lockOrg.id, owner.userId]);
          await provisionFixtureWorkspace(m, owner.workspaceId!);
        });
      }
      const [{ n }] = await adminDataSource.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname LIKE 'workspace\\_%'`);
      expect(n).toBeGreaterThanOrEqual(W);

      // Target with history (it created a venue in A): an ACTIVE Venue Manager → soft delete.
      const vm = await factory.createVenueManager({ id: orgId }, { owner: a, label: 'udel-lock-vm' });
      await tenantContext.runInTenantContext(ctxOf(a), (m) =>
        m.query(`INSERT INTO venue (organisation_id, name, created_by, workspace_id) VALUES ($1, $2, $3, $4)`, [orgId, `0g lock venue ${randomUUID().slice(0, 6)}`, vm.userId, a.workspaceId]),
      );
      const soft = await tenantContext.runInTenantContext(ctxOf(a), async (m) => {
        const outcome = await userDeletion.deleteUser(m, ctxOf(a), vm.userId);
        return { outcome, locks: await relationLocks(m) };
      });
      expect(soft.outcome).toBe('soft_deleted');
      const workspaceLocks = soft.locks.filter((l) => l.nspname.startsWith('workspace_'));
      expect(workspaceLocks).toEqual([]);
      // Every relation the soft delete locked is a core table (or the catalogue this probe reads), nothing else.
      expect(soft.locks.filter((l) => !['core', 'pg_catalog'].includes(l.nspname))).toEqual([]);

      // Control: the probe does see workspace locks — a never-activated invite with no history is HARD deleted, and the
      // RI checks of that DELETE lock the referencing tables of every workspace schema (C1-STATUS §5).
      const invite = await http().post('/rest/v1/managers').set(auth(tokenA)).send({ email: `udel-lock-inv-${randomUUID()}@example.test`, firstName: 'Lock', lastName: 'Invite', type: 'internal' });
      expect(invite.status).toBe(201);
      const [{ user_id: inviteUserId }] = await adminDataSource.query(`SELECT user_id FROM core.manager_profile WHERE id = $1`, [invite.body.id]);
      const hard = await tenantContext.runInTenantContext(ctxOf(a), async (m) => {
        const outcome = await userDeletion.deleteUser(m, ctxOf(a), inviteUserId);
        return { outcome, locks: await relationLocks(m) };
      });
      expect(hard.outcome).toBe('hard_deleted');
      const lockedSchemas = new Set(hard.locks.filter((l) => l.nspname.startsWith('workspace_')).map((l) => l.nspname));
      expect(lockedSchemas.size).toBeGreaterThanOrEqual(W);
    }, 120_000 + W * 10_000); // each fixture workspace is one core.provision_workspace (seconds on a loaded host)
  });

  describe('gates and tenancy at the service layer (layer 2)', () => {
    it('ABUSE: the last admin of a workspace (its owner) → 409 MANAGER_OWNS_WORKSPACE, nothing changed', async () => {
      const owner = await factory.createInternalManager({ id: orgId }, { permissions: PERMS, label: 'udel-owner' });
      await expect(tenantContext.runInTenantContext(ctxOf(a), (m) => userDeletion.deleteUser(m, ctxOf(a), owner.userId))).rejects.toMatchObject({
        status: 409,
        response: { code: 'MANAGER_OWNS_WORKSPACE' },
      });
      const row = (await userRow(owner.userId))!;
      expect(row).toMatchObject({ is_deleted: false, status: UserStatus.ACTIVE });
      // Through the route too.
      const res = await deleteManager(a, tokenA, owner.profileId!);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MANAGER_OWNS_WORKSPACE');
    });

    it('ABUSE: self → 409 CANNOT_DELETE_SELF at the service layer', async () => {
      await expect(tenantContext.runInTenantContext(ctxOf(a), (m) => userDeletion.deleteUser(m, ctxOf(a), a.userId))).rejects.toMatchObject({
        status: 409,
        response: { code: 'CANNOT_DELETE_SELF' },
      });
    });

    it("ABUSE: another tenant's user → 404 (service and route), the row unchanged", async () => {
      const victim = await factory.createVenueManager(otherOrg, { owner: otherMgr, label: 'udel-victim' });
      await expect(tenantContext.runInTenantContext(ctxOf(a), (m) => userDeletion.deleteUser(m, ctxOf(a), victim.userId))).rejects.toMatchObject({ status: 404 });
      expect((await deleteManager(a, tokenA, victim.profileId!)).status).toBe(404);
      await expect(tenantContext.runInTenantContext(ctxOf(a), (m) => userDeletion.erasePersonalData(m, ctxOf(a), victim.userId))).rejects.toMatchObject({ status: 404 });
      expect((await http().post(`/rest/v1/managers/${victim.profileId}/erase-personal-data`).set(auth(tokenA)).send({ currentPassword: a.password })).status).toBe(404);
      expect((await userRow(victim.userId))!).toMatchObject({ is_deleted: false, email: victim.email });
    });

    it('a second delete of the same account is 404 (service and route)', async () => {
      const vm = await factory.createVenueManager({ id: orgId }, { owner: a, label: 'udel-twice' });
      expect((await deleteManager(a, tokenA, vm.profileId!)).status).toBe(204);
      expect((await deleteManager(a, tokenA, vm.profileId!)).status).toBe(404);
      await expect(tenantContext.runInTenantContext(ctxOf(a), (m) => userDeletion.deleteUser(m, ctxOf(a), vm.userId))).rejects.toMatchObject({ status: 404 });
    });

    it('soft delete removes every membership and role of the account (Twenty: memberships removed), audited without personal data', async () => {
      const vm = await factory.createVenueManager({ id: orgId }, { owner: a, label: 'udel-members' });
      expect((await deleteManager(a, tokenA, vm.profileId!)).status).toBe(204);
      const [m] = await adminDataSource.query(
        `SELECT (SELECT count(*)::int FROM core.user_role WHERE user_id = $1) AS roles,
                (SELECT count(*)::int FROM core.workspace_membership WHERE user_id = $1 AND status = 'active') AS active_memberships,
                (SELECT count(*)::int FROM core.organisation_member WHERE user_id = $1 AND status = 'active') AS org_members`,
        [vm.userId],
      );
      expect(m).toEqual({ roles: 0, active_memberships: 0, org_members: 0 });
      const [audit] = await adminDataSource.query(
        `SELECT actor_user_id, target_user_id, metadata FROM core.audit_log WHERE action = 'user.deleted' AND target_user_id = $1`,
        [vm.userId],
      );
      expect(audit).toMatchObject({ actor_user_id: a.userId, target_user_id: vm.userId, metadata: { deletion: 'soft' } });
      expect(JSON.stringify(audit.metadata)).not.toContain(vm.email);
    });
  });

  describe('GDPR erasure', () => {
    it('refused before the delete (409); afterwards core."user" keeps no personal data, keeps the row; idempotent; audited', async () => {
      const s = await newStaff('udel-erase');
      const pd = await distinctivePersonalData(s.userId);
      const before = await http().post(`/rest/v1/staff/${s.profileId}/erase-personal-data`).set(auth(tokenA)).send({ currentPassword: a.password });
      expect(before.status).toBe(409);
      expect(before.body.code).toBe('USER_NOT_DELETED');
      expect((await userRow(s.userId))!.first_name).toBe(pd.first);

      // A sign-in first, so the delete is soft (an activated account), then erase.
      await factory.loginTokens(s);
      expect((await deleteStaff(a, tokenA, s.profileId!)).status).toBe(204);
      const wrongPassword = await http().post(`/rest/v1/staff/${s.profileId}/erase-personal-data`).set(auth(tokenA)).send({ currentPassword: 'not-the-password' });
      expect(wrongPassword.status).toBe(403);
      const erase = await http().post(`/rest/v1/staff/${s.profileId}/erase-personal-data`).set(auth(tokenA)).send({ currentPassword: a.password });
      expect(erase.status).toBe(204);

      const row = (await userRow(s.userId))!;
      expect(row).toMatchObject({
        id: s.userId, is_deleted: true, first_name: 'Deleted', last_name: 'user', email: erasedEmailFor(s.userId),
        phone: null, avatar_file_id: null, avatar_key: null, password_hash: null, temporary_password_hash: null, email_verified_at: null,
        totp_secret_encrypted: null, totp_enabled: false,
      });
      const serialised = JSON.stringify((await adminDataSource.query(`SELECT row_to_json(u) AS r FROM core."user" u WHERE id = $1`, [s.userId]))[0].r).toLowerCase();
      for (const value of [s.email, pd.first, pd.last, pd.phone]) expect(serialised).not.toContain(value.toLowerCase());

      // Idempotent, one audit row.
      expect((await http().post(`/rest/v1/staff/${s.profileId}/erase-personal-data`).set(auth(tokenA)).send({ currentPassword: a.password })).status).toBe(204);
      const audits = await adminDataSource.query(`SELECT actor_user_id FROM core.audit_log WHERE action = 'user.personal_data_erased' AND target_user_id = $1`, [s.userId]);
      expect(audits).toEqual([{ actor_user_id: a.userId }]);
    });

    it("ABUSE: another manager's Staff (creator-private) → 404, nothing erased", async () => {
      const b = await factory.createInternalManager({ id: orgId }, { permissions: PERMS, label: 'udel-b' });
      const tokenB = await factory.login(b);
      const s = await newStaff('udel-erase-scope');
      await factory.loginTokens(s);
      expect((await deleteStaff(a, tokenA, s.profileId!)).status).toBe(204);
      const res = await http().post(`/rest/v1/staff/${s.profileId}/erase-personal-data`).set(auth(tokenB)).send({ currentPassword: b.password });
      expect(res.status).toBe(404);
      expect((await userRow(s.userId))!.email).toBe(s.email);
    });

    it('e-mail reuse (USER-DELETION.md §3.2): refused in the same organisation while soft-deleted, free after erasure', async () => {
      const s = await newStaff('udel-reuse');
      await factory.loginTokens(s);
      expect((await deleteStaff(a, tokenA, s.profileId!)).status).toBe(204);
      const again = await http().post('/rest/v1/staff').set(auth(tokenA)).send({ email: s.email, firstName: 'Re', lastName: 'Hire' });
      expect(again.status).toBe(409);
      expect((await http().post(`/rest/v1/staff/${s.profileId}/erase-personal-data`).set(auth(tokenA)).send({ currentPassword: a.password })).status).toBe(204);
      const afterErase = await http().post('/rest/v1/staff').set(auth(tokenA)).send({ email: s.email, firstName: 'Re', lastName: 'Hire' });
      expect(afterErase.status).toBe(201);
    });
  });

  describe('a deleted account leaves the people lists (Twenty: the member is gone)', () => {
    it('Staff list, Staff detail and people search no longer return it; history reads above still do', async () => {
      const s = await newStaff('udel-lists');
      const pd = await distinctivePersonalData(s.userId);
      await factory.loginTokens(s);
      const listedBefore = await http().get('/rest/v1/staff').set(auth(tokenA)).query({ limit: 100, q: pd.last });
      expect(rowsOf(listedBefore.body).map((r) => r.id)).toContain(s.profileId);

      expect((await deleteStaff(a, tokenA, s.profileId!)).status).toBe(204);

      const listed = await http().get('/rest/v1/staff').set(auth(tokenA)).query({ limit: 100, q: pd.last });
      expect(listed.status).toBe(200);
      expect(rowsOf(listed.body).map((r) => r.id)).not.toContain(s.profileId);
      expect((await http().get(`/rest/v1/staff/${s.profileId}`).set(auth(tokenA))).status).toBe(404);
      const search = await http().get('/rest/v1/search').set(auth(tokenA)).query({ q: pd.last });
      expect(search.status).toBe(200);
      expect(JSON.stringify(search.body)).not.toContain(s.profileId!);
    });
  });
  describe('security review fixes (M1, M2, L3, erasure gaps, fallbacks)', () => {
    /** A permission revoked for one user by override, with the security version bumped so no cached permission set survives. */
    async function revoke(userId: string, flag: string): Promise<void> {
      await adminDataSource.query(
        `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
         SELECT $1, p.id, u.organisation_id, 'revoke' FROM core.permission p, core."user" u WHERE p.key = $2 AND u.id = $1`,
        [userId, flag],
      );
      await adminDataSource.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [userId]);
    }

    async function until(probe: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await probe()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out waiting for ${what}`);
    }

    it('ABUSE (M1): StaffService.deleteUser without STAFF_DEACTIVATE (revoked by override) → 403 at the service layer, user untouched', async () => {
      const c = await factory.createInternalManager({ id: orgId }, { permissions: PERMS, label: 'udel-m1-staff' });
      const s = await factory.createStaff({ id: orgId }, { owner: c, label: 'udel-m1-staff-target' });
      await revoke(c.userId, PermissionFlag.STAFF_DEACTIVATE);
      await expect(staffService.deleteUser(ctxOf(c), s.profileId!, c.password)).rejects.toMatchObject({ status: 403 });
      expect((await userRow(s.userId))!.is_deleted).toBe(false);
    });

    it('ABUSE (M1): ManagerService.deleteUser without MANAGER_MANAGE → 403; the own-workspace Venue Manager route still works for that owner', async () => {
      const c = await factory.createInternalManager({ id: orgId }, { permissions: PERMS, label: 'udel-m1-mgr' });
      const vm = await factory.createVenueManager({ id: orgId }, { owner: c, label: 'udel-m1-vm' });
      await revoke(c.userId, PermissionFlag.MANAGER_MANAGE);
      await expect(managerService.deleteUser(ctxOf(c), vm.profileId!, c.password)).rejects.toMatchObject({ status: 403 });
      expect((await userRow(vm.userId))!.is_deleted).toBe(false);
      // VENUE_MANAGER_CREATE + own workspace is that route's own rule (a workspace owner may lack MANAGER_MANAGE).
      const token = await factory.login(c);
      const viaVmRoute = await http().delete(`/rest/v1/venue-managers/${vm.profileId}`).set(auth(token)).send({ currentPassword: c.password });
      expect(viaVmRoute.status).toBeLessThan(300);
      expect((await userRow(vm.userId))!.is_deleted).toBe(true);
      // Another workspace's Venue Manager through that route → 404.
      const other = await factory.createVenueManager({ id: orgId }, { owner: a, label: 'udel-m1-vm-other' });
      expect((await http().delete(`/rest/v1/venue-managers/${other.profileId}`).set(auth(token)).send({ currentPassword: c.password })).status).toBe(404);
      expect((await userRow(other.userId))!.is_deleted).toBe(false);
    });

    it('ABUSE (M2): a team row committed by another transaction DURING an invite hard delete is never cascaded away (soft delete instead)', async () => {
      const invitee = await factory.createStaff({ id: orgId }, { owner: a, label: 'udel-m2-invitee', status: 'invited' });
      const vm = await factory.createVenueManager({ id: orgId }, { owner: a, label: 'udel-m2-vm' });
      const conn1 = adminDataSource.createQueryRunner();
      await conn1.connect();
      await conn1.startTransaction();
      let deleting: Promise<string> | undefined;
      try {
        // Uncommitted: holds FOR KEY SHARE on the invitee's staff profile (the FK check).
        await conn1.query(
          `INSERT INTO ${businessTable(a.workspaceId!, 'venue_manager_staff')} (organisation_id, workspace_id, manager_profile_id, staff_profile_id) VALUES ($1, $2, $3, $4)`,
          [orgId, a.workspaceId, vm.profileId, invitee.profileId],
        );
        deleting = tenantContext.runInTenantContext(ctxOf(a), (m) => userDeletion.deleteUser(m, ctxOf(a), invitee.userId));
        deleting.catch(() => undefined);
        await until(
          async () => (await adminDataSource.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`))[0].n > 0,
          'the delete to wait on the staff profile lock',
        );
        await conn1.commitTransaction();
        expect(await deleting).toBe('soft_deleted');
      } finally {
        if (conn1.isTransactionActive) await conn1.rollbackTransaction();
        await conn1.release();
      }
      expect(await adminDataSource.query(`SELECT 1 FROM ${businessTable(a.workspaceId!, 'venue_manager_staff')} WHERE staff_profile_id = $1`, [invitee.profileId])).toHaveLength(1);
      expect((await userRow(invitee.userId))!.is_deleted).toBe(true);
    });

    it('a lock timeout on a referencing table during an invite hard delete falls back to a soft delete (55P03)', async () => {
      const invitee = await factory.createStaff({ id: orgId }, { owner: a, label: 'udel-locktimeout', status: 'invited' });
      const conn1 = adminDataSource.createQueryRunner();
      await conn1.connect();
      await conn1.startTransaction();
      try {
        // core.navigation_layout references core."user" ON DELETE CASCADE; nothing on the soft path touches it.
        await conn1.query(`LOCK TABLE core.navigation_layout IN ACCESS EXCLUSIVE MODE`);
        const outcome = await tenantContext.runInTenantContext(ctxOf(a), async (m) => {
          await m.query(`SET LOCAL lock_timeout = '2s'`);
          return userDeletion.deleteUser(m, ctxOf(a), invitee.userId);
        });
        expect(outcome).toBe('soft_deleted');
      } finally {
        await conn1.rollbackTransaction();
        await conn1.release();
      }
      expect((await userRow(invitee.userId))!.is_deleted).toBe(true);
    });

    it('ABUSE (L3): reactivating a deleted Staff member → 404, the account stays deleted and deactivated', async () => {
      const s = await newStaff('udel-l3');
      await factory.loginTokens(s);
      expect((await deleteStaff(a, tokenA, s.profileId!)).status).toBe(204);
      const freshToken = await factory.login(a); // a fresh sign-in carries the step-up grant reactivate needs
      expect((await http().post(`/rest/v1/staff/${s.profileId}/reactivate`).set(auth(freshToken))).status).toBe(404);
      expect((await userRow(s.userId))!).toMatchObject({ is_deleted: true, status: UserStatus.DEACTIVATED });
    });

    it('erasure of a deleted Manager through the route (happy path); a CEO target by a non-platform-admin → 403', async () => {
      const vm = await factory.createVenueManager({ id: orgId }, { owner: a, label: 'udel-erase-mgr' });
      await distinctivePersonalData(vm.userId);
      expect((await deleteManager(a, tokenA, vm.profileId!)).status).toBe(204);
      const erase = await http().post(`/rest/v1/managers/${vm.profileId}/erase-personal-data`).set(auth(tokenA)).send({ currentPassword: a.password });
      expect(erase.status).toBe(204);
      expect((await userRow(vm.userId))!).toMatchObject({ first_name: 'Deleted', last_name: 'user', email: erasedEmailFor(vm.userId), phone: null });

      const ceo = await factory.createInternalManager({ id: orgId }, { type: 'ceo', workspace: false, label: 'udel-erase-ceo' });
      await adminDataSource.query(`UPDATE core."user" SET deleted_at = now(), status = 'deactivated' WHERE id = $1`, [ceo.userId]);
      const refused = await http().post(`/rest/v1/managers/${ceo.profileId}/erase-personal-data`).set(auth(tokenA)).send({ currentPassword: a.password });
      expect(refused.status).toBe(403);
      expect((await userRow(ceo.userId))!.email).toBe(ceo.email);
    });

    it('ABUSE: erasure at the service layer — without STAFF_DEACTIVATE → 403; under Admin Inspect → 403 (delete too); nothing changed', async () => {
      const c = await factory.createInternalManager({ id: orgId }, { permissions: PERMS, label: 'udel-erase-403' });
      const s = await factory.createStaff({ id: orgId }, { owner: c, label: 'udel-erase-403-target' });
      await factory.loginTokens(s);
      await tenantContext.runInTenantContext(ctxOf(c), (m) => userDeletion.deleteUser(m, ctxOf(c), s.userId));
      await revoke(c.userId, PermissionFlag.STAFF_DEACTIVATE);
      await expect(staffService.erasePersonalData(ctxOf(c), s.profileId!, c.password)).rejects.toMatchObject({ status: 403 });

      const inspecting = { ...ctxOf(a), inspectedBy: randomUUID() } as AuthContext;
      await expect(tenantContext.runInTenantContext(ctxOf(a), (m) => userDeletion.erasePersonalData(m, inspecting, s.userId))).rejects.toMatchObject({
        status: 403,
        response: { code: 'INSPECT_READ_ONLY' },
      });
      const live = await factory.createVenueManager({ id: orgId }, { owner: a, label: 'udel-inspect-del' });
      await expect(tenantContext.runInTenantContext(ctxOf(a), (m) => userDeletion.deleteUser(m, inspecting, live.userId))).rejects.toMatchObject({ status: 403 });
      expect((await userRow(s.userId))!.email).toBe(s.email);
      expect((await userRow(live.userId))!.is_deleted).toBe(false);
    });

    it('the hard-delete audit row carries the id only, never the e-mail (review L4)', async () => {
      const invite = await http().post('/rest/v1/managers').set(auth(tokenA)).send({ email: `udel-l4-${randomUUID()}@example.test`, firstName: 'L', lastName: 'Four', type: 'internal' });
      expect(invite.status).toBe(201);
      const [{ user_id: userId }] = await adminDataSource.query(`SELECT user_id FROM core.manager_profile WHERE id = $1`, [invite.body.id]);
      expect((await deleteManager(a, tokenA, invite.body.id)).status).toBe(204);
      expect(await userRow(userId)).toBeUndefined();
      const [audit] = await adminDataSource.query(`SELECT metadata FROM core.audit_log WHERE action = 'user.deleted' AND metadata->>'deletedUserId' = $1`, [userId]);
      expect(audit.metadata).toEqual({ deletion: 'hard', deletedUserId: userId });
    });
  });
});
