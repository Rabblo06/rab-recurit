import 'reflect-metadata';
import './helpers/use-local-storage-env'; // MUST be imported before AppModule — see that file's own doc comment

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * PHASE 11 / DEP-01 — proves the installed Multer version (2.4.0, outside
 * every affected range up to and including 2.2.x) plus this phase's own
 * explicit per-route limits (`upload-limits.ts`) hold under real,
 * deliberately malformed multipart requests. Real Postgres, real HTTP,
 * through the actual `AppModule` — no mocks of Multer/Busboy itself.
 *
 * "No partial state" below is verified against the LOCAL STORAGE OBJECT
 * COUNT (files actually written under `STORAGE_LOCAL_ROOT`), not a
 * `stored_file` DB row count. This phase's own investigation surfaced a
 * genuine, PRE-EXISTING defect, fully reproducible via a direct
 * `ProfileService.uploadAvatar()` call with no HTTP/Multer/Phase-11 code
 * involved at all: a successful upload's `StoredFile` metadata row is not
 * durably persisted in this environment (the object write itself DOES land
 * on disk reliably). This is unrelated to DEP-01 (a parser/dependency
 * question) and is out of scope to fix here — see the Phase 11 report's
 * "newly discovered issues" section. Object-count assertions below are
 * unaffected by that defect and are what this suite actually needs to prove
 * multipart parsing behaves correctly.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(30_000);

