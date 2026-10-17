import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { PasswordResetTokenPurpose } from '@rab/shared';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * CF-04 (October 15 audit): changing another user's sign-in email followed by a password reset was an account takeover:
 * the email changed immediately, the reset link went to the new address, the victim's sessions stayed alive and the old
 * owner was never told. Now an ACTIVE account's change is a verified, step-up-protected pending change. Real PostgreSQL
 * with RLS, real HTTP; the confirmation token is read from the outbox exactly as the mail driver would deliver it.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('CF-04 email change cannot take over an account (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let manager: TestIdentity;
  let managerToken: string;
  let organisationId: string;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const freshEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const userRow = async (userId: string) =>
    (await owner.query(`SELECT email, security_version::int AS v FROM core."user" WHERE id = $1`, [userId]))[0] as { email: string; v: number };
  const tokenSentTo = async (email: string): Promise<string> => {
    const [row] = await owner.query(
      `SELECT rendered_text FROM core.email_outbox WHERE recipient_email = $1 AND rendered_text LIKE '%confirm-email-change?token=%' ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    return /token=([0-9a-f]{64})/.exec(row.rendered_text)![1]!;
  };
  const confirm = (token: string) => http().post('/rest/v1/email-change/confirm').send({ token });
  const newStaff = (label: string) => factory.createStaff({ id: organisationId } as never, { owner: manager, label });
  const changeStaffEmail = (staff: TestIdentity, email: string, currentPassword?: string) =>
    http().patch(`/rest/v1/staff/${staff.profileId}/email`).set(as(managerToken)).send({ email, ...(currentPassword !== undefined ? { currentPassword } : {}) });

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
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'cf04' });
    manager = seeded.managers[0]!;
    organisationId = seeded.organisation.id;
    managerToken = await factory.login(manager);
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('without step-up, or with a wrong password, nothing happens (403)', async () => {
    const staff = await newStaff('cf04a');
    const before = await userRow(staff.userId);
    const none = await changeStaffEmail(staff, freshEmail('attacker'));
    expect(none.status).toBe(403);
    expect(none.body.code).toBe('STEP_UP_REQUIRED');
    expect((await changeStaffEmail(staff, freshEmail('attacker'), 'wrong-password')).status).toBe(403);
    expect(await userRow(staff.userId)).toEqual(before);
  });

  it('the takeover chain is broken: the change is only pending, the old owner is told, and a reset to the new address does nothing', async () => {
    const staff = await newStaff('cf04b');
    const staffToken = await factory.login(staff);
    const before = await userRow(staff.userId);
    const attacker = freshEmail('attacker');

    const res = await changeStaffEmail(staff, attacker, manager.password);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'pending_verification', email: before.email });
    expect(await userRow(staff.userId)).toEqual(before); // old address stays authoritative

    // The old owner is notified, without the new address being disclosed to them.
    const [notice] = await owner.query(
      `SELECT rendered_text FROM core.email_outbox WHERE recipient_email = $1 AND rendered_subject LIKE 'A change to your Crewflow sign-in email%' ORDER BY created_at DESC LIMIT 1`,
      [before.email],
    );
    expect(notice).toBeDefined();
    expect(notice.rendered_text).not.toContain(attacker);

    // The attacker asks for a password reset at the new address: no reset token is issued for the victim.
    const tokensBefore = (await owner.query(`SELECT count(*)::int AS n FROM core.password_reset_token WHERE user_id = $1`, [staff.userId]))[0].n;
    await http().post('/rest/v1/auth/forgot-password').set('x-client-platform', 'mobile').send({ email: attacker });
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.password_reset_token WHERE user_id = $1`, [staff.userId]))[0].n).toBe(tokensBefore);

    // The victim's own session is untouched while the change is pending.
    expect((await http().get('/rest/v1/auth/me').set(as(staffToken))).status).toBe(200);
  });

  it('confirmation by the new address applies atomically: email changes, every session ends, version bumps, provider links and reset tokens are voided', async () => {
    const staff = await newStaff('cf04c');
    const staffToken = await factory.login(staff);
    const before = await userRow(staff.userId);
    const target = freshEmail('verified');
    await owner.query(
      `INSERT INTO core.user_auth_identity (organisation_id, user_id, provider, provider_subject, verified_email_snapshot) VALUES ($1, $2, 'google', $3, $4)`,
      [organisationId, staff.userId, `sub-${randomUUID()}`, before.email],
    );
    await owner.query(
      `INSERT INTO core.password_reset_token (organisation_id, user_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [organisationId, staff.userId, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), PasswordResetTokenPurpose.FORGOT_PASSWORD],
    );

    expect((await changeStaffEmail(staff, target, manager.password)).status).toBe(200);
    const done = await confirm(await tokenSentTo(target));
    expect(done.status).toBe(200);

    const after = await userRow(staff.userId);
    expect(after.email).toBe(target);
    expect(after.v).toBe(before.v + 1);
    expect((await http().get('/rest/v1/auth/me').set(as(staffToken))).status).toBe(401);
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.user_auth_identity WHERE user_id = $1`, [staff.userId]))[0].n).toBe(0);
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.password_reset_token WHERE user_id = $1 AND used_at IS NULL`, [staff.userId]))[0].n).toBe(0);
    const [completed] = await owner.query(
      `SELECT 1 FROM core.email_outbox WHERE recipient_email = $1 AND rendered_subject = 'Your Crewflow sign-in email was changed'`,
      [before.email],
    );
    expect(completed).toBeDefined();
    // The account now signs in with the new address.
    expect((await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: target, password: staff.password })).status).toBe(200);
  });

  it('a token is single-use, expires, and a newer request supersedes an older one', async () => {
    const staff = await newStaff('cf04d');
    const first = freshEmail('first');
    await changeStaffEmail(staff, first, manager.password);
    const firstToken = await tokenSentTo(first);
    const second = freshEmail('second');
    await changeStaffEmail(staff, second, manager.password);
    expect((await confirm(firstToken)).status).toBe(400); // superseded
    const secondToken = await tokenSentTo(second);
    expect((await confirm(secondToken)).status).toBe(200);
    expect((await confirm(secondToken)).status).toBe(400); // single use

    const staff2 = await newStaff('cf04e');
    const third = freshEmail('third');
    await changeStaffEmail(staff2, third, manager.password);
    await owner.query(
      `UPDATE core.email_change_request SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE user_id = $1 AND confirmed_at IS NULL AND cancelled_at IS NULL`,
      [staff2.userId],
    );
    expect((await confirm(await tokenSentTo(third))).status).toBe(400);
    expect((await userRow(staff2.userId)).email).not.toBe(third);
    expect((await confirm('f'.repeat(64))).status).toBe(400);
    expect((await confirm('not-a-token')).status).toBe(400);
  });

  it('an address taken between request and confirmation cancels the change (no duplicate, nothing applied)', async () => {
    const staff = await newStaff('cf04f');
    const contested = freshEmail('contested');
    await changeStaffEmail(staff, contested, manager.password);
    const token = await tokenSentTo(contested);
    await owner.query(`UPDATE core."user" SET email = $2 WHERE id = (SELECT user_id FROM core.staff_profile WHERE id = $1)`, [
      (await newStaff('cf04g')).profileId,
      contested,
    ]);
    expect((await confirm(token)).status).toBe(400);
    expect((await userRow(staff.userId)).email).not.toBe(contested);
    const [req] = await owner.query(`SELECT cancel_reason FROM core.email_change_request WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [staff.userId]);
    expect(req.cancel_reason).toBe('email_unavailable');
  });

  it('a platform administrator’s email cannot be changed through this path (403 PROTECTED_ACCOUNT)', async () => {
    const ceo = await factory.createCeo({ id: organisationId } as never, { permissions: 'production' });
    const ceoToken = await factory.login(ceo);
    const target = await factory.createInternalManager({ id: organisationId } as never, { permissions: 'production', platformAdmin: true, label: 'cf04pa' });
    const res = await http().patch(`/rest/v1/managers/${target.profileId}/email`).set(as(ceoToken)).send({ email: freshEmail('pa'), currentPassword: ceo.password });
    expect(res.status).toBe(403);
    expect(await userRow(target.userId)).toMatchObject({ email: target.email });
  });

  it('an actor who signs in without a password cannot step up (403 STEP_UP_UNAVAILABLE, nothing invented)', async () => {
    const actor = await factory.createInternalManager({ id: organisationId } as never, { permissions: 'production', label: 'cf04oauth' });
    const token = await factory.login(actor);
    await owner.query(`UPDATE core."user" SET password_hash = NULL WHERE id = $1`, [actor.userId]);
    const staff = await factory.createStaff({ id: organisationId } as never, { owner: actor, label: 'cf04h' });
    const res = await http().patch(`/rest/v1/staff/${staff.profileId}/email`).set(as(token)).send({ email: freshEmail('x'), currentPassword: 'anything' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STEP_UP_UNAVAILABLE');
  });

  it('a never-activated (invited) account keeps the direct typo correction, and the confirm endpoint refuses forged browser requests', async () => {
    const pendingEmail = freshEmail('pending');
    const created = await http().post('/rest/v1/staff').set(as(managerToken)).send({ email: pendingEmail, firstName: 'Pending', lastName: 'Person' });
    expect(created.status).toBe(201);
    const corrected = freshEmail('corrected');
    const res = await http().patch(`/rest/v1/staff/${created.body.id}/email`).set(as(managerToken)).send({ email: corrected });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: corrected });

    const forged = await http().post('/rest/v1/email-change/confirm').set('Origin', 'https://evil.example').send({ token: 'f'.repeat(64) });
    expect(forged.status).toBe(403);
  });
});
