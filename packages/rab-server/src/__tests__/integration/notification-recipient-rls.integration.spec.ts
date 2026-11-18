import 'reflect-metadata';
import { NotificationType, NotificationTypeType } from '@rab/shared';
import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * SF-5 (NotificationRecipientRls1786721590000): `core.notification` is readable and updatable only by its recipient (plus
 * the server-set worker marker, plus the offer read-receipt definer), at the DATABASE layer, not only in
 * NotificationService. Each abuse case goes around the service on purpose (raw SQL in another user's tenant context), so
 * it proves the policy itself. Real PostgreSQL, RLS on, runtime role.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('SF-5: core.notification is recipient-scoped by RLS (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let dataSource: DataSource;
  let admin: DataSource;
  let tenantContext: TenantContextService;
  let notifications: NotificationService;
  let factory: TestIdentityFactory;
  let orgId: string;
  let manager: TestIdentity;
  let staffA: TestIdentity;
  let staffB: TestIdentity;
  let otherOrgManager: TestIdentity;
  const offerA = randomUUID();
  const offerB = randomUUID();
  let idA: string;
  let idB: string;

  const ctxOf = (i: TestIdentity): AuthContext => ({ organisationId: i.organisationId, workspaceId: i.workspaceId, userId: i.userId, role: '' }) as AuthContext;
  const as = <T>(i: TestIdentity, fn: (m: EntityManager) => Promise<T>) => tenantContext.runInTenantContext(ctxOf(i), fn);
  const asWorker = <T>(organisationId: string, fn: (m: EntityManager) => Promise<T>) =>
    tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId: '', role: '', actorType: 'worker' } as AuthContext, fn);
  const visibleIds = async (i: TestIdentity) =>
    (await as(i, (m) => m.query(`SELECT id FROM core.notification WHERE id = ANY($1::uuid[])`, [[idA, idB]]))).map((r: { id: string }) => r.id).sort();
  const adminRow = async (id: string) => (await admin.query(`SELECT user_id, read_at FROM core.notification WHERE id = $1`, [id]))[0];
  /** UPDATE/DELETE through TypeORM's raw query: [rows, affected]. */
  const affected = (result: unknown) => (Array.isArray(result) ? (result[1] as number) : 0);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    notifications = moduleRef.get(NotificationService);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'sf5' });
    orgId = seeded.organisation.id;
    manager = seeded.managers[0]!;
    staffA = await factory.createStaff(seeded.organisation, { owner: manager, label: 'sf5-a' });
    staffB = await factory.createStaff(seeded.organisation, { owner: manager, label: 'sf5-b' });
    otherOrgManager = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'sf5-other' })).managers[0]!;

    // notify() writes rows FOR other people (here: a manager's action notifying two staff members). With a recipient-only
    // SELECT policy an INSERT ... RETURNING would be refused, so this also pins that notify() still works.
    await as(manager, async (m) => {
      for (const [staff, offerId] of [[staffA, offerA], [staffB, offerB]] as const) {
        await notifications.notify(m, {
          organisationId: orgId, userId: staff.userId, type: NotificationType.OFFER_SENT,
          title: 'New shift offer', message: 'Venue · 12 Dec · £96.00', relatedEntityType: 'offer', relatedEntityId: offerId,
        });
      }
    });
    const ids = await admin.query(`SELECT id, user_id FROM core.notification WHERE related_entity_id = ANY($1::uuid[])`, [[offerA, offerB]]);
    idA = ids.find((r: { user_id: string }) => r.user_id === staffA.userId).id;
    idB = ids.find((r: { user_id: string }) => r.user_id === staffB.userId).id;
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  it('read: each staff member sees only their own notification; the manager who caused both sees neither', async () => {
    expect(await visibleIds(staffA)).toEqual([idA]);
    expect(await visibleIds(staffB)).toEqual([idB]);
    expect(await visibleIds(manager)).toEqual([]); // same organisation, no user_id filter in the SQL: still 0 rows
    expect(await visibleIds(otherOrgManager)).toEqual([]);
    expect((await notifications.list(ctxOf(staffA))).map((n) => n.id)).toEqual([idA]);
  });

  it('modify: another user in the same organisation cannot mark, delete or take over someone else\'s notification', async () => {
    expect(affected(await as(staffA, (m) => m.query(`UPDATE core.notification SET read_at = now() WHERE id = $1`, [idB])))).toBe(0);
    expect(affected(await as(manager, (m) => m.query(`UPDATE core.notification SET read_at = now() WHERE id = $1`, [idB])))).toBe(0);
    await expect(notifications.markRead(ctxOf(staffA), idB)).rejects.toBeInstanceOf(NotFoundException);
    expect(affected(await as(staffA, (m) => m.query(`DELETE FROM core.notification WHERE id = $1`, [idB])))).toBe(0);
    expect(affected(await as(staffB, (m) => m.query(`DELETE FROM core.notification WHERE id = $1`, [idB])))).toBe(0); // no DELETE path at all
    expect(await adminRow(idB)).toEqual({ user_id: staffB.userId, read_at: null });

    // WITH CHECK: the recipient cannot hand their row to someone else either.
    await expect(as(staffA, (m) => m.query(`UPDATE core.notification SET user_id = $2 WHERE id = $1`, [idA, staffB.userId]))).rejects.toThrow(/row-level security/);
    expect((await adminRow(idA)).user_id).toBe(staffA.userId);

    // The recipient can mark their own as read.
    await notifications.markRead(ctxOf(staffB), idB);
    expect((await adminRow(idB)).read_at).not.toBeNull();
  });

  it('owner test (a): a colleague in the SAME organisation, raw SQL on the runtime login with their own tenant context bound, reads 0 of a colleague\'s notifications and updates 0', async () => {
    const before = await admin.query(`SELECT user_id, title, read_at FROM core.notification WHERE id = $1`, [idB]);
    expect(before).toHaveLength(1); // control: staff member B's row exists, so every 0 below is the policy, not absence
    expect(before[0].user_id).toBe(staffB.userId);

    // Two colleagues of B in B's organisation: another staff member, and the manager whose action created B's row.
    for (const colleague of [staffA, manager]) {
      const seen = await as(colleague, async (m) => {
        const [session] = await m.query(
          `SELECT current_user::text AS cu, session_user::text AS su,
                  r.rolsuper AS super, r.rolbypassrls AS bypass,
                  current_setting('rab.organisation_id', true) AS org, current_setting('rab.user_id', true) AS uid,
                  coalesce(current_setting('rab.actor_type', true), '') AS actor
             FROM pg_roles r WHERE r.rolname = current_user`,
        );
        const byId = await m.query(`SELECT id, title, message FROM core.notification WHERE id = $1`, [idB]);
        const all = await m.query(`SELECT id, user_id FROM core.notification`); // no filter at all
        const allOfB = await m.query(`SELECT id FROM core.notification WHERE user_id = $1`, [staffB.userId]);
        const updById = await m.query(`UPDATE core.notification SET title = 'tampered', read_at = now() WHERE id = $1`, [idB]);
        const updAllOfB = await m.query(`UPDATE core.notification SET title = 'tampered' WHERE user_id = $1`, [staffB.userId]);
        return { session, byId, all, allOfB, updById: affected(updById), updAllOfB: affected(updAllOfB) };
      });

      // The runtime login itself (not an elevated role), bound to the colleague's own organisation and user, no worker marker.
      expect(seen.session.cu).toBe(seen.session.su);
      expect(seen.session.cu).not.toBe('crewflow');
      expect(seen.session.super).toBe(false);
      expect(seen.session.bypass).toBe(false);
      expect(seen.session.org).toBe(orgId);
      expect(seen.session.uid).toBe(colleague.userId);
      expect(seen.session.actor).toBe('');

      expect(seen.byId).toEqual([]); // SELECT by id
      expect(seen.allOfB).toEqual([]); // SELECT by recipient
      expect(seen.all.map((r: { id: string }) => r.id)).not.toContain(idB); // SELECT all
      expect(seen.all.every((r: { user_id: string }) => r.user_id === colleague.userId)).toBe(true); // only their own, if any
      expect(seen.updById).toBe(0); // UPDATE by id
      expect(seen.updAllOfB).toBe(0); // UPDATE by recipient
    }

    // Positive control: the recipient runs the identical SELECT by id and sees the row.
    expect(await as(staffB, (m) => m.query(`SELECT id FROM core.notification WHERE id = $1`, [idB]))).toEqual([{ id: idB }]);
    // Nothing changed on B's row.
    expect(await admin.query(`SELECT user_id, title, read_at FROM core.notification WHERE id = $1`, [idB])).toEqual(before);
  });

  it('insert stays organisation-bound: a row for another organisation is refused', async () => {
    await expect(
      as(manager, (m) => m.query(`INSERT INTO core.notification (organisation_id, user_id, type, title, message) VALUES ($1, $2, 'TEST', 't', 'm')`, [otherOrgManager.organisationId, otherOrgManager.userId])),
    ).rejects.toThrow(/row-level security/);
  });

  it('zero rows without tenant context (and the worker marker alone, without an organisation, is not enough)', async () => {
    const count = (gucs: Record<string, string>) =>
      dataSource.transaction(async (m) => {
        for (const [name, value] of Object.entries(gucs)) await m.query(`SELECT set_config($1, $2, true)`, [name, value]);
        const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM core.notification`);
        return n as number;
      });
    expect(await count({ 'rab.organisation_id': '', 'rab.user_id': '', 'rab.actor_type': '' })).toBe(0);
    expect(await count({ 'rab.organisation_id': '', 'rab.user_id': staffA.userId, 'rab.actor_type': '' })).toBe(0);
    expect(await count({ 'rab.organisation_id': '', 'rab.user_id': '', 'rab.actor_type': 'worker' })).toBe(0);
  });

  it('owner test (b): with the worker marker the Worker gets only what sending pushes needs: SELECT in its own organisation, no UPDATE, no DELETE, nothing of another organisation', async () => {
    // A notification in the OTHER organisation, written there by its own member.
    const otherOffer = randomUUID();
    await as(otherOrgManager, (m) => notifications.notify(m, {
      organisationId: otherOrgManager.organisationId, userId: otherOrgManager.userId, type: NotificationType.OFFER_SENT,
      title: 'Other organisation', message: 'Elsewhere · £50.00', relatedEntityType: 'offer', relatedEntityId: otherOffer,
    }));
    const [{ id: idOther }] = await admin.query(`SELECT id FROM core.notification WHERE related_entity_id = $1`, [otherOffer]);
    const snapshot = () => admin.query(`SELECT id, user_id, title, read_at FROM core.notification WHERE id = ANY($1::uuid[]) ORDER BY id`, [[idA, idB, idOther]]);
    const before = await snapshot();
    expect(before).toHaveLength(3);

    const run = await asWorker(orgId, async (m) => {
      const [session] = await m.query(
        `SELECT current_setting('rab.actor_type', true) AS actor, current_setting('rab.organisation_id', true) AS org,
                coalesce(current_setting('rab.user_id', true), '') AS uid`,
      );
      // What push send reads: the notification its delivery row names, by id (push-send.processor.ts revalidation).
      const pushRead = await m.query(`SELECT id, type FROM core.notification WHERE id = $1`, [idA]);
      const ownOrg = await m.query(`SELECT id FROM core.notification WHERE id = ANY($1::uuid[])`, [[idA, idB]]);
      const all = await m.query(`SELECT id, organisation_id FROM core.notification`); // no filter at all
      const otherById = await m.query(`SELECT id FROM core.notification WHERE id = $1`, [idOther]);
      const updOne = affected(await m.query(`UPDATE core.notification SET read_at = now(), title = 'tampered' WHERE id = $1`, [idA]));
      const updOrg = affected(await m.query(`UPDATE core.notification SET title = 'tampered' WHERE organisation_id = $1`, [orgId]));
      const updOther = affected(await m.query(`UPDATE core.notification SET title = 'tampered' WHERE id = $1`, [idOther]));
      const delOne = affected(await m.query(`DELETE FROM core.notification WHERE id = $1`, [idA]));
      const delOrg = affected(await m.query(`DELETE FROM core.notification WHERE organisation_id = $1`, [orgId]));
      const delOther = affected(await m.query(`DELETE FROM core.notification WHERE id = $1`, [idOther]));
      return { session, pushRead, ownOrg, all, otherById, updOne, updOrg, updOther, delOne, delOrg, delOther };
    });

    // The marker really is the only thing that differs from a no-user context: no uid, bound organisation.
    expect(run.session).toEqual({ actor: 'worker', org: orgId, uid: '' });
    // SELECT in its own organisation: yes (push send can read the row it delivers, whoever the recipient is).
    expect(run.pushRead).toEqual([{ id: idA, type: NotificationType.OFFER_SENT }]);
    expect(run.ownOrg.map((r: { id: string }) => r.id).sort()).toEqual([idA, idB].sort());
    // Another organisation's notification: never, by id or in an unfiltered SELECT.
    expect(run.otherById).toEqual([]);
    expect(run.all.map((r: { id: string }) => r.id)).not.toContain(idOther);
    expect(run.all.every((r: { organisation_id: string }) => r.organisation_id === orgId)).toBe(true);
    // UPDATE and DELETE: 0 rows, in its own organisation and in the other one.
    expect([run.updOne, run.updOrg, run.updOther, run.delOne, run.delOrg, run.delOther]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await snapshot()).toEqual(before); // nothing changed, nothing removed

    // The same marker bound to the other organisation does not reach this organisation's rows either.
    expect(await asWorker(otherOrgManager.organisationId, (m) => m.query(`SELECT id FROM core.notification WHERE id = ANY($1::uuid[])`, [[idA, idB]]))).toEqual([]);
    // Control: without the marker, the same no-user context (what push send bound before SF-5) reads nothing at all.
    const noMarker = await tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: null, userId: '', role: '' } as AuthContext, (m) =>
      m.query(`SELECT id FROM core.notification WHERE id = ANY($1::uuid[])`, [[idA, idB]]),
    );
    expect(noMarker).toEqual([]);
  });

  it('offer read receipt: the definer returns only the read time of that offer\'s notification for that recipient, inside the organisation', async () => {
    const readAt = (i: TestIdentity, offerId: string, recipient: string) =>
      as(i, async (m) => (await m.query(`SELECT core.offer_sent_notification_read_at($1, $2) AS t`, [offerId, recipient]))[0].t as Date | null);
    await notifications.markRead(ctxOf(staffA), idA);

    expect(await readAt(manager, offerA, staffA.userId)).toBeInstanceOf(Date);
    expect(await readAt(manager, offerA, staffB.userId)).toBeNull(); // wrong recipient for that offer
    expect(await readAt(otherOrgManager, offerA, staffA.userId)).toBeNull(); // another organisation
    // ...and the manager still cannot read the row itself.
    expect(await visibleIds(manager)).toEqual([]);
    // No tenant context: nothing.
    const noContext = await dataSource.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', '', true), set_config('rab.user_id', '', true)`);
      return (await m.query(`SELECT core.offer_sent_notification_read_at($1, $2) AS t`, [offerA, staffA.userId]))[0].t;
    });
    expect(noContext).toBeNull();
  });

  it('abuse: the runtime role setting the read-receipt flag itself still cannot read another user\'s offer_sent notification', async () => {
    // The read-receipt policy also requires current_user = 'crewflow'; crewflow_app setting rab.offer_read_receipt gains nothing.
    const result = await as(manager, async (m) => {
      const [{ flag }] = await m.query(`SELECT set_config('rab.offer_read_receipt', 'on', true) AS flag`);
      const [{ who }] = await m.query(`SELECT current_user::text AS who`);
      const rows = await m.query(`SELECT id, title, message, read_at FROM core.notification WHERE id = $1`, [idA]);
      return { flag, who, rows };
    });
    expect(result.flag).toBe('on'); // the flag really was set in that transaction
    expect(result.who).not.toBe('crewflow');
    expect(result.rows).toEqual([]);
    // The same flag, set by another staff member of the same organisation, does not expose staffA's row either.
    const asStaffB = await as(staffB, async (m) => {
      await m.query(`SELECT set_config('rab.offer_read_receipt', 'on', true)`);
      return m.query(`SELECT id FROM core.notification WHERE id = $1`, [idA]);
    });
    expect(asStaffB).toEqual([]);
  });

  it('abuse: the read-receipt definer ignores a read notification of another type that points at the same offer', async () => {
    const offerC = randomUUID();
    const readAt = async () =>
      as(manager, async (m) => (await m.query(`SELECT core.offer_sent_notification_read_at($1, $2) AS t`, [offerC, staffA.userId]))[0].t as Date | null);
    const notifyStaffA = (type: NotificationTypeType) =>
      as(manager, (m) => notifications.notify(m, {
        organisationId: orgId, userId: staffA.userId, type, title: 'Offer update', message: 'Venue · 13 Dec', relatedEntityType: 'offer', relatedEntityId: offerC,
      }));
    const idFor = async (type: NotificationTypeType) =>
      (await admin.query(`SELECT id FROM core.notification WHERE user_id = $1 AND related_entity_id = $2 AND type = $3`, [staffA.userId, offerC, type]))[0].id as string;

    // A non-offer_sent row for the same offer and recipient, marked read by the recipient: not a read receipt.
    await notifyStaffA(NotificationType.OFFER_CONFIRMED);
    const otherId = await idFor(NotificationType.OFFER_CONFIRMED);
    await notifications.markRead(ctxOf(staffA), otherId);
    expect((await adminRow(otherId)).read_at).not.toBeNull();
    expect(await readAt()).toBeNull();

    // An unread offer_sent row for that offer: still no receipt.
    await notifyStaffA(NotificationType.OFFER_SENT);
    const sentId = await idFor(NotificationType.OFFER_SENT);
    expect(await readAt()).toBeNull();

    // Control: once the offer_sent row itself is read, the definer reports it (so the nulls above are not a broken query).
    await notifications.markRead(ctxOf(staffA), sentId);
    expect(await readAt()).toBeInstanceOf(Date);
  });
});