describeIfDb('multipart upload security (Phase 11 / DEP-01)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let staff: TestIdentity;
  let accessToken: string;

  const tinyPngBuffer = () =>
    // 1x1 transparent PNG — real magic bytes, passes FileService's own sniff.
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

  function countObjectsOnDisk(): number {
    const root = process.env.STORAGE_LOCAL_ROOT;
    if (!root) return 0;
    function walk(dir: string): number {
      let n = 0;
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        n += statSync(full).isDirectory() ? walk(full) : 1;
      }
      return n;
    }
    try {
      return walk(root);
    } catch {
      return 0;
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    // Listening on a real ephemeral port (not just `app.init()`) so the
    // abort test below can drive a raw `http.request` and genuinely sever
    // the TCP connection mid-body — supertest's own API has no equivalent.
    await app.listen(0);
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    org = await factory.createOrganisation('p11-upload');
    const owner = await factory.createInternalManager(org);
    staff = await factory.createStaff(org, { owner });
    accessToken = await factory.login(staff);
  });

  afterAll(async () => {
    // `app.listen(0)` (for the raw-socket abort test) plus supertest's own
    // keep-alive pooling across many requests in this file can otherwise
    // leave connections open that `app.close()` alone waits on forever.
    app.getHttpServer().closeAllConnections?.();
    await app.close();
    await adminDataSource.destroy();
  });

  it('acceptance 2: a valid profile avatar upload still works end to end', async () => {
    const before = countObjectsOnDisk();
    const res = await request(app.getHttpServer())
      .post('/rest/v1/profile/avatar')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', tinyPngBuffer(), { filename: 'avatar.png', contentType: 'image/png' });
    expect(res.status).toBe(201); // no @HttpCode on this route — Nest's default for POST
    expect(res.body.avatarKey).toBeTruthy();
    expect(countObjectsOnDisk()).toBeGreaterThan(before);
  });

  it('acceptance 4/5: the configured file-size boundary is enforced — over-limit rejected, no new object written', async () => {
    // upload-limits.ts sets fileSize to 10 MiB for this route.
    const overLimit = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const before = countObjectsOnDisk();
    const res = await request(app.getHttpServer())
      .post('/rest/v1/profile/avatar')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', overLimit, { filename: 'too-big.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
    expect(countObjectsOnDisk()).toBe(before);
  });

  it('acceptance 6: a missing multipart boundary is rejected with a controlled 400, not a crash', async () => {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/profile/avatar')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Content-Type', 'multipart/form-data') // no boundary= at all
      .send(Buffer.from('--fake\r\nContent-Disposition: form-data; name="file"\r\n\r\nabc\r\n--fake--'));
    expect([400, 422]).toContain(res.status);
  });

  it('acceptance 7: a truncated multipart body (declared boundary, body cut mid-part) is rejected, not hung or crashed', async () => {
    const boundary = '----truncatedTestBoundary';
    const truncatedBody = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n` +
        'this is not a complete part, the closing boundary never arrives',
    );
    const res = await request(app.getHttpServer())
      .post('/rest/v1/profile/avatar')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(truncatedBody);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('acceptance 8: an unexpected extra file field is rejected — this route accepts exactly one "file" field', async () => {
    const before = countObjectsOnDisk();
    const res = await request(app.getHttpServer())
      .post('/rest/v1/profile/avatar')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', tinyPngBuffer(), { filename: 'avatar.png', contentType: 'image/png' })
      .attach('not_expected', tinyPngBuffer(), { filename: 'extra.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(countObjectsOnDisk()).toBe(before);
  });

  it('acceptance 9: too many files under the SAME field name is rejected (files: 1)', async () => {
    const before = countObjectsOnDisk();
    const res = await request(app.getHttpServer())
      .post('/rest/v1/profile/avatar')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', tinyPngBuffer(), { filename: 'a.png', contentType: 'image/png' })
      .attach('file', tinyPngBuffer(), { filename: 'b.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(countObjectsOnDisk()).toBe(before);
  });

  it('an unexpected non-file text field is rejected — this route expects zero form fields besides the file', async () => {
    const before = countObjectsOnDisk();
    const res = await request(app.getHttpServer())
      .post('/rest/v1/profile/avatar')
      .set('Authorization', `Bearer ${accessToken}`)
      .field('description', 'not expected on this route')
      .attach('file', tinyPngBuffer(), { filename: 'avatar.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(countObjectsOnDisk()).toBe(before);
  });

  it('CVE-2026-77078/82333 regression: crafted bracket-array-index field names never reach append-field, are rejected with a controlled 400, and never crash the process', async () => {
    const before = countObjectsOnDisk();
    // The exact crafted-field-name pattern the advisories describe. With
    // fieldNestingDepth: 0 / fieldArrayIndexLimit: 0 on this route, Multer
    // itself rejects the bracket-notation field name before append-field
    // (the vulnerable dependency) ever parses it.
    const res = await request(app.getHttpServer())
      .post('/rest/v1/profile/avatar')
      .set('Authorization', `Bearer ${accessToken}`)
      .field('x[4294967294]', '1')
      .field('x[4294967295]', '1');
    expect(res.status).toBe(400);
    expect(countObjectsOnDisk()).toBe(before);
    // The API process itself must still be alive and answering — the whole
    // point of the advisory is that an unpatched version's crash would make
    // this next, completely unrelated request fail too.
    const stillAlive = await request(app.getHttpServer()).get('/healthz');
    expect(stillAlive.status).toBe(200);
  });

  it('a malformed filename (path traversal attempt) never becomes storage path authority', async () => {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/profile/avatar')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', tinyPngBuffer(), { filename: '../../../../etc/passwd', contentType: 'image/png' });
    expect(res.status).toBe(201);
    // The object key is server-generated (buildObjectKey) — the traversal
    // attempt in the client-supplied filename never reaches the storage
    // path at all. Walk the local storage root and confirm every path
    // segment actually written is a plain, safe directory/file name.
    const root = process.env.STORAGE_LOCAL_ROOT!;
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else out.push(full);
      }
      return out;
    }
    for (const path of walk(root)) {
      expect(path).not.toContain('etc/passwd');
      expect(path.replace(root, '')).not.toMatch(/\.\./);
    }
  });

  it('binary bytes with no valid image magic number are rejected by existing FileService validation, unaffected by the Multer upgrade', async () => {
    const before = countObjectsOnDisk();
    const res = await request(app.getHttpServer())
      .post('/rest/v1/profile/avatar')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from('this is not an image at all'), { filename: 'fake.png', contentType: 'image/png' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(countObjectsOnDisk()).toBe(before);
  });

  it('a request aborted mid-upload leaves no storage object behind and the server stays alive', async () => {
    const before = countObjectsOnDisk();
    const address = app.getHttpServer().address();
    if (typeof address !== 'object' || address === null) throw new Error('server not listening on a TCP port');

    // Raw Node http request, not supertest — genuinely severs the TCP
    // connection mid-body. The controller's own service call (which would
    // write the object) can only run after Multer hands back a
    // fully-parsed file, so destroying the connection before the closing
    // boundary ever arrives structurally cannot leave an object behind.
    await new Promise<void>((resolve) => {
      const boundary = '----abortTestBoundary';
      const clientReq = http.request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/rest/v1/profile/avatar',
          method: 'POST',
          // No keep-alive/pooling — a lingering pooled socket from this
          // deliberately-destroyed request is exactly what previously left
          // Jest unable to exit naturally after this test.
          agent: false,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            Connection: 'close',
          },
        },
        () => resolve(), // a response before we abort would also be fine — the count assertion below is what actually matters
      );
      clientReq.on('error', () => resolve()); // an aborted socket surfaces as a client-side error — expected, not a test failure
      clientReq.write(`--${boundary}\r\n`);
      clientReq.write('Content-Disposition: form-data; name="file"; filename="big.png"\r\n');
      clientReq.write('Content-Type: image/png\r\n\r\n');
      clientReq.write(Buffer.alloc(1024, 1));
      setTimeout(() => {
        clientReq.destroy(new Error('deliberate test abort — closing boundary never sent'));
        resolve();
      }, 50);
    });

    // Give the server a moment to observe the aborted connection and
    // unwind Multer's own stream handling before asserting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(countObjectsOnDisk()).toBe(before);

    const stillAlive = await request(app.getHttpServer()).get('/healthz');
    expect(stillAlive.status).toBe(200);
  });
});
