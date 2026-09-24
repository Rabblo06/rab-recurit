import './helpers/use-s3-env'; // FIRST: env is frozen when AppModule is imported
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { FileKind } from '../../engine/core-modules/storage/file-kinds';
import { FileService } from '../../engine/core-modules/storage/file.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { ShiftReport } from '../../modules/attendance/entities/shift-report.entity';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { S3_TEST } from './helpers/s3-env';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * FILE STORAGE — attack tests through the real API, real PostgreSQL RLS and a
 * real private S3 bucket (MinIO). Gated on RAB_TEST_S3=1.
 *
 * Actors: organisation A has two Internal Managers in DIFFERENT workspaces
 * (imA in WA, imA2 in WA2), a Venue Manager for venue V1 (vmA1), a Venue
 * Manager for an unrelated venue V2 (vmA2) and a Staff member. Organisation B
 * has its own manager.
 */
const describeIf = S3_TEST.enabled ? describe : describe.skip;

// Minimal but genuine images (magic bytes are what the server checks).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const PDF = Buffer.from('%PDF-1.4\n% generated report evidence\n%%EOF\n');

describeIf('file storage — security, authorization and integrity (API + RLS + S3)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let files: FileService;
  let factory: TestIdentityFactory;
  let sdk: S3Client;

  let orgA: Organisation;
  let orgB: Organisation;
  let imA: TestIdentity;
  let imA2: TestIdentity;
  let imB: TestIdentity;
  let vmA1: TestIdentity;
  let vmA2: TestIdentity;
  let staffA: TestIdentity;
  const token: Record<string, string> = {};

  let reportId: string;
  let reportFileId: string;
  let reportObjectKey: string;

  const http = () => request(app.getHttpServer());
  const get = (t: string, path: string) => http().get(`/rest/v1${path}`).set('Authorization', `Bearer ${t}`).redirects(0);
  const post = (t: string, path: string, body?: object) => http().post(`/rest/v1${path}`).set('Authorization', `Bearer ${t}`).send(body ?? {});
  const ctxOf = (i: TestIdentity, org: Organisation) => ({ organisationId: org.id, workspaceId: i.workspaceId, userId: i.userId, role: '' });

  /** Owner-connection read of a file row (the owner is subject to forced RLS, so bracket it exactly as the worker's discovery does). */
  const ownerSql = <T>(sql: string, params: unknown[] = []): Promise<T> =>
    adminDataSource.transaction(async (m) => {
      await m.query(`ALTER TABLE core.stored_file DISABLE ROW LEVEL SECURITY`);
      try {
        return (await m.query(sql, params)) as T;
      } finally {
        await m.query(`ALTER TABLE core.stored_file ENABLE ROW LEVEL SECURITY`);
      }
    });
  const fileRow = (id: string) => ownerSql<Array<Record<string, any>>>(`SELECT * FROM core.stored_file WHERE id = $1`, [id]);
  const auditActions = (org: Organisation, im: TestIdentity, action: string, entityId: string) =>
    tenantContext.runInTenantContext(ctxOf(im, org), (m) => m.query(`SELECT actor_user_id FROM core.audit_log WHERE organisation_id = $1 AND action = $2 AND entity_id = $3`, [org.id, action, entityId]));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    files = moduleRef.get(FileService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    sdk = new S3Client({ region: S3_TEST.region, endpoint: S3_TEST.endpoint, forcePathStyle: true, credentials: { accessKeyId: S3_TEST.accessKeyId, secretAccessKey: S3_TEST.secretAccessKey } });

    orgA = await factory.createOrganisation('fsA');
    orgB = await factory.createOrganisation('fsB');
    imA = await factory.createInternalManager(orgA);
    imA2 = await factory.createInternalManager(orgA); // same organisation, DIFFERENT workspace
    imB = await factory.createInternalManager(orgB);
    const venues = await tenantContext.runInTenantContext(ctxOf(imA, orgA), async (m) => {
      const v1 = await m.save(Venue, { organisationId: orgA.id, name: 'V1', createdBy: imA.userId, workspaceId: imA.workspaceId! });
      const v2 = await m.save(Venue, { organisationId: orgA.id, name: 'V2', createdBy: imA.userId, workspaceId: imA.workspaceId! });
      return { v1, v2 };
    });
    vmA1 = await factory.createVenueManager(orgA, { owner: imA, venueIds: [venues.v1.id] });
    vmA2 = await factory.createVenueManager(orgA, { owner: imA, venueIds: [venues.v2.id] });
    staffA = await factory.createStaff(orgA, { owner: imA });
    for (const [name, identity] of Object.entries({ imA, imA2, imB, vmA1, vmA2, staffA })) token[name] = await factory.login(identity);

    // A shift at V1 with its report, and a stored roster PDF attached to that report (as the worker does).
    reportId = await tenantContext.runInTenantContext(ctxOf(imA, orgA), async (m) => {
      const jobRole = await m.save(JobRole, { organisationId: orgA.id, name: 'Role', defaultRatePence: 1500, createdBy: imA.userId, workspaceId: imA.workspaceId! });
      const shift = await m.save(Shift, {
        organisationId: orgA.id,
        venueId: venues.v1.id,
        jobRoleId: jobRole.id,
        startsAt: new Date(Date.now() + 3600_000),
        endsAt: new Date(Date.now() + 9 * 3600_000),
        breakMinutes: 30,
        requiredCount: 1,
        payRatePence: 1500,
        status: 'open',
        createdBy: imA.userId,
        workspaceId: imA.workspaceId!,
      });
      const report = await m.save(ShiftReport, { organisationId: orgA.id, workspaceId: imA.workspaceId!, shiftId: shift.id, status: 'ready' });
      const stored = await files.store(m, {
        kind: FileKind.SHIFT_ROSTER_PDF,
        organisationId: orgA.id,
        workspaceId: imA.workspaceId!,
        resourceType: 'shift_report',
        resourceId: report.id,
        buffer: PDF,
        filename: 'shift-roster.pdf',
      });
      reportFileId = stored.id;
      reportObjectKey = stored.objectKey;
      await m.query(`UPDATE core.shift_report SET pre_shift_file_id = $1 WHERE id = $2`, [stored.id, report.id]);
      return report.id;
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  // ------------------------------------------------------------------------------------------------
  describe('report PDF download: authorization matrix', () => {
    it('Internal Manager (owner workspace): 302 to a short-lived presigned URL that serves EXACTLY the stored bytes as an attachment', async () => {
      const res = await get(token.imA!, `/files/${reportFileId}/download`);
      expect(res.status).toBe(302);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const url = new URL(res.headers.location!);
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
      expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300); // short-lived
      expect(res.headers.location).not.toContain('accessKey'); // no long-lived secret in the URL

      const object = await fetch(res.headers.location!);
      expect(object.status).toBe(200);
      expect(object.headers.get('content-disposition')).toMatch(/^attachment; filename="shift-roster\.pdf"/);
      expect(Buffer.from(await object.arrayBuffer()).equals(PDF)).toBe(true);
    });

    it('a signed URL is NEVER stored: the metadata row has no URL and the key is an opaque server-generated path', async () => {
      const [row] = await fileRow(reportFileId);
      expect(Object.keys(row).filter((k) => /url|signature|token/i.test(k))).toEqual([]);
      expect(row.object_key).toMatch(new RegExp(`^test/organisations/${orgA.id}/workspaces/${imA.workspaceId}/reports/[0-9a-f-]{36}/[0-9a-f-]{36}\\.pdf$`));
      expect(row.object_key).not.toMatch(/shift-roster|@|\.\./); // no filename, email or traversal in a key
      expect(row.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));
    });

    it('a Venue Manager of the report\'s venue: allowed', async () => {
      expect((await get(token.vmA1!, `/files/${reportFileId}/download`)).status).toBe(302);
    });

    it.each([
      ['a Venue Manager of an UNRELATED venue in the same workspace', 'vmA2'],
      ['a Staff member of the same workspace', 'staffA'],
      ['an Internal Manager of a DIFFERENT workspace in the same organisation', 'imA2'],
      ['a manager of ANOTHER organisation', 'imB'],
    ])('%s: 404, indistinguishable from "does not exist"', async (_label, who) => {
      const denied = await get(token[who]!, `/files/${reportFileId}/download`);
      const missing = await get(token[who]!, `/files/${randomUUID()}/download`);
      expect(denied.status).toBe(404);
      expect(denied.body).toEqual(missing.body); // no oracle
      const proxy = await get(token[who]!, `/files/${reportFileId}`);
      expect(proxy.status).toBe(404);
    });

    it('unauthenticated: 401', async () => {
      expect((await http().get(`/rest/v1/files/${reportFileId}/download`)).status).toBe(401);
    });

    it('the Staff denial is AUDITED (the row was visible to RLS, the per-kind policy refused it)', async () => {
      await get(token.staffA!, `/files/${reportFileId}/download`);
      expect((await auditActions(orgA, imA, 'file.access_denied', reportFileId)).length).toBeGreaterThan(0);
    });

    it('a successful download is audited as authorized (evidence access trail)', async () => {
      await get(token.imA!, `/files/${reportFileId}/download`);
      expect((await auditActions(orgA, imA, 'file.download_authorized', reportFileId)).length).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('the client can never name an object', () => {
    it('a raw object key in the path reaches no handler (404), encoded or not', async () => {
      const raw = await http().get(`/rest/v1/files/${reportObjectKey}`).set('Authorization', `Bearer ${token.imA!}`);
      expect(raw.status).toBe(404);
      const encoded = await get(token.imA!, `/files/${encodeURIComponent(reportObjectKey)}`);
      expect(encoded.status).toBe(404);
    });

    it('legacy-style keys and traversal are 404', async () => {
      for (const path of [`/files/org/${orgA.id}/reports/x/final-timesheet.pdf`, `/files/..%2F..%2Fetc%2Fpasswd`, `/files/%2e%2e/%2e%2e/secret`]) {
        expect((await get(token.imA!, path)).status).toBe(404);
      }
    });

    it('a guessed uuid, a nil uuid and garbage are 404', async () => {
      for (const id of [randomUUID(), '00000000-0000-0000-0000-000000000000', 'not-a-uuid', '1', '{}']) {
        expect((await get(token.imA!, `/files/${encodeURIComponent(id)}/download`)).status).toBe(404);
      }
    });

    it('bucket / objectKey / organisationId query parameters are ignored — access is still decided by the file id', async () => {
      const res = await get(token.imB!, `/files/${reportFileId}/download?bucket=${S3_TEST.bucket}&objectKey=${encodeURIComponent(reportObjectKey)}&organisationId=${orgA.id}`);
      expect(res.status).toBe(404);
    });

    it('upload-intent rejects any attempt to steer the key, bucket, tenant or owner (400, never a silent override)', async () => {
      const base = { kind: 'PROFILE_IMAGE', filename: 'a.png', sizeBytes: PNG.length, contentType: 'image/png' };
      for (const extra of [{ objectKey: 'x' }, { key: 'x' }, { bucket: 'other' }, { organisationId: orgB.id }, { workspaceId: imA2.workspaceId }, { resourceId: imB.userId }, { status: 'AVAILABLE' }]) {
        expect((await post(token.staffA!, '/files/upload-intent', { ...base, ...extra })).status).toBe(400);
      }
    });

    it('a client cannot ask to upload generated-evidence kinds', async () => {
      for (const kind of ['SHIFT_ROSTER_PDF', 'FINAL_TIMESHEET_PDF', 'ORGANISATION_LOGO', 'bogus']) {
        expect((await post(token.imA!, '/files/upload-intent', { kind, filename: 'a.pdf', sizeBytes: 100, contentType: 'application/pdf' })).status).toBe(400);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('RLS on file metadata', () => {
    it('no tenant context: zero rows (a query with nothing bound never sees a file)', async () => {
      const rows = await dataSource.query(`SELECT id FROM core.stored_file`);
      expect(rows).toEqual([]);
    });

    it('organisation B sees none of organisation A\'s files; A sees none of B\'s', async () => {
      const bFile = await tenantContext.runInTenantContext(ctxOf(imB, orgB), (m) =>
        files.store(m, { kind: FileKind.ORGANISATION_LOGO, organisationId: orgB.id, workspaceId: null, resourceType: 'organisation', resourceId: orgB.id, buffer: PNG }),
      );
      const seenByB = await tenantContext.runInTenantContext(ctxOf(imB, orgB), (m) => m.query(`SELECT id, organisation_id FROM core.stored_file`));
      expect(seenByB.every((r: { organisation_id: string }) => r.organisation_id === orgB.id)).toBe(true);
      expect(seenByB.map((r: { id: string }) => r.id)).not.toContain(reportFileId);
      const seenByA = await tenantContext.runInTenantContext(ctxOf(imA, orgA), (m) => m.query(`SELECT id FROM core.stored_file`));
      expect(seenByA.map((r: { id: string }) => r.id)).not.toContain(bFile.id);
    });

    it('same organisation, different workspace: the report file is invisible at the database layer, not just refused by the API', async () => {
      const seen = await tenantContext.runInTenantContext(ctxOf(imA2, orgA), (m) => m.query(`SELECT id FROM core.stored_file WHERE id = $1`, [reportFileId]));
      expect(seen).toEqual([]);
    });

    it('rab_app cannot DELETE file metadata (evidence is tombstoned, never removed by the application role)', async () => {
      await expect(tenantContext.runInTenantContext(ctxOf(imA, orgA), (m) => m.query(`DELETE FROM core.stored_file WHERE id = $1`, [reportFileId]))).rejects.toThrow(/permission denied/i);
    });

    it('WITH CHECK: a caller cannot insert a file into another organisation', async () => {
      await expect(
        tenantContext.runInTenantContext(ctxOf(imB, orgB), (m) =>
          m.query(
            `INSERT INTO core.stored_file (organisation_id, kind, resource_type, resource_id, storage_driver, bucket, object_key, original_filename, mime_type, size_bytes, sha256, status)
             VALUES ($1, 'ORGANISATION_LOGO', 'organisation', $1, 'S3', 'b', $2, 'x.png', 'image/png', 10, $3, 'AVAILABLE')`,
            [orgA.id, `test/${randomUUID()}`, 'a'.repeat(64)],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('API-mediated upload validation (avatars)', () => {
    const upload = (t: string, buffer: Buffer, filename: string, contentType = 'image/png') =>
      http().post('/rest/v1/profile/avatar').set('Authorization', `Bearer ${t}`).attach('file', buffer, { filename, contentType });

    it('a real PNG is stored; the profile exposes an opaque FILE ID (never an object key) and the bytes are served with hardened headers', async () => {
      const res = await upload(token.staffA!, PNG, 'me.png');
      expect(res.status).toBe(201);
      const handle = res.body.avatarKey as string;
      expect(handle).toMatch(/^[0-9a-f-]{36}$/);
      expect(handle).not.toContain('/');

      const served = await get(token.staffA!, `/files/${handle}`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe('image/png');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['content-security-policy']).toContain("default-src 'none'");
      expect(served.headers['content-disposition']).toMatch(/^inline;/);
      expect((served.body as Buffer).equals(PNG)).toBe(true);
    });

    it('an avatar is not visible across workspaces or organisations (404)', async () => {
      const own = await upload(token.imA!, PNG, 'imA.png');
      const handle = own.body.avatarKey as string;
      expect((await get(token.imA!, `/files/${handle}`)).status).toBe(200);
      expect((await get(token.imA2!, `/files/${handle}`)).status).toBe(404); // same org, other workspace
      expect((await get(token.imB!, `/files/${handle}`)).status).toBe(404); // other org
    });

    it('content is decided by the BYTES: HTML disguised as a PNG (right name, right Content-Type) is refused', async () => {
      const res = await upload(token.staffA!, Buffer.from('<html><script>alert(1)</script></html>'), 'avatar.png', 'image/png');
      expect(res.status).toBe(400);
    });

    it('an empty file and a file over the limit are refused', async () => {
      expect((await upload(token.staffA!, Buffer.alloc(0), 'a.png')).status).toBe(400);
      expect([400, 413]).toContain((await upload(token.staffA!, Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]), 'big.png')).status);
    });

    it('a hostile filename is neutralised: no traversal, no CR/LF header injection, display metadata only', async () => {
      const hostile = '../../etc/passwd\r\nX-Injected: yes‮gnp.png';
      const res = await upload(token.imA!, PNG, hostile);
      expect(res.status).toBe(201);
      const [row] = await fileRow(res.body.avatarKey);
      expect(row.original_filename).not.toMatch(/[\r\n\\/]|\.\./);
      expect(row.original_filename).not.toContain('‮');
      expect(row.object_key).not.toContain('passwd'); // the name never reaches the key
      const served = await get(token.imA!, `/files/${res.body.avatarKey}`);
      expect(served.headers['content-disposition']).not.toMatch(/[\r\n]/);
      expect(served.headers['x-injected']).toBeUndefined();
    });

    it('replacing an avatar tombstones the old file: the old id stops resolving, the row is kept as DELETED', async () => {
      const first = await upload(token.staffA!, PNG, 'one.png');
      const old = first.body.avatarKey as string;
      await upload(token.staffA!, Buffer.concat([PNG, Buffer.from('v2')]), 'two.png');
      expect((await get(token.staffA!, `/files/${old}`)).status).toBe(404);
      expect((await fileRow(old))[0].status).toBe('DELETED');
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('presigned direct upload', () => {
    const intent = (t: string, body: object = {}) => post(t, '/files/upload-intent', { kind: 'PROFILE_IMAGE', filename: 'direct.png', sizeBytes: PNG.length, contentType: 'image/png', ...body });

    it('happy path: server-generated key -> PUT to S3 -> server verifies -> AVAILABLE -> becomes the avatar', async () => {
      const res = await intent(token.vmA1!);
      expect(res.status).toBe(201);
      const [pending] = await fileRow(res.body.fileId);
      expect(pending.status).toBe('PENDING');
      expect(pending.sha256).toBeNull();
      expect(pending.object_key).toContain(`/organisations/${orgA.id}/`);
      expect(pending.object_key).not.toContain('direct.png');
      expect(pending.created_by).toBe(vmA1.userId);

      const put = await fetch(res.body.uploadUrl, { method: 'PUT', body: PNG, headers: res.body.headers });
      expect(put.status).toBe(200);
      // Not downloadable while PENDING, even by its owner.
      expect((await get(token.vmA1!, `/files/${res.body.fileId}`)).status).toBe(404);

      const done = await post(token.vmA1!, `/files/${res.body.fileId}/complete`);
      expect(done.status).toBe(201);
      expect(done.body.status).toBe('AVAILABLE');
      const [available] = await fileRow(res.body.fileId);
      expect(available.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));

      const profile = await get(token.vmA1!, '/profile');
      expect(profile.body.avatarKey).toBe(res.body.fileId);
      expect((await get(token.vmA1!, `/files/${res.body.fileId}`)).status).toBe(200);
    });

    it('the URL only accepts the declared size and type (S3 enforces it, the server never had to see the bytes)', async () => {
      const res = await intent(token.vmA2!);
      const wrongType = await fetch(res.body.uploadUrl, { method: 'PUT', body: PNG, headers: { ...res.body.headers, 'Content-Type': 'text/html' } });
      expect(wrongType.status).toBe(403);
      const wrongSize = await fetch(res.body.uploadUrl, { method: 'PUT', body: Buffer.concat([PNG, Buffer.from('extra')]), headers: res.body.headers });
      expect(wrongSize.status).toBeGreaterThanOrEqual(400);
    });

    it('"complete" without an upload, and "complete" by anyone but the creator, fail', async () => {
      const res = await intent(token.staffA!);
      expect((await post(token.staffA!, `/files/${res.body.fileId}/complete`)).status).toBe(400); // nothing uploaded yet
      expect((await post(token.imA!, `/files/${res.body.fileId}/complete`)).status).toBe(404); // not the creator
      expect((await post(token.imB!, `/files/${res.body.fileId}/complete`)).status).toBe(404); // other organisation
    });

    it('the client\'s word is worthless: right size and content type but the WRONG BYTES -> refused, marked FAILED, object removed', async () => {
      const res = await intent(token.imA2!, { sizeBytes: 40 });
      const lie = Buffer.from('<html>not an image, exactly 40 bytes!!!</html>'.slice(0, 40).padEnd(40, '.'));
      expect(lie.length).toBe(40);
      expect((await fetch(res.body.uploadUrl, { method: 'PUT', body: lie, headers: res.body.headers })).status).toBe(200);
      expect((await post(token.imA2!, `/files/${res.body.fileId}/complete`)).status).toBe(400);
      const [row] = await fileRow(res.body.fileId);
      expect(row.status).toBe('FAILED');
      expect(await files['driverFactory'].getDriver().head(row.object_key)).toBeNull();
    });

    it('abuse control: a user cannot stockpile abandoned upload intents (429 after the cap)', async () => {
      const results: number[] = [];
      for (let i = 0; i < 7; i++) results.push((await intent(token.imB!)).status);
      expect(results.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
      expect(results.slice(5)).toEqual([429, 429]);
    });

    it('size and type validation: zero, oversize and non-image declarations are 400', async () => {
      expect((await intent(token.staffA!, { sizeBytes: 0 })).status).toBe(400);
      expect((await intent(token.staffA!, { sizeBytes: 11 * 1024 * 1024 })).status).toBe(400);
      expect((await intent(token.staffA!, { contentType: 'text/html' })).status).toBe(400);
      expect((await intent(token.staffA!, { contentType: 'application/pdf' })).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('integrity and failure of the stored evidence', () => {
    async function freshReportFile(pdf = PDF): Promise<{ id: string; key: string }> {
      return tenantContext.runInTenantContext(ctxOf(imA, orgA), async (m) => {
        const stored = await files.store(m, { kind: FileKind.SHIFT_ROSTER_PDF, organisationId: orgA.id, workspaceId: imA.workspaceId!, resourceType: 'shift_report', resourceId: reportId, buffer: pdf, filename: 'r.pdf' });
        return { id: stored.id, key: stored.objectKey };
      });
    }

    it('object deleted out from under the database: a controlled 404, never a false success, and an integrity audit entry', async () => {
      const f = await freshReportFile();
      await sdk.send(new DeleteObjectCommand({ Bucket: S3_TEST.bucket, Key: f.key }));
      const res = await get(token.imA!, `/files/${f.id}/download`);
      expect(res.status).toBe(404);
      expect((await auditActions(orgA, imA, 'report.integrity_failed', f.id)).length).toBeGreaterThan(0);
    });

    it('object TRUNCATED/replaced with a different size: STORAGE_INTEGRITY_FAILED (502) on the redirect path, audited', async () => {
      const f = await freshReportFile();
      await sdk.send(new PutObjectCommand({ Bucket: S3_TEST.bucket, Key: f.key, Body: Buffer.from('%PDF-tampered'), ContentType: 'application/pdf' }));
      const res = await get(token.imA!, `/files/${f.id}/download`);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('STORAGE_INTEGRITY_FAILED');
      expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`${S3_TEST.bucket}|${f.key}|amazonaws|minio`, 'i')); // no provider or key detail
      expect((await auditActions(orgA, imA, 'report.integrity_failed', f.id)).length).toBeGreaterThan(0);
    });

    it('same-SIZE corruption is caught by the SHA-256 on every path that reads the bytes (proxy download)', async () => {
      const f = await freshReportFile();
      const corrupted = Buffer.from(PDF);
      corrupted[10] = corrupted[10]! ^ 0xff; // flip one byte, keep the length
      await sdk.send(new PutObjectCommand({ Bucket: S3_TEST.bucket, Key: f.key, Body: corrupted, ContentType: 'application/pdf' }));
      const res = await get(token.imA!, `/files/${f.id}`); // the byte-reading path
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('STORAGE_INTEGRITY_FAILED');
      // and the email path refuses it too:
      const file = await tenantContext.runInTenantContext(ctxOf(imA, orgA), (m) => files.findAvailable(m, f.id));
      await expect(files.readVerified(file!)).rejects.toMatchObject({ code: 'STORAGE_INTEGRITY_FAILED' });
    });

    it('a DELETED (tombstoned) file no longer resolves for anyone', async () => {
      const f = await freshReportFile();
      await tenantContext.runInTenantContext(ctxOf(imA, orgA), async (m) => {
        const file = await files.findAvailable(m, f.id);
        await files.tombstone(m, file!, { removeObject: false });
      });
      expect((await get(token.imA!, `/files/${f.id}/download`)).status).toBe(404);
      expect((await fileRow(f.id))[0].status).toBe('DELETED');
    });

    it('storage errors never leak provider detail to a client', async () => {
      // Point the file row at a key in a bucket the credentials cannot use by breaking the key namespace: the object is simply absent.
      const f = await freshReportFile();
      await ownerSql(`UPDATE core.stored_file SET object_key = $2 WHERE id = $1`, [f.id, `test/does/not/exist-${randomUUID()}.pdf`]);
      const res = await get(token.imA!, `/files/${f.id}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/NoSuchKey|<Error>|RequestId|amazonaws|minio/i);
    });
  });
});
