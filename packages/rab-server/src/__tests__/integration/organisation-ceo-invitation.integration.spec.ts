import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ManagerType } from '@rab/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { OrganisationOnboardingService } from '../../modules/manager/services/organisation-onboarding.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Owner correction 2026-10-23 — organisation creation through Settings → Members → Add: the platform administrator
 * supplies ONLY the CEO's email; the CEO accepts with their own first name, last name, organisation name and password;
 * the organisation exists only after that. Real HTTP, real Postgres + RLS, the real outbox (the raw token is read from
 * the pending outbox row, as the worker would render it — a local sink, never a real send).
 *
 * Covers the brief's tests 4–9, 15–18 at the API level (UI and workspace onboarding: E2E spec 01).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const PASSWORD = 'Ceo-Invite-Passw0rd!';

describeIfDb('CEO organisation invitation: email-only invite, CEO completes their own details (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let admin: TestIdentity;
  let adminToken: string;
  let tokens: Record<string, string> = {};
  let others: Record<string, TestIdentity> = {};

  const http = () => request(app.getHttpServer());
  const asAdmin = (r: request.Test) => r.set('Authorization', `Bearer ${adminToken}`);
  const email = (label: string) => `${label}-${randomUUID().slice(0, 8)}@ceo-invite.test`;
  const orgCount = async () => Number((await owner.query('SELECT count(*)::int AS n FROM core.organisation'))[0].n);

  /** The raw token from the newest outbox row for this recipient (body still present while the row is not terminal). */
  async function tokenFor(address: string): Promise<string> {
    const [row] = await owner.query(
      `SELECT rendered_text, rendered_html, job_type, organisation_invitation_id FROM core.email_outbox WHERE recipient_email = $1 ORDER BY created_at DESC LIMIT 1`,
      [address],
    );
    expect(row.job_type).toBe('ORGANISATION_INVITATION');
    expect(row.organisation_invitation_id).toBeTruthy();
    const match = /token=([A-Za-z0-9_-]{20,})/.exec(`${row.rendered_text ?? ''} ${row.rendered_html ?? ''}`);
    return decodeURIComponent(match![1]!);
  }

  const invite = (address: string, extra: Record<string, unknown> = {}) => asAdmin(http().post('/rest/v1/admin/organisation-invitations')).send({ email: address, ...extra });
  const accept = (token: string, body: Record<string, unknown> = {}) =>
    http().post('/rest/v1/invitations/accept').send({ token, firstName: 'Cleo', lastName: 'Example', organisationName: `Cleo Org ${randomUUID().slice(0, 6)}`, newPassword: PASSWORD, ...body });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    admin = await factory.createInternalManager(await factory.createOrganisation('ceoinv-platform'), { permissions: 'production', platformAdmin: true, label: 'ceoinv-admin' });
    adminToken = await factory.login(admin);
    const org = await factory.createOrganisation('ceoinv-tenant');
    others = {
      ceo: await factory.createInternalManager(org, { type: ManagerType.CEO, permissions: 'production', label: 'ceoinv-ceo' }),
      initialManager: await factory.createInternalManager(org, { permissions: 'production', workspace: true, label: 'ceoinv-im' }),
    };
    await owner.query('UPDATE core.manager_profile SET is_initial_manager = true WHERE id = $1', [others.initialManager.profileId]);
    others.venueManager = await factory.createVenueManager(org, { owner: others.initialManager });
    tokens = {};
    for (const [k, id] of Object.entries(others)) tokens[k] = await factory.login(id);
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('4/5: the admin form takes the CEO email ONLY — organisation/CEO name fields are refused (400), nothing is created', async () => {
    const before = await orgCount();
    for (const extra of [{ organisationName: 'X' }, { name: 'X' }, { ceoFirstName: 'A', ceoLastName: 'B' }, { organisationId: randomUUID() }, { role: 'manager' }]) {
      expect((await invite(email('extra'), extra)).status).toBe(400);
    }
    expect((await invite('not-an-email')).status).toBe(400);
    expect(await orgCount()).toBe(before);
  });

  it('6: sending creates a pending invitation and an outbox email — and NO organisation, user or placeholder name', async () => {
    const address = email('send');
    const before = await orgCount();
    const res = await invite(address);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: address, outcome: 'invited', invitation: { status: 'pending', sendCount: 1, maxSends: 3 } });
    expect(await orgCount()).toBe(before);
    expect((await owner.query('SELECT count(*)::int AS n FROM core."user" WHERE email = $1', [address]))[0].n).toBe(0);
    const [row] = await owner.query('SELECT organisation_id, status, target_user_id FROM core.email_outbox WHERE recipient_email = $1', [address]);
    expect(row).toMatchObject({ organisation_id: admin.organisationId, target_user_id: null });
    const audit = await owner.query(`SELECT actor_user_id FROM core.audit_log WHERE action = 'organisation_invitation.sent' AND organisation_id = $1 ORDER BY created_at DESC LIMIT 1`, [admin.organisationId]);
    expect(audit[0].actor_user_id).toBe(admin.userId);
    const list = await asAdmin(http().get('/rest/v1/admin/organisation-invitations'));
    expect(list.status).toBe(200);
    expect(list.body.data.find((i: { email: string }) => i.email === address)).toMatchObject({ status: 'pending' });
  });

  it('7: duplicates — a second invite for a pending address is "already_invited" (no second email); an existing account gets the generic 409', async () => {
    const address = email('dup');
    expect((await invite(address)).body.outcome).toBe('invited');
    expect((await invite(address.toUpperCase())).body.outcome).toBe('already_invited');
    expect((await owner.query('SELECT count(*)::int AS n FROM core.email_outbox WHERE recipient_email = $1', [address]))[0].n).toBe(1);
    // An existing account anywhere: the same generic refusal as every account-creation path (owner policy 2026-10-15).
    const existing = await invite(others.ceo!.email);
    expect(existing.status).toBe(409);
    expect(existing.body.code).toBe('EMAIL_UNAVAILABLE');
  });

  it('8/9: resend rotates the token (old link dead), at most 3 sends; revoke kills the link; an expired link is refused', async () => {
    const address = email('lifecycle');
    const sent = await invite(address);
    const id = sent.body.invitation.id as string;
    const first = await tokenFor(address);
    expect((await asAdmin(http().post(`/rest/v1/admin/organisation-invitations/${id}/resend`))).body.sendCount).toBe(2);
    const second = await tokenFor(address);
    expect(second).not.toBe(first);
    expect((await http().post('/rest/v1/invitations/resolve').send({ token: first })).status).toBe(400);
    expect((await http().post('/rest/v1/invitations/resolve').send({ token: second })).body).toMatchObject({ kind: 'organisation', email: address, roleLabel: 'CEO' });
    expect((await asAdmin(http().post(`/rest/v1/admin/organisation-invitations/${id}/resend`))).status).toBe(200);
    expect((await asAdmin(http().post(`/rest/v1/admin/organisation-invitations/${id}/resend`))).status).toBe(409); // 4th send
    const third = await tokenFor(address);
    expect((await asAdmin(http().post(`/rest/v1/admin/organisation-invitations/${id}/revoke`))).status).toBe(200);
    expect((await http().post('/rest/v1/invitations/resolve').send({ token: third })).status).toBe(400);
    expect((await accept(third)).status).toBe(400);
    expect((await asAdmin(http().post(`/rest/v1/admin/organisation-invitations/${randomUUID()}/revoke`))).status).toBe(404);
    expect((await asAdmin(http().post('/rest/v1/admin/organisation-invitations/not-a-uuid/revoke'))).status).toBe(404);

    const expiring = email('expired');
    await invite(expiring);
    const expiredToken = await tokenFor(expiring);
    await owner.query(`UPDATE core.organisation_invitation SET expires_at = now() - interval '1 minute' WHERE email = $1`, [expiring]);
    expect((await accept(expiredToken)).status).toBe(400);
    // After expiry, a fresh invitation can be sent (the expired one is superseded).
    expect((await invite(expiring)).body.outcome).toBe('invited');
  });

  it('10/11/6: the CEO accepts with their OWN names, organisation name and password; the organisation exists only now; replay refused', async () => {
    const address = email('accept');
    await invite(address);
    const token = await tokenFor(address);
    const before = await orgCount();
    const orgName = `Northwind Staffing ${randomUUID().slice(0, 6)}`;
    expect((await accept(token, { organisationName: undefined })).status).toBe(400); // organisation name required
    expect(await orgCount()).toBe(before);
    const res = await accept(token, { firstName: 'Nora', lastName: 'North', organisationName: orgName });
    expect(res.status).toBe(200);
    expect(res.body.applicationTarget).toBe('manager_web');
    expect(await orgCount()).toBe(before + 1);
    const [org] = await owner.query('SELECT id, name, slug FROM core.organisation WHERE name = $1', [orgName]);
    expect(org.slug).toMatch(/^northwind-staffing/);
    const [user] = await owner.query('SELECT id, first_name, last_name, organisation_id, password_hash IS NOT NULL AS has_pw FROM core."user" WHERE email = $1', [address]);
    expect(user).toMatchObject({ first_name: 'Nora', last_name: 'North', organisation_id: org.id, has_pw: true });
    const roles = await owner.query('SELECT r.key FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = $1', [user.id]);
    expect(roles.map((r: { key: string }) => r.key)).toEqual(['ceo']);
    const [profile] = await owner.query('SELECT type, workspace_id FROM core.manager_profile WHERE user_id = $1', [user.id]);
    expect(profile).toEqual({ type: 'ceo', workspace_id: null }); // no workspace is created for the CEO automatically
    const [inv] = await owner.query('SELECT accepted_organisation_id, accepted_user_id FROM core.organisation_invitation WHERE email = $1 AND accepted_at IS NOT NULL', [address]);
    expect(inv).toEqual({ accepted_organisation_id: org.id, accepted_user_id: user.id });
    const audits = await owner.query(`SELECT action, actor_user_id FROM core.audit_log WHERE organisation_id = $1 ORDER BY created_at`, [org.id]);
    expect(audits.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['organisation.created', 'manager.ceo_created', 'organisation_invitation.accepted']));
    // The CEO signs in with their own password (the account becomes ACTIVE at first sign-in, as for every invitation).
    const login = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: address, password: PASSWORD, applicationTarget: 'manager_web' });
    expect(login.status).toBe(200);
    // Replay: the same link never creates a second organisation.
    expect((await accept(token, { organisationName: `${orgName} again` })).status).toBe(400);
    expect(await orgCount()).toBe(before + 1);
  });

  it('race: two simultaneous acceptances of one link create exactly one organisation and one account', async () => {
    const address = email('race');
    await invite(address);
    const token = await tokenFor(address);
    const before = await orgCount();
    const [a, b] = await Promise.all([accept(token, { organisationName: 'Race One' }), accept(token, { organisationName: 'Race Two' })]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(await orgCount()).toBe(before + 1);
    expect((await owner.query('SELECT count(*)::int AS n FROM core."user" WHERE email = $1', [address]))[0].n).toBe(1);
  });

  it('the inviting administrator is re-verified at acceptance: revoked admin ⇒ the link no longer creates anything', async () => {
    const second = await factory.createInternalManager(await factory.createOrganisation('ceoinv-admin2'), { permissions: 'production', platformAdmin: true, label: 'ceoinv-admin2' });
    const secondToken = await factory.login(second);
    const address = email('reverify');
    await http().post('/rest/v1/admin/organisation-invitations').set('Authorization', `Bearer ${secondToken}`).send({ email: address });
    const token = await tokenFor(address);
    await owner.query('UPDATE core.platform_admin SET revoked_at = now() WHERE user_id = $1', [second.userId]);
    const before = await orgCount();
    expect((await accept(token)).status).toBe(400);
    expect(await orgCount()).toBe(before);
  });

  it('15/16: CEO, Initial Manager and Venue Manager cannot invite a CEO or create an organisation — 403 on the admin routes, the legacy create route is gone (404), the service refuses too', async () => {
    const before = await orgCount();
    for (const who of ['ceo', 'initialManager', 'venueManager']) {
      const auth = { Authorization: `Bearer ${tokens[who]}` };
      expect([who, (await http().post('/rest/v1/admin/organisation-invitations').set(auth).send({ email: email('rogue') })).status]).toEqual([who, 403]);
      expect([who, (await http().get('/rest/v1/admin/organisation-invitations').set(auth)).status]).toEqual([who, 403]);
      // The retired creation route does not exist for anyone (no handler: 404).
      expect([who, (await http().post('/rest/v1/admin/organisations').set(auth).send({ name: 'Rogue', ceoEmail: email('r'), ceoFirstName: 'R', ceoLastName: 'O' })).status]).toEqual([who, 404]);
    }
    // The retired creation route no longer exists, even for a platform administrator.
    expect((await asAdmin(http().post('/rest/v1/admin/organisations')).send({ name: 'Old', ceoEmail: email('old'), ceoFirstName: 'O', ceoLastName: 'D' })).status).toBe(404);
    // Layer 2: the service refuses a non-administrator called directly.
    await expect(app.get(OrganisationOnboardingService).inviteCeo({ ...others.ceo!, role: '', workspaceId: null } as never, email('svc'))).rejects.toThrow(/platform administrator/);
    expect(await orgCount()).toBe(before);
  });

  it('a workspace-member invitation link cannot be used to create an organisation (organisationName is refused there)', async () => {
    const res = await http().post('/rest/v1/invitations/accept').send({ token: randomUUID() + randomUUID(), firstName: 'A', lastName: 'B', organisationName: 'X', newPassword: PASSWORD });
    expect(res.status).toBe(400);
  });
});
