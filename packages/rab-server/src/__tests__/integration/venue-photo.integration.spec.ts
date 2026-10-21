import 'reflect-metadata';
import './helpers/use-local-storage-env'; // MUST be imported before AppModule — see that file's own doc comment

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Venue profile photo (VenuePhoto1786718700000): POST/DELETE /rest/v1/venues/:id/photo and the VENUE_PHOTO read
 * policy behind GET /rest/v1/files/:id. Real Postgres with RLS on, real multipart, LOCAL storage in a temp dir.
 *
 * Abuse cases (rab-workforce-architecture.md §1.2 floor): wrong type / fake extension / oversize, another workspace's
 * Manager (upload, remove and read = 404), organisationId smuggled in the multipart body (400), Staff with no work at
 * the venue (404), a withdrawn offer no longer grants read (404), a replaced or removed photo is tombstoned and unreadable.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(120_000);

describeIfDb('venue profile photo (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;

  // 1x1 PNG — real magic bytes (same fixture as multipart-upload-security / staff-avatar suites).
  const png = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  // Minimal JPEG / WebP headers — the sniff is by magic bytes, which is all the storage layer decides on.
  const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
  const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 1)]);
  const gif = () => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 1)]);

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  interface World {
    orgId: string;
    a: TestIdentity;
    b: TestIdentity;
    tokenA: string;
    tokenB: string;
  }

  async function world(): Promise<World> {
    const { organisation, managers } = await factory.createOrganisationWithManagers(2, { workspace: true });
    const [a, b] = managers as [TestIdentity, TestIdentity];
    const [tokenA, tokenB] = await Promise.all([factory.login(a), factory.login(b)]);
    return { orgId: organisation.id, a, b, tokenA, tokenB };
  }

  async function createVenue(token: string, name = `Venue ${randomUUID().slice(0, 6)}`): Promise<string> {
    const res = await http().post('/rest/v1/venues').set(auth(token)).send({ name, type: 'hotel' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  const upload = (token: string, venueId: string, bytes: Buffer, filename = 'photo.png', contentType = 'image/png') =>
    http().post(`/rest/v1/venues/${venueId}/photo`).set(auth(token)).attach('file', bytes, { filename, contentType });

  /** Publishes a shift at `venueId` and sends one offer to `staff`; returns the offer id. */
  async function offerAtVenue(token: string, venueId: string, staff: TestIdentity): Promise<{ offerId: string; shiftId: string }> {
    const role = await http().post('/rest/v1/job-roles').set(auth(token)).send({ name: `Role-${randomUUID()}`, defaultRatePence: 1200 });
    expect(role.status).toBe(201);
    const startsAt = new Date(Date.now() + 48 * 3600 * 1000);
    const endsAt = new Date(startsAt.getTime() + 6 * 3600 * 1000);
    const shift = await http()
      .post('/rest/v1/shifts')
      .set(auth(token))
      .send({ venueId, jobRoleId: role.body.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), requiredCount: 1 });
    expect({ status: shift.status, body: shift.body }).toMatchObject({ status: 201 });
    const published = await http().post(`/rest/v1/shifts/${shift.body.id}/publish`).set(auth(token));
    expect({ status: published.status, body: published.body }).toMatchObject({ status: 201 });
    const offer = await http().post(`/rest/v1/shifts/${shift.body.id}/offers`).set(auth(token)).send({ staffProfileId: staff.profileId });
    if (offer.status !== 201) throw new Error(`offer setup failed: ${offer.status} ${JSON.stringify(offer.body)}`);
    return { offerId: offer.body.id as string, shiftId: shift.body.id as string };
  }

  /** A Staff account that can be offered work (factory default employment status is not ACTIVE). */
  async function activeStaff(w: World, label = 'staff'): Promise<TestIdentity> {
    const staff = await factory.createStaff({ id: w.orgId }, { owner: w.a, label });
    await adminDataSource.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = $1`, [staff.profileId]);
    return staff;
  }

  async function fileStatus(w: World, fileId: string): Promise<string | undefined> {
    const rows = await tenantContext.runInTenantContext(
      { organisationId: w.orgId, workspaceId: w.a.workspaceId, userId: randomUUID(), role: '' },
      (m) => m.query('SELECT status FROM core.stored_file WHERE id = $1', [fileId]),
    );
    return rows[0]?.status;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    app.getHttpServer().closeAllConnections?.();
    await app.close();
    await adminDataSource.destroy();
  });

  it('happy path: upload returns { photoFileId }, venue GET + list expose it, the owner can read the bytes, the file is workspace-bound and audited', async () => {
    const w = await world();
    const venueId = await createVenue(w.tokenA);

    const before = await http().get(`/rest/v1/venues/${venueId}`).set(auth(w.tokenA));
    expect(before.body.photoFileId).toBeNull();

    const res = await upload(w.tokenA, venueId, png());
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['photoFileId']);
    const fileId = res.body.photoFileId as string;

    const detail = await http().get(`/rest/v1/venues/${venueId}`).set(auth(w.tokenA));
    expect(detail.body.photoFileId).toBe(fileId);
    const list = await http().get('/rest/v1/venues').set(auth(w.tokenA));
    expect(list.body.data.find((v: { id: string }) => v.id === venueId).photoFileId).toBe(fileId);

    const bytes = await http().get(`/rest/v1/files/${fileId}`).set(auth(w.tokenA));
    expect(bytes.status).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/png');
    expect(Buffer.from(bytes.body).equals(png())).toBe(true);

    const [row] = await adminDataSource.query(
      'SELECT organisation_id, workspace_id, kind, resource_type, resource_id, created_by FROM core.stored_file WHERE id = $1',
      [fileId],
    );
    expect(row).toMatchObject({ organisation_id: w.orgId, workspace_id: w.a.workspaceId, kind: 'VENUE_PHOTO', resource_type: 'venue', resource_id: venueId, created_by: w.a.userId });

    const audit = await adminDataSource.query(
      `SELECT action FROM core.audit_log WHERE organisation_id = $1 AND (entity_id = $2 OR entity_id = $3) ORDER BY created_at`,
      [w.orgId, fileId, venueId],
    );
    expect(audit.map((r: { action: string }) => r.action)).toEqual(expect.arrayContaining(['file.uploaded', 'venue.photo_updated']));
  });

  it('accepts JPEG and WebP by content', async () => {
    const w = await world();
    const venueId = await createVenue(w.tokenA);
    expect((await upload(w.tokenA, venueId, jpeg(), 'p.jpg', 'image/jpeg')).status).toBe(201);
    expect((await upload(w.tokenA, venueId, webp(), 'p.webp', 'image/webp')).status).toBe(201);
  });

  it('rejects a non-image, a fake extension and an unsupported image type (400) and leaves the current photo in place', async () => {
    const w = await world();
    const venueId = await createVenue(w.tokenA);
    const good = await upload(w.tokenA, venueId, png());
    expect(good.status).toBe(201);

    expect((await upload(w.tokenA, venueId, Buffer.from('definitely not an image'), 'photo.png', 'image/png')).status).toBe(400);
    // Fake extension + fake Content-Type: PDF bytes presented as a JPEG.
    expect((await upload(w.tokenA, venueId, Buffer.from('%PDF-1.7\n%fake'), 'photo.jpg', 'image/jpeg')).status).toBe(400);
    expect((await upload(w.tokenA, venueId, gif(), 'photo.gif', 'image/gif')).status).toBe(400);

    const detail = await http().get(`/rest/v1/venues/${venueId}`).set(auth(w.tokenA));
    expect(detail.body.photoFileId).toBe(good.body.photoFileId);
  });

  it('rejects a file over 5 MB before storage (Multer limit, 413 — the repo-wide convention for oversize uploads)', async () => {
    const w = await world();
    const venueId = await createVenue(w.tokenA);
    const tooBig = Buffer.concat([png(), Buffer.alloc(5 * 1024 * 1024, 1)]);
    const res = await upload(w.tokenA, venueId, tooBig);
    expect(res.status).toBe(413);
    const detail = await http().get(`/rest/v1/venues/${venueId}`).set(auth(w.tokenA));
    expect(detail.body.photoFileId).toBeNull();
  });

  it('organisationId (or any other field) in the multipart body is rejected with 400; a missing file is 400', async () => {
    const w = await world();
    const venueId = await createVenue(w.tokenA);
    const smuggled = await http()
      .post(`/rest/v1/venues/${venueId}/photo`)
      .set(auth(w.tokenA))
      .field('organisationId', randomUUID())
      .attach('file', png(), { filename: 'photo.png', contentType: 'image/png' });
    expect(smuggled.status).toBe(400);
    const json = await http().post(`/rest/v1/venues/${venueId}/photo`).set(auth(w.tokenA)).send({ organisationId: randomUUID() });
    expect(json.status).toBe(400);
    const detail = await http().get(`/rest/v1/venues/${venueId}`).set(auth(w.tokenA));
    expect(detail.body.photoFileId).toBeNull();
  });

  it('photoFileId cannot be set through PATCH /venues/:id (not a declared field: 400)', async () => {
    const w = await world();
    const venueId = await createVenue(w.tokenA);
    const res = await http().patch(`/rest/v1/venues/${venueId}`).set(auth(w.tokenA)).send({ photoFileId: randomUUID() });
    expect(res.status).toBe(400);
  });

  it("another workspace's Manager gets 404 on upload, remove and on GET /files/:id of the photo", async () => {
    const w = await world();
    const venueId = await createVenue(w.tokenA);
    const fileId = (await upload(w.tokenA, venueId, png())).body.photoFileId as string;

    expect((await upload(w.tokenB, venueId, png())).status).toBe(404);
    expect((await http().delete(`/rest/v1/venues/${venueId}/photo`).set(auth(w.tokenB))).status).toBe(404);
    expect((await http().get(`/rest/v1/files/${fileId}`).set(auth(w.tokenB))).status).toBe(404);

    const detail = await http().get(`/rest/v1/venues/${venueId}`).set(auth(w.tokenA));
    expect(detail.body.photoFileId).toBe(fileId);
    expect(await fileStatus(w, fileId)).toBe('AVAILABLE');
  });

  it('an unknown venue id and a non-UUID id are both 404 (no existence oracle)', async () => {
    const w = await world();
    expect((await upload(w.tokenA, randomUUID(), png())).status).toBe(404);
    expect((await upload(w.tokenA, 'not-a-uuid', png())).status).toBe(404);
  });

  it('Staff with an offer at the venue can read the photo and see venuePhotoFileId on /offers/mine; Staff without work there get 404', async () => {
    const w = await world();
    const venueId = await createVenue(w.tokenA);
    const otherVenueId = await createVenue(w.tokenA);
    const fileId = (await upload(w.tokenA, venueId, png())).body.photoFileId as string;

    const offered = await activeStaff(w, 'offered');
    const elsewhere = await activeStaff(w, 'elsewhere');
    const idle = await activeStaff(w, 'idle');
    await offerAtVenue(w.tokenA, venueId, offered);
    await offerAtVenue(w.tokenA, otherVenueId, elsewhere);
    const [offeredToken, elsewhereToken, idleToken] = await Promise.all([factory.login(offered), factory.login(elsewhere), factory.login(idle)]);

    const ok = await http().get(`/rest/v1/files/${fileId}`).set(auth(offeredToken));
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');

    const mine = await http().get('/rest/v1/offers/mine').set(auth(offeredToken));
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].venuePhotoFileId).toBe(fileId);

    const elsewhereMine = await http().get('/rest/v1/offers/mine').set(auth(elsewhereToken));
    expect(elsewhereMine.body[0].venuePhotoFileId).toBeNull();

    expect((await http().get(`/rest/v1/files/${fileId}`).set(auth(elsewhereToken))).status).toBe(404);
    expect((await http().get(`/rest/v1/files/${fileId}`).set(auth(idleToken))).status).toBe(404);

    const denied = await adminDataSource.query(
      `SELECT count(*)::int AS n FROM core.audit_log WHERE organisation_id = $1 AND action = 'file.access_denied' AND entity_id = $2`,
      [w.orgId, fileId],
    );
    expect(denied[0].n).toBeGreaterThanOrEqual(2);
  });

  it('a withdrawn offer loses Staff read access (404)', async () => {
    const w = await world();
    const venueId = await createVenue(w.tokenA);
    const fileId = (await upload(w.tokenA, venueId, png())).body.photoFileId as string;
    const staff = await activeStaff(w);
    const { offerId } = await offerAtVenue(w.tokenA, venueId, staff);
    const staffToken = await factory.login(staff);
    expect((await http().get(`/rest/v1/files/${fileId}`).set(auth(staffToken))).status).toBe(200);

    expect((await http().post(`/rest/v1/offers/${offerId}/withdraw`).set(auth(w.tokenA))).status).toBe(201);
    expect((await http().get(`/rest/v1/files/${fileId}`).set(auth(staffToken))).status).toBe(404);
  });

  describe('Staff access follows LIVE work only (owner decision 2026-10-20)', () => {
    async function setup() {
      const w = await world();
      const venueId = await createVenue(w.tokenA);
      const fileId = (await upload(w.tokenA, venueId, png())).body.photoFileId as string;
      return { w, venueId, fileId };
    }
    const read = (token: string, fileId: string) => http().get(`/rest/v1/files/${fileId}`).set(auth(token));

    it('a declined offer loses access (404)', async () => {
      const { w, venueId, fileId } = await setup();
      const staff = await activeStaff(w);
      const { offerId } = await offerAtVenue(w.tokenA, venueId, staff);
      const token = await factory.login(staff);
      expect((await read(token, fileId)).status).toBe(200);
      expect((await http().post(`/rest/v1/offers/${offerId}/decline`).set(auth(token)).send({})).status).toBe(201);
      expect((await read(token, fileId)).status).toBe(404);
    });

    it('an expired offer loses access (404) — both a lapsed pending offer and one the expiry job already flipped', async () => {
      const { w, venueId, fileId } = await setup();
      const staff = await activeStaff(w);
      const { offerId } = await offerAtVenue(w.tokenA, venueId, staff);
      const token = await factory.login(staff);
      expect((await read(token, fileId)).status).toBe(200);
      // Lapsed but not yet swept: still `pending`, expires_at in the past.
      await adminDataSource.query(`UPDATE core.job_offer SET expires_at = now() - interval '1 minute' WHERE id = $1`, [offerId]);
      expect((await read(token, fileId)).status).toBe(404);
      // Swept by the expiry job.
      await adminDataSource.query(`UPDATE core.job_offer SET status = 'expired' WHERE id = $1`, [offerId]);
      expect((await read(token, fileId)).status).toBe(404);
    });

    it('a confirmed offer keeps access (200); the same seat once completed or cancelled loses it (404)', async () => {
      const { w, venueId, fileId } = await setup();
      const staff = await activeStaff(w);
      const { offerId, shiftId } = await offerAtVenue(w.tokenA, venueId, staff);
      const token = await factory.login(staff);
      expect((await http().post(`/rest/v1/offers/${offerId}/accept`).set(auth(token))).status).toBe(201);
      expect((await read(token, fileId)).status).toBe(200);
      const confirm = await http().post(`/rest/v1/offers/${offerId}/confirm`).set(auth(w.tokenA));
      expect([200, 201]).toContain(confirm.status);
      // Confirmed offers are not subject to the pending-offer expiry.
      await adminDataSource.query(`UPDATE core.job_offer SET expires_at = now() - interval '1 minute' WHERE id = $1`, [offerId]);
      expect((await read(token, fileId)).status).toBe(200);

      await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'completed' WHERE shift_id = $1 AND staff_profile_id = $2`, [shiftId, staff.profileId]);
      expect((await read(token, fileId)).status).toBe(404);
      await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'cancelled' WHERE shift_id = $1 AND staff_profile_id = $2`, [shiftId, staff.profileId]);
      expect((await read(token, fileId)).status).toBe(404);
    });

    it('a manager-rejected acceptance loses access (404)', async () => {
      const { w, venueId, fileId } = await setup();
      const staff = await activeStaff(w);
      const { offerId } = await offerAtVenue(w.tokenA, venueId, staff);
      const token = await factory.login(staff);
      expect((await http().post(`/rest/v1/offers/${offerId}/accept`).set(auth(token))).status).toBe(201);
      const reject = await http().post(`/rest/v1/offers/${offerId}/reject`).set(auth(w.tokenA)).send({ reason: 'Not this time' });
      expect([200, 201]).toContain(reject.status);
      expect((await read(token, fileId)).status).toBe(404);
    });
  });

  it('attendance projections (/attendance/me/active and /me/history) carry venuePhotoFileId', async () => {
    const w = await world();
    const venueId = await createVenue(w.tokenA);
    const fileId = (await upload(w.tokenA, venueId, png())).body.photoFileId as string;
    const staff = await activeStaff(w);
    const { offerId, shiftId } = await offerAtVenue(w.tokenA, venueId, staff);
    const staffToken = await factory.login(staff);
    expect((await http().post(`/rest/v1/offers/${offerId}/accept`).set(auth(staffToken))).status).toBe(201);
    const confirm = await http().post(`/rest/v1/offers/${offerId}/confirm`).set(auth(w.tokenA));
    expect([200, 201]).toContain(confirm.status);

    // Clocking in needs a signed QR + geofence; the attendance row itself is seeded as the owner (same as venue-manager-scoping).
    await adminDataSource.query(
      `INSERT INTO core.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, status)
       SELECT sa.organisation_id, sa.workspace_id, sa.id, sa.shift_id, sa.staff_profile_id, now() - interval '10 minutes', 'clocked_in'
         FROM core.shift_assignment sa WHERE sa.shift_id = $1 AND sa.staff_profile_id = $2`,
      [shiftId, staff.profileId],
    );
    const active = await http().get('/rest/v1/attendance/me/active').set(auth(staffToken));
    expect(active.status).toBe(200);
    expect(active.body.attendance.venuePhotoFileId).toBe(fileId);

    await adminDataSource.query(
      `UPDATE core.attendance SET status = 'clocked_out', clock_out_at = now(), clock_out_method = 'manual', break_minutes = 0, worked_minutes = 10, earned_pence = 200
        WHERE shift_id = $1 AND staff_profile_id = $2`,
      [shiftId, staff.profileId],
    );
    const history = await http().get('/rest/v1/attendance/me/history').set(auth(staffToken));
    expect(history.status).toBe(200);
    expect(history.body[0].venuePhotoFileId).toBe(fileId);
  });

  it('a Venue Manager assigned to the venue can read the photo; one not assigned gets 404; a Venue Manager cannot upload', async () => {
    const w = await world();
    const venueId = await createVenue(w.tokenA);
    const fileId = (await upload(w.tokenA, venueId, png())).body.photoFileId as string;
    const assigned = await factory.createVenueManager({ id: w.orgId }, { owner: w.a, venueIds: [venueId] });
    const unassigned = await factory.createVenueManager({ id: w.orgId }, { owner: w.a });
    const [assignedToken, unassignedToken] = await Promise.all([factory.login(assigned), factory.login(unassigned)]);

    expect((await http().get(`/rest/v1/files/${fileId}`).set(auth(assignedToken))).status).toBe(200);
    expect((await http().get(`/rest/v1/files/${fileId}`).set(auth(unassignedToken))).status).toBe(404);
    // Venue Manager app tokens are not allowed on the photo routes at all, and the role has no venue.edit.
    expect((await upload(assignedToken, venueId, png())).status).toBe(403);
  });

  it('replacing tombstones the previous photo; removing clears photoFileId, tombstones the file and makes it unreadable', async () => {
    const w = await world();
    const venueId = await createVenue(w.tokenA);
    const first = (await upload(w.tokenA, venueId, png())).body.photoFileId as string;
    const second = (await upload(w.tokenA, venueId, jpeg(), 'p.jpg', 'image/jpeg')).body.photoFileId as string;
    expect(second).not.toBe(first);
    expect(await fileStatus(w, first)).toBe('DELETED');
    expect(await fileStatus(w, second)).toBe('AVAILABLE');
    expect((await http().get(`/rest/v1/files/${first}`).set(auth(w.tokenA))).status).toBe(404);

    const removed = await http().delete(`/rest/v1/venues/${venueId}/photo`).set(auth(w.tokenA));
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ photoFileId: null });
    expect(await fileStatus(w, second)).toBe('DELETED');
    expect((await http().get(`/rest/v1/files/${second}`).set(auth(w.tokenA))).status).toBe(404);
    const detail = await http().get(`/rest/v1/venues/${venueId}`).set(auth(w.tokenA));
    expect(detail.body.photoFileId).toBeNull();

    // Removing again is a harmless no-op.
    expect((await http().delete(`/rest/v1/venues/${venueId}/photo`).set(auth(w.tokenA))).status).toBe(200);
  });

  it('RLS: with no tenant context bound a VENUE_PHOTO row is invisible to the runtime role; another workspace context sees nothing', async () => {
    const w = await world();
    const venueId = await createVenue(w.tokenA);
    const fileId = (await upload(w.tokenA, venueId, png())).body.photoFileId as string;
    const none = await dataSource.query('SELECT id FROM core.stored_file WHERE id = $1', [fileId]);
    expect(none).toHaveLength(0);
    const other = await tenantContext.runInTenantContext(
      { organisationId: w.orgId, workspaceId: w.b.workspaceId, userId: w.b.userId, role: '' },
      (m) => m.query('SELECT id FROM core.stored_file WHERE id = $1', [fileId]),
    );
    expect(other).toHaveLength(0);
  });
});
