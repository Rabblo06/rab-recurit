import 'reflect-metadata';
import { INestApplication, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { InvitationRateLimitService } from '../../engine/core-modules/rate-limit/invitation-rate-limit.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Settings → Members with exact role and access rules (owner-approved design 2026-10-14) — real PostgreSQL with
 * RLS on, real HTTP, real Redis. Every control is asserted on its denial, not only the happy path. Invitation tokens
 * are read from the queued email exactly as a recipient receives them; nothing is mocked.
 *
 *  - Roles: custom workspace-member roles live in ONE workspace, are keyed `custom_…`, hold only member-safe
 *    permissions, never more than their creator holds; system roles are read-only.
 *  - Invite: email-only, custom roles of the inviter's own workspace only — never Staff, Venue Manager, Manager or
 *    leadership; the recipient joins the inviter's workspace (no profile, no new workspace).
 *  - Members read their workspace owner's records through creator-based ownership, nothing else.
 *  - Add (leadership onboarding) is never reachable by an Initial Manager.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const GENERIC = 'This invitation link is invalid or has expired.';
const STRONG = 'Correct-Horse-42-battery';
const MEMBER_PERMS = ['staff.view', 'venue.view', 'schedule.view'];

describeIfDb('Members: custom workspace roles, email-first invitations, member access, Team (integration)', () => {
  let app: INestApplication;
  let owner: DataSource;
  let runtime: DataSource;
  let factory: TestIdentityFactory;

  let org: Organisation;
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let ceo: TestIdentity;
  let staffA: TestIdentity;
  let staffB: TestIdentity;
  let venueManagerA: TestIdentity;
  let tokenA: string;
  let tokenB: string;
  let tokenCeo: string;
  let roleA: { id: string; key: string };
  let roleB: { id: string; key: string };
  let venueA: string;
  let venueB: string;

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const email = (label = 'invitee') => `${label}-${randomUUID().slice(0, 8)}@example.test`;
  // Role definitions (RoleObjectFieldPermissions): a read flag is granted by a per-object "grant" rule.
  const OBJECT_OF: Record<string, string> = { 'staff.view': 'staff', 'venue.view': 'venue', 'schedule.view': 'shift' };
  const definition = (name: string, permissionKeys: string[]) => ({
    name,
    assignableToMembers: true,
    readAllObjects: false,
    objects: permissionKeys.map((key) => ({ object: OBJECT_OF[key], read: 'grant' })),
  });
  const createRole = (token: string, name: string, permissionKeys: string[]) => http().post('/rest/v1/roles').set(bearer(token)).send(definition(name, permissionKeys));
  const send = (token: string, body: Record<string, unknown>) => http().post('/rest/v1/member-invitations').set(bearer(token)).send(body);
  const list = (token: string, query = '') => http().get(`/rest/v1/member-invitations${query}`).set(bearer(token));
  const resend = (token: string, id: string) => http().post(`/rest/v1/member-invitations/${id}/resend`).set(bearer(token)).send({});
  const revoke = (token: string, id: string) => http().post(`/rest/v1/member-invitations/${id}/revoke`).set(bearer(token)).send({});
  const accept = (body: Record<string, unknown>) => http().post('/rest/v1/invitations/accept').send(body);
  const resolve = (token: string) => http().post('/rest/v1/invitations/resolve').send({ token });
  const team = (token: string, query = '') => http().get(`/rest/v1/members${query}`).set(bearer(token));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    runtime = moduleRef.get(DataSource);
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: runtime,
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    // Fresh rate-limit state for this run (the suite's own Redis DB; keys are namespaced to invite-rate only).
    const redis = new Redis(process.env.REDIS_URL!);
    const keys = await redis.keys('crewflow:test:invite-rate:*');
    if (keys.length) await redis.del(...keys);
    await redis.quit();

    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'inv' });
    org = seeded.organisation;
    [managerA, managerB] = seeded.managers as [TestIdentity, TestIdentity];
    // managerA plays the organisation's Initial Manager (the one-slot flag only the onboarding service sets).
    await owner.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE id = $1`, [managerA.profileId]);
    ceo = await factory.createCeo(org, { permissions: 'production' });
    staffA = await factory.createStaff(org, { owner: managerA });
    staffB = await factory.createStaff(org, { owner: managerB });
    tokenA = await factory.login(managerA);
    tokenB = await factory.login(managerB);
    tokenCeo = await factory.login(ceo);
    const createdA = await createRole(tokenA, 'Supervisor', MEMBER_PERMS);
    const createdB = await createRole(tokenB, 'Supervisor', MEMBER_PERMS);
    if (createdA.status !== 201 || createdB.status !== 201) throw new Error(`role setup failed: ${JSON.stringify([createdA.body, createdB.body])}`);
    roleA = createdA.body;
    roleB = createdB.body;
    venueA = (await http().post('/rest/v1/venues').set(bearer(tokenA)).send({ name: `Venue A ${randomUUID().slice(0, 6)}`, type: 'hotel' })).body.id;
    venueB = (await http().post('/rest/v1/venues').set(bearer(tokenB)).send({ name: `Venue B ${randomUUID().slice(0, 6)}`, type: 'hotel' })).body.id;
    if (!venueA || !venueB) throw new Error('venue setup failed');
    venueManagerA = await factory.createVenueManager(org, { owner: managerA, venueIds: [venueA] });
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
  });

  async function invitationByEmail(address: string) {
    const [row] = await owner.query(`SELECT * FROM core.member_invitation WHERE email = $1 ORDER BY created_at DESC LIMIT 1`, [address]);
    return row;
  }

  /** The raw token, read from the latest queued email for this invitation — exactly what the recipient receives. */
  async function tokenFromEmail(invitationId: string): Promise<string> {
    const [row] = await owner.query(
      `SELECT rendered_html FROM core.email_outbox WHERE member_invitation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [invitationId],
    );
    const match = /accept-invitation\?token=([A-Za-z0-9_\-%]+)/.exec(row.rendered_html as string);
    if (!match) throw new Error('no invitation link in the email');
    return decodeURIComponent(match[1]!);
  }

  async function inviteOne(token: string, roleId: string, address = email()): Promise<{ address: string; id: string; raw: string }> {
    const res = await send(token, { emails: [address], roleId });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([expect.objectContaining({ email: address, outcome: 'invited' })]);
    const row = await invitationByEmail(address);
    return { address, id: row.id, raw: await tokenFromEmail(row.id) };
  }

  /** Invite → accept → first login. Returns the member's identity and access token. */
  async function onboardMember(inviterToken: string, roleId: string): Promise<{ address: string; userId: string; token: string }> {
    const { address, raw } = await inviteOne(inviterToken, roleId);
    expect((await accept({ token: raw, firstName: 'Mem', lastName: 'Ber', newPassword: STRONG })).status).toBe(200);
    const token = await factory.login({ kind: 'internal_manager', email: address, password: STRONG });
    const [user] = await owner.query(`SELECT id FROM core."user" WHERE email = $1`, [address]);
    return { address, userId: user.id, token };
  }

  // ─────────────────────────────────────────────── Roles

  describe('Roles', () => {
    it('R1. a custom role belongs to its creator’s workspace only: Manager B can neither see, read nor edit it (404)', async () => {
      const [row] = await owner.query(`SELECT workspace_id, key, is_system FROM core.role WHERE id = $1`, [roleA.id]);
      expect(row).toEqual({ workspace_id: managerA.workspaceId, key: expect.stringMatching(/^custom_supervisor/), is_system: false });
      const bList = await http().get('/rest/v1/roles').set(bearer(tokenB));
      expect(bList.status).toBe(200);
      expect(bList.body.map((r: { id: string }) => r.id)).not.toContain(roleA.id);
      expect(bList.body.find((r: { id: string }) => r.id === roleB.id)).toMatchObject({ isMemberRole: true });
      expect(bList.body.filter((r: { isSystem: boolean }) => r.isSystem).every((r: { isMemberRole: boolean }) => !r.isMemberRole)).toBe(true);
      expect((await http().get(`/rest/v1/roles/${roleA.id}`).set(bearer(tokenB))).status).toBe(404);
      expect((await http().put(`/rest/v1/roles/${roleA.id}`).set(bearer(tokenB)).send(definition('Hijacked', ['staff.view']))).status).toBe(404);
      expect((await http().get(`/rest/v1/roles/${roleA.id}/definition`).set(bearer(tokenB))).status).toBe(404);
      expect((await http().delete(`/rest/v1/roles/${roleA.id}`).set(bearer(tokenB))).status).toBe(404);
    });

    it('R2. a custom role can never take a privileged system key, and never a system role\'s name', async () => {
      for (const name of ['Admin', 'Super Admin', 'org_admin', 'manager_role']) {
        const res = await createRole(tokenA, name, ['staff.view']);
        expect(res.status).toBe(201);
        expect(res.body.key).toMatch(/^custom_/);
      }
      // Look-alike names of system roles are refused outright (case-insensitive, trimmed).
      for (const name of ['Manager', ' manager ', 'Staff', 'Venue Manager']) {
        const res = await createRole(tokenA, name, ['staff.view']);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ROLE_NAME_TAKEN');
      }
    });

    it('R3. a custom role holds only member-safe permissions (400) and never more than its creator holds (403)', async () => {
      // Raw permission keys are not part of the API any more, and only Staff / Venues / Shifts exist as objects.
      for (const forbidden of ['manager.manage', 'role.manage', 'user.manage_permissions', 'staff.create', 'offer.respond', 'attendance.clock', 'payroll.approve']) {
        const res = await http().post('/rest/v1/roles').set(bearer(tokenA)).send({ ...definition(`Bad ${forbidden}`, ['staff.view']), permissionKeys: [forbidden] });
        expect(res.status).toBe(400);
      }
      for (const object of ['payroll', 'manager', 'role', 'audit_log']) {
        const res = await http().post('/rest/v1/roles').set(bearer(tokenA)).send({ ...definition(`Bad ${object}`, []), objects: [{ object, read: 'grant' }] });
        expect(res.status).toBe(400);
      }
      // A role manager who lacks venue.view cannot grant it.
      const lean = await factory.createOrganisation('roles-lean');
      const leanManager = await factory.createInternalManager(lean, { permissions: ['role.view', 'role.manage', 'staff.view'], label: 'lean' });
      const leanToken = await factory.login(leanManager);
      const escalate = await createRole(leanToken, 'Escalate', ['staff.view', 'venue.view']);
      expect(escalate.status).toBe(403);
      expect(escalate.body.code).toBe('ROLE_ESCALATION');
      expect((await createRole(leanToken, 'Fine', ['staff.view'])).status).toBe(201);
    });

    it('R4. system roles are read-only: neither their permissions nor their names can be changed', async () => {
      const roles = (await http().get('/rest/v1/roles').set(bearer(tokenA))).body as Array<{ id: string; key: string }>;
      const managerRole = roles.find((r) => r.key === 'manager')!;
      expect((await http().put(`/rest/v1/roles/${managerRole.id}`).set(bearer(tokenA)).send(definition('Manager', ['staff.view']))).status).toBe(409);
      expect((await http().put(`/rest/v1/roles/${managerRole.id}`).set(bearer(tokenA)).send(definition('Boss', []))).status).toBe(409);
      expect((await http().delete(`/rest/v1/roles/${managerRole.id}`).set(bearer(tokenA))).status).toBe(409);
      // The definition endpoint is readable but flags the role as not editable here.
      const def = await http().get(`/rest/v1/roles/${managerRole.id}/definition`).set(bearer(tokenA));
      expect(def.status).toBe(200);
      expect(def.body).toMatchObject({ isSystem: true, isMemberRole: false });
    });

    it('R5. roles require role.view / role.manage — Staff and a pure member are refused', async () => {
      const staffToken = await factory.login(staffA);
      expect([401, 403]).toContain((await http().get('/rest/v1/roles').set(bearer(staffToken))).status);
      const member = await onboardMember(tokenA, roleA.id);
      expect((await http().get('/rest/v1/roles').set(bearer(member.token))).status).toBe(403);
      expect((await createRole(member.token, 'Self-made', ['staff.view'])).status).toBe(403);
    });

    it('R6. PostgreSQL backstops: allowlist trigger, immutable identity, reserved key prefix, workspace-scoped RLS', async () => {
      await expect(
        runtime.transaction(async (m) => {
          await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [org.id, managerA.workspaceId, managerA.userId]);
          await m.query(`INSERT INTO core.role_permission (organisation_id, role_id, permission_id) SELECT $1, $2, id FROM core.permission WHERE key = 'manager.manage'`, [org.id, roleA.id]);
        }),
      ).rejects.toThrow(/cannot be granted to a workspace-member role/);
      await expect(owner.query(`UPDATE core.role SET workspace_id = $2 WHERE id = $1`, [roleA.id, managerB.workspaceId])).rejects.toThrow(/immutable/);
      await expect(owner.query(`UPDATE core.role SET key = 'manager_x' WHERE id = $1`, [roleA.id])).rejects.toThrow(/immutable/);
      await expect(owner.query(`INSERT INTO core.role (organisation_id, key, name, is_system) VALUES ($1, 'custom_fake', 'Fake', true)`, [org.id])).rejects.toThrow(/role_member_key|role_system/);
      await expect(owner.query(`INSERT INTO core.role (organisation_id, workspace_id, key, name) VALUES ($1, $2, 'manager_lookalike', 'X')`, [org.id, managerA.workspaceId])).rejects.toThrow(/role_member_key/);
      const seenFromB = await runtime.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [org.id, managerB.workspaceId]);
        return m.query(`SELECT count(*)::int AS c FROM core.role WHERE id = $1`, [roleA.id]);
      });
      expect(seenFromB).toEqual([{ c: 0 }]);
      expect(await runtime.query(`SELECT count(*)::int AS c FROM core.role`)).toEqual([{ c: 0 }]);
    });
  });

  // ─────────────────────────────────────────────── Invite: who and which roles

  describe('Invite authority and assignable roles', () => {
    it('I1. assignable roles are only the caller’s own workspace’s custom roles — never Staff, Venue Manager, Manager or CEO', async () => {
      const a = await http().get('/rest/v1/member-invitations/assignable-roles').set(bearer(tokenA));
      expect(a.status).toBe(200);
      const ids = a.body.map((r: { id: string }) => r.id);
      expect(ids).toContain(roleA.id);
      expect(ids).not.toContain(roleB.id);
      const keys = await owner.query(`SELECT key FROM core.role WHERE id = ANY($1::uuid[])`, [ids]);
      expect(keys.every((k: { key: string }) => k.key.startsWith('custom_'))).toBe(true);
    });

    it('I2. a system role, another workspace’s role or the old role-key API is refused; names and injected authority are 400', async () => {
      const systemRoles = await owner.query(`SELECT id, key FROM core.role WHERE organisation_id = $1 AND is_system`, [org.id]);
      expect(systemRoles.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['manager', 'ceo', 'staff', 'venue_manager']));
      for (const r of systemRoles) expect((await send(tokenA, { emails: [email()], roleId: r.id })).status).toBe(404);
      expect((await send(tokenA, { emails: [email()], roleId: roleB.id })).status).toBe(404);
      expect((await send(tokenA, { emails: [email()], roleId: randomUUID() })).status).toBe(404);
      for (const role of ['staff', 'venue_manager', 'manager', 'ceo']) expect((await send(tokenA, { emails: [email()], role })).status).toBe(400);
      for (const extra of [{ firstName: 'A' }, { lastName: 'B' }, { organisationId: org.id }, { workspaceId: managerB.workspaceId }, { managerId: managerB.userId }]) {
        expect((await send(tokenA, { emails: [email()], roleId: roleA.id, ...extra })).status).toBe(400);
      }
    });

    it('I3. Staff, Venue Managers and pure members cannot use the invitation API (403)', async () => {
      const staffToken = await factory.login(staffA);
      const vmToken = await factory.login(venueManagerA);
      const member = await onboardMember(tokenA, roleA.id);
      for (const t of [staffToken, vmToken, member.token]) {
        expect([401, 403]).toContain((await send(t, { emails: [email()], roleId: roleA.id })).status);
        expect([401, 403]).toContain((await list(t)).status);
      }
    });

    it('I4. the Initial Manager can invite into their own workspace; Manager B cannot list, resend or revoke it (404)', async () => {
      const { id } = await inviteOne(tokenA, roleA.id);
      const bList = await list(tokenB, '?limit=100');
      expect(bList.status).toBe(200);
      expect(bList.body.data.map((i: { id: string }) => i.id)).not.toContain(id);
      expect((await resend(tokenB, id)).status).toBe(404);
      expect((await revoke(tokenB, id)).status).toBe(404);
      expect((await revoke(tokenB, 'not-a-uuid')).status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────── Invite: sending

  describe('Sending', () => {
    it('S1. invites by email alone — no names, no account; a pending invitation and a durable email bound to the inviter’s workspace', async () => {
      const address = email();
      const res = await send(tokenA, { emails: [address], roleId: roleA.id });
      expect(res.status).toBe(200);
      expect(res.body.results[0]).toMatchObject({ email: address, outcome: 'invited', invitation: { role: { id: roleA.id, name: 'Supervisor' }, status: 'queued', sendCount: 1 } });
      expect(JSON.stringify(res.body)).not.toMatch(/token/i);
      expect(await owner.query(`SELECT 1 FROM core."user" WHERE email = $1`, [address])).toHaveLength(0);
      const inv = await invitationByEmail(address);
      expect(inv).toMatchObject({ organisation_id: org.id, workspace_id: managerA.workspaceId, role_id: roleA.id, invited_by: managerA.userId, accepted_at: null });
      const [outbox] = await owner.query(`SELECT job_type, target_user_id, workspace_id FROM core.email_outbox WHERE member_invitation_id = $1`, [inv.id]);
      expect(outbox).toMatchObject({ job_type: 'MEMBER_INVITATION', target_user_id: null, workspace_id: managerA.workspaceId });
      expect(inv.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(inv.token_hash).not.toBe(await tokenFromEmail(inv.id));
    });

    it('S2. normalises, de-duplicates and reports invalid addresses per recipient', async () => {
      const base = email('mixed');
      const res = await send(tokenA, { emails: [`  ${base.toUpperCase()} `, base, 'not-an-email', ''], roleId: roleA.id });
      expect(res.body.results).toEqual(
        expect.arrayContaining([expect.objectContaining({ email: base, outcome: 'invited' }), expect.objectContaining({ email: 'not-an-email', outcome: 'invalid_email' })]),
      );
      expect(await owner.query(`SELECT 1 FROM core.member_invitation WHERE email = $1`, [base])).toHaveLength(1);
    });

    it('S3. concurrent duplicate sends create exactly one live invitation', async () => {
      const address = email('race');
      const results = await Promise.all([1, 2, 3, 4].map(() => send(tokenA, { emails: [address], roleId: roleA.id })));
      const outcomes = results.map((r) => r.body.results?.[0]?.outcome);
      expect(outcomes.filter((o) => o === 'invited')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'already_invited')).toHaveLength(3);
    });

    it('S4. an existing account is reported (already_member); another workspace’s invitation is not disclosed (unavailable)', async () => {
      expect((await send(tokenA, { emails: [staffA.email], roleId: roleA.id })).body.results[0]).toMatchObject({ outcome: 'already_member' });
      const { address } = await inviteOne(tokenA, roleA.id);
      expect((await send(tokenB, { emails: [address], roleId: roleB.id })).body.results[0]).toMatchObject({ email: address, outcome: 'unavailable' });
    });

    it('S5. the pending list paginates, filters by status/email and never exposes tokens or hashes', async () => {
      const isolated = await factory.createInternalManager(org, { permissions: 'production', label: 'pager' });
      const t = await factory.login(isolated);
      const role = (await createRole(t, 'Pager role', ['staff.view'])).body;
      await send(t, { emails: [email('p1'), email('p2'), email('findme')], roleId: role.id });
      const p1 = await list(t, '?limit=2&page=1');
      const p2 = await list(t, '?limit=2&page=2');
      expect(p1.body).toMatchObject({ total: 3, page: 1, limit: 2 });
      expect(new Set([...p1.body.data, ...p2.body.data].map((i: { id: string }) => i.id)).size).toBe(3);
      expect((await list(t, '?q=findme')).body.data).toHaveLength(1);
      expect((await list(t, '?status=queued')).body.total).toBe(3);
      expect((await list(t, '?status=sent')).body.total).toBe(0);
      expect(JSON.stringify(p1.body)).not.toMatch(/token|hash/i);
    });
  });

  // ─────────────────────────────────────────────── Acceptance

  describe('Acceptance', () => {
    it('A1. the recipient sets their own name and password and joins the INVITER’s workspace — no profile, no new workspace', async () => {
      const { address, raw } = await inviteOne(tokenA, roleA.id);
      const looked = await resolve(raw);
      expect(looked.body).toMatchObject({ email: address, roleLabel: 'Supervisor' });
      const res = await accept({ token: raw, firstName: '  Ada ', lastName: 'Lovelace', newPassword: STRONG });
      expect(res.status).toBe(200);
      expect(res.body.applicationTarget).toBe('manager_web');

      const [user] = await owner.query(`SELECT id, first_name, last_name, status FROM core."user" WHERE email = $1`, [address]);
      expect(user).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace', status: 'invited' });
      expect(await owner.query(`SELECT workspace_id FROM core.workspace_membership WHERE user_id = $1 AND status = 'active'`, [user.id])).toEqual([{ workspace_id: managerA.workspaceId }]);
      expect(await owner.query(`SELECT r.id FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = $1`, [user.id])).toEqual([{ id: roleA.id }]);
      expect(await owner.query(`SELECT 1 FROM core.staff_profile WHERE user_id = $1`, [user.id])).toHaveLength(0);
      expect(await owner.query(`SELECT 1 FROM core.manager_profile WHERE user_id = $1`, [user.id])).toHaveLength(0);
      expect(await owner.query(`SELECT 1 FROM core.manager_workspace WHERE owner_user_id = $1`, [user.id])).toHaveLength(0);

      // Web console only; the first login activates the account through the unchanged machinery.
      expect((await factory.loginRaw({ kind: 'internal_manager', email: address, password: STRONG }, { applicationTarget: 'staff_app' })).status).toBe(403);
      expect((await factory.loginRaw({ kind: 'internal_manager', email: address, password: STRONG }, { applicationTarget: 'venue_manager_app' })).status).toBe(403);
      expect((await factory.loginRaw({ kind: 'internal_manager', email: address, password: STRONG })).status).toBe(200);
      expect((await owner.query(`SELECT status FROM core."user" WHERE id = $1`, [user.id]))[0].status).toBe('active');
    });

    it('A2. a token is single-use; simultaneous acceptances create exactly one account and one membership', async () => {
      const { address, raw } = await inviteOne(tokenA, roleA.id);
      const both = await Promise.all([1, 2].map((n) => accept({ token: raw, firstName: `Racer${n}`, lastName: 'Test', newPassword: STRONG })));
      expect(both.map((r) => r.status).sort()).toEqual([200, 400]);
      const users = await owner.query(`SELECT id FROM core."user" WHERE email = $1`, [address]);
      expect(users).toHaveLength(1);
      expect(await owner.query(`SELECT 1 FROM core.workspace_membership WHERE user_id = $1`, [users[0].id])).toHaveLength(1);
      expect((await accept({ token: raw, firstName: 'Late', lastName: 'Comer', newPassword: STRONG })).body.message).toBe(GENERIC);
    });

    it('A3. resend supersedes the old link and cancels its email; at most three sends; revoke kills the link', async () => {
      const first = await inviteOne(tokenA, roleA.id);
      expect((await resend(tokenA, first.id)).body).toMatchObject({ sendCount: 2 });
      const second = await tokenFromEmail(first.id);
      expect(second).not.toBe(first.raw);
      const statuses = await owner.query(`SELECT status FROM core.email_outbox WHERE member_invitation_id = $1 ORDER BY created_at`, [first.id]);
      expect(statuses[0].status).toBe('CANCELLED');
      expect((await accept({ token: first.raw, firstName: 'Old', lastName: 'Link', newPassword: STRONG })).body.message).toBe(GENERIC);
      expect((await resend(tokenA, first.id)).status).toBe(200);
      const fourth = await resend(tokenA, first.id);
      expect(fourth.status).toBe(409);
      expect(fourth.body.code).toBe('MAX_SENDS_REACHED');

      const revoked = await inviteOne(tokenA, roleA.id);
      expect((await revoke(tokenA, revoked.id)).status).toBe(200);
      expect((await accept({ token: revoked.raw, firstName: 'No', lastName: 'Way', newPassword: STRONG })).body.message).toBe(GENERIC);
      expect((await resolve(revoked.raw)).status).toBe(400);
    });

    it('A4. expired, unknown and malformed tokens get the same generic answer', async () => {
      const { id, raw } = await inviteOne(tokenA, roleA.id);
      await owner.query(`UPDATE core.member_invitation SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
      expect((await list(tokenA, '?limit=100')).body.data.find((i: { id: string }) => i.id === id)).toMatchObject({ status: 'expired' });
      for (const a of await Promise.all([
        accept({ token: raw, firstName: 'Too', lastName: 'Late', newPassword: STRONG }),
        accept({ token: 'x'.repeat(43), firstName: 'Un', lastName: 'Known', newPassword: STRONG }),
        resolve('y'.repeat(43)),
      ])) {
        expect(a.status).toBe(400);
        expect(a.body.message).toBe(GENERIC);
      }
    });

    it('A5. role assignment is re-checked at redemption: an inviter who can no longer grant the role cannot have it honoured', async () => {
      const inviter = await factory.createInternalManager(org, { permissions: 'production', label: 'recheck' });
      const t = await factory.login(inviter);
      const role = (await createRole(t, 'Venue viewer', ['venue.view'])).body;
      const { address, raw } = await inviteOne(t, role.id);
      // The inviter loses venue.view (a per-user revoke) — the role now grants more than they hold.
      await owner.query(
        `INSERT INTO core.user_permission_override (organisation_id, user_id, permission_id, effect) SELECT $1, $2, id, 'revoke' FROM core.permission WHERE key = 'venue.view'`,
        [org.id, inviter.userId],
      );
      const res = await accept({ token: raw, firstName: 'No', lastName: 'Escalation', newPassword: STRONG });
      expect(res.body.message).toBe(GENERIC);
      expect(await owner.query(`SELECT 1 FROM core."user" WHERE email = $1`, [address])).toHaveLength(0);
      expect((await invitationByEmail(address)).superseded_at).not.toBeNull();
    });

    it('A6. an inviter who loses role.manage, or is suspended, before acceptance cannot have the invitation honoured', async () => {
      const inviter = await factory.createInternalManager(org, { permissions: 'production', label: 'losing' });
      const t = await factory.login(inviter);
      const role = (await createRole(t, 'Lose', ['staff.view'])).body;
      const lost = await inviteOne(t, role.id);
      const suspended = await inviteOne(t, role.id);
      await owner.query(
        `INSERT INTO core.user_permission_override (organisation_id, user_id, permission_id, effect) SELECT $1, $2, id, 'revoke' FROM core.permission WHERE key = 'role.manage'`,
        [org.id, inviter.userId],
      );
      expect((await accept({ token: lost.raw, firstName: 'No', lastName: 'Authority', newPassword: STRONG })).body.message).toBe(GENERIC);
      await owner.query(`DELETE FROM core.user_permission_override WHERE user_id = $1`, [inviter.userId]);
      await owner.query(`UPDATE core."user" SET status = 'suspended' WHERE id = $1`, [inviter.userId]);
      expect((await accept({ token: suspended.raw, firstName: 'No', lastName: 'Authority', newPassword: STRONG })).body.message).toBe(GENERIC);
      for (const a of [lost.address, suspended.address]) {
        expect(await owner.query(`SELECT 1 FROM core."user" WHERE email = $1`, [a])).toHaveLength(0);
        expect((await invitationByEmail(a)).superseded_at).not.toBeNull();
      }
    });

    it('A7. weak passwords and blank names are refused without consuming the invitation; a pre-existing account supersedes it', async () => {
      const { raw, address } = await inviteOne(tokenA, roleA.id);
      expect((await accept({ token: raw, firstName: '   ', lastName: 'X', newPassword: STRONG })).status).toBe(400);
      expect((await accept({ token: raw, firstName: 'Weak', lastName: 'Password', newPassword: 'short' })).status).toBe(400);
      expect(await owner.query(`SELECT 1 FROM core."user" WHERE email = $1`, [address])).toHaveLength(0);
      expect((await accept({ token: raw, firstName: 'Strong', lastName: 'Password', newPassword: STRONG })).status).toBe(200);

      const other = await inviteOne(tokenA, roleA.id);
      expect((await http().post('/rest/v1/staff').set(bearer(tokenA)).send({ email: other.address, firstName: 'Other', lastName: 'Path' })).status).toBe(201);
      expect((await accept({ token: other.raw, firstName: 'Second', lastName: 'Identity', newPassword: STRONG })).body.message).toBe(GENERIC);
      expect(await owner.query(`SELECT 1 FROM core."user" WHERE email = $1`, [other.address])).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────── Member access (creator-based ownership preserved)

  describe('Member access', () => {
    it('M1. a member reads ONLY their workspace owner’s Staff, Venues and Shifts — never Manager B’s (404/absent)', async () => {
      const member = await onboardMember(tokenA, roleA.id);
      const staff = await http().get('/rest/v1/staff?limit=100').set(bearer(member.token));
      expect(staff.status).toBe(200);
      const staffIds = staff.body.data.map((s: { id: string }) => s.id);
      expect(staffIds).toContain(staffA.profileId);
      expect(staffIds).not.toContain(staffB.profileId);
      expect((await http().get(`/rest/v1/staff/${staffB.profileId}`).set(bearer(member.token))).status).toBe(404);
      expect((await http().get(`/rest/v1/staff/${staffA.profileId}`).set(bearer(member.token))).status).toBe(200);

      const venues = await http().get('/rest/v1/venues').set(bearer(member.token));
      expect(venues.status).toBe(200);
      expect(venues.body.data.map((v: { id: string }) => v.id)).toContain(venueA);
      expect(venues.body.data.map((v: { id: string }) => v.id)).not.toContain(venueB);
      expect((await http().get(`/rest/v1/venues/${venueB}`).set(bearer(member.token))).status).toBe(404);
      expect((await http().get('/rest/v1/shifts').set(bearer(member.token))).status).toBe(200);

      // Dashboard counters reflect the owner's records for a member — never a misleading zero.
      const ownerSummary = await http().get('/rest/v1/dashboard/summary').set(bearer(tokenA));
      const memberSummary = await http().get('/rest/v1/dashboard/summary').set(bearer(member.token));
      expect(memberSummary.status).toBe(200);
      expect(memberSummary.body).toMatchObject({ staffCount: ownerSummary.body.staffCount, venueCount: ownerSummary.body.venueCount, managerCount: null });
      expect(memberSummary.body.staffCount).toBeGreaterThan(0);
    });

    it('M2. a member must pass BOTH their permission and the record policy: no flag ⇒ 403, no write flags at all', async () => {
      const venueOnly = (await createRole(tokenA, 'Venue only', ['venue.view'])).body;
      const member = await onboardMember(tokenA, venueOnly.id);
      expect((await http().get('/rest/v1/staff').set(bearer(member.token))).status).toBe(403);
      expect((await http().get('/rest/v1/venues').set(bearer(member.token))).status).toBe(200);
      expect((await http().post('/rest/v1/venues').set(bearer(member.token)).send({ name: 'Nope', type: 'hotel' })).status).toBe(403);
      expect((await http().post('/rest/v1/staff').set(bearer(member.token)).send({ email: email(), firstName: 'N', lastName: 'O' })).status).toBe(403);
    });

    it('M3. RLS: the member branch on staff_profile needs a custom role of THAT workspace granting staff.view', async () => {
      const member = await onboardMember(tokenA, roleA.id);
      const asUser = (userId: string, workspaceId: string) =>
        runtime.transaction(async (m) => {
          await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [org.id, workspaceId, userId]);
          return m.query(`SELECT user_id FROM core.staff_profile`);
        });
      expect((await asUser(member.userId, managerA.workspaceId!)).map((r: { user_id: string }) => r.user_id)).toContain(staffA.userId);
      expect(await asUser(member.userId, managerB.workspaceId!)).toEqual([]); // even if a GUC pointed elsewhere
      const vmBranch = await runtime.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [org.id, managerA.workspaceId, venueManagerA.userId]);
        return m.query(`SELECT core.member_holds_workspace_permission($1, 'staff.view') AS ok`, [managerA.workspaceId]);
      });
      expect(vmBranch).toEqual([{ ok: false }]); // a Venue Manager's system role never satisfies the member branch
    });

    it('M4. a member whose workspace membership is suspended cannot sign in at all', async () => {
      const member = await onboardMember(tokenA, roleA.id);
      await owner.query(`UPDATE core.workspace_membership SET status = 'suspended', security_version = security_version + 1 WHERE user_id = $1`, [member.userId]);
      const res = await factory.loginRaw({ kind: 'internal_manager', email: member.address, password: STRONG });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('APPLICATION_ACCESS_DENIED');
    });
  });

  // ─────────────────────────────────────────────── Team

  describe('Team', () => {
    it('T1. lists the workspace’s real members (owner + invited members) and excludes recruitment Staff and Venue Managers', async () => {
      const member = await onboardMember(tokenA, roleA.id);
      const res = await team(tokenA, '?limit=100');
      expect(res.status).toBe(200);
      const ids = res.body.data.map((m: { userId: string }) => m.userId);
      expect(ids).toEqual(expect.arrayContaining([managerA.userId, member.userId]));
      expect(ids).not.toContain(staffA.userId);
      expect(ids).not.toContain(venueManagerA.userId);
      expect(ids).not.toContain(managerB.userId);
      expect(res.body.data[0]).toMatchObject({ userId: managerA.userId, isOwner: true });
      expect(res.body.data.find((m: { userId: string }) => m.userId === member.userId)).toMatchObject({ status: 'active', roles: [{ id: roleA.id, isMemberRole: true }] });
      expect((await team(tokenB, '?limit=100')).body.data.map((m: { userId: string }) => m.userId)).not.toContain(member.userId);
    });

    it('T2. search and pagination are server-side; members, Staff and Venue Managers cannot list Team', async () => {
      const member = await onboardMember(tokenA, roleA.id);
      expect((await team(tokenA, `?search=${encodeURIComponent(member.address)}`)).body).toMatchObject({ total: 1 });
      expect((await team(tokenA, '?limit=1&page=1')).body.data).toHaveLength(1);
      for (const t of [member.token, await factory.login(staffA), await factory.login(venueManagerA)]) {
        expect([401, 403]).toContain((await team(t)).status);
      }
    });
  });

  // ─────────────────────────────────────────────── Add (leadership onboarding)

  describe('Add — leadership onboarding', () => {
    it('L1. the Initial Manager cannot reach any Add action, including by direct API request', async () => {
      expect((await http().post('/rest/v1/managers/initial-manager-invite').set(bearer(tokenA)).send({ email: email(), firstName: 'I', lastName: 'M' })).status).toBe(403);
      expect((await http().post('/rest/v1/managers/initial-manager-invite/replace').set(bearer(tokenA)).send({ email: email(), firstName: 'I', lastName: 'M' })).status).toBe(403);
      expect((await http().get('/rest/v1/admin/organisations').set(bearer(tokenA))).status).toBe(403);
      expect((await http().post('/rest/v1/admin/organisations').set(bearer(tokenA)).send({ name: 'Rogue', ceoEmail: email(), ceoFirstName: 'R', ceoLastName: 'O' })).status).toBe(403);
    });

    it('L2. a CEO cannot create organisations or select other organisations', async () => {
      expect((await http().get('/rest/v1/admin/organisations').set(bearer(tokenCeo))).status).toBe(403);
      expect((await http().post('/rest/v1/admin/organisations').set(bearer(tokenCeo)).send({ name: 'Rogue', ceoEmail: email(), ceoFirstName: 'R', ceoLastName: 'O' })).status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────── audit, RLS, suspension, Redis

  it('X1. audit entries never carry the token or its hash', async () => {
    const { id, raw } = await inviteOne(tokenA, roleA.id);
    const rows = await owner.query(`SELECT metadata FROM core.audit_log WHERE entity_id = $1`, [id]);
    expect(rows.length).toBeGreaterThan(0);
    const [inv] = await owner.query(`SELECT token_hash FROM core.member_invitation WHERE id = $1`, [id]);
    for (const r of rows) {
      const text = JSON.stringify(r.metadata ?? {});
      expect(text).not.toContain(raw);
      expect(text).not.toContain(inv.token_hash);
    }
  });

  it('X2. RLS: no context, another organisation and another workspace all see zero invitations; history cannot be deleted', async () => {
    await inviteOne(tokenA, roleA.id);
    expect(await runtime.query(`SELECT count(*)::int AS c FROM core.member_invitation`)).toEqual([{ c: 0 }]);
    const otherOrg = await factory.createOrganisation('inv-other');
    const seen = await runtime.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true)`, [otherOrg.id]);
      return m.query(`SELECT count(*)::int AS c FROM core.member_invitation`);
    });
    expect(seen).toEqual([{ c: 0 }]);
    const bWorkspace = await runtime.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [org.id, managerB.workspaceId]);
      return m.query(`SELECT count(*)::int AS c FROM core.member_invitation WHERE workspace_id = $1`, [managerA.workspaceId]);
    });
    expect(bWorkspace).toEqual([{ c: 0 }]);
    await expect(runtime.query(`DELETE FROM core.member_invitation`)).rejects.toThrow(/permission denied/);
  });

  it('X3. a suspended organisation can neither send nor redeem invitations', async () => {
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'susp' });
    const m = seeded.managers[0]!;
    const t = await factory.login(m);
    const role = (await createRole(t, 'Susp', ['staff.view'])).body;
    const { raw } = await inviteOne(t, role.id);
    await owner.query(`UPDATE core.organisation SET suspended_at = now(), suspended_by = $2 WHERE id = $1`, [seeded.organisation.id, m.userId]);
    expect([401, 403]).toContain((await send(t, { emails: [email()], roleId: role.id })).status);
    expect((await accept({ token: raw, firstName: 'Sus', lastName: 'Pended', newPassword: STRONG })).body.message).toBe(GENERIC);
  });

  it('X4. token buckets are atomic across concurrent callers and namespaced with hashed identifiers', async () => {
    const limiter = app.get(InvitationRateLimitService);
    const id = `bucket-${randomUUID()}`;
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume([{ scope: 'test', identifier: id, capacity: 5, windowMs: 60_000, cost: 1 }])),
    );
    expect(decisions.filter((d) => d.admitted)).toHaveLength(5);
    expect(limiter.keyFor('recipient', 'Someone@Example.test')).toMatch(/^crewflow:test:invite-rate:recipient:[0-9a-f]{64}$/);
    const a = `a-${randomUUID()}`;
    const b = `b-${randomUUID()}`;
    const denied = await limiter.consume([
      { scope: 'test', identifier: a, capacity: 10, windowMs: 60_000, cost: 1 },
      { scope: 'test', identifier: b, capacity: 1, windowMs: 60_000, cost: 2 },
    ]);
    expect(denied).toMatchObject({ admitted: false, scope: 'test' });
    expect((await limiter.consume([{ scope: 'test', identifier: a, capacity: 10, windowMs: 60_000, cost: 10 }])).admitted).toBe(true);
  });

  it('X5. a Redis outage fails closed, fast — never unlimited invitations, never a hang, never authority', async () => {
    const env = app.get(EnvironmentService);
    const deadEnv = { get: (key: string) => (key === 'REDIS_URL' ? 'redis://127.0.0.1:1/0' : env.get(key as never)) } as unknown as EnvironmentService;
    const deadClient = new AuthCacheRedisClientProvider(deadEnv);
    const limiter = new InvitationRateLimitService(deadClient, env);
    const started = Date.now();
    await expect(limiter.assertCanSend({ actorUserId: randomUUID(), organisationId: randomUUID(), recipientEmails: ['x@example.test'] })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(Date.now() - started).toBeLessThan(3000);
    deadClient.client.disconnect();
  });
});
