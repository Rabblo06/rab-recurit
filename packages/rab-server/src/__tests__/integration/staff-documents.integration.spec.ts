import 'reflect-metadata';
import './helpers/use-local-storage-env'; // MUST be imported before AppModule — see that file's own doc comment

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import {
  VirusScanner,
  VirusScanVerdict,
} from '../../engine/core-modules/storage/virus-scan/virus-scanner';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Staff documents over HTTP (Lane D PR 2): upload, list, verify / reject / revoke, requirements, and the STAFF_DOCUMENT read
 * policy behind GET /rest/v1/files/:id/download. Real Postgres with FORCE RLS, real multipart, LOCAL storage in a temp dir.
 *
 * The virus scanner is replaced by a controllable test double (`verdict` below) so both the "real scanner said clean" and
 * the "infected" paths are exercised; production with no CLAMAV_HOST uses NoVirusScanner and nothing is ever clean.
 *
 * Abuse cases (§1.2 floor): another organisation's and another workspace's manager (404 on list, upload, decisions and the
 * file); another staff member's document (404); a staff token on the manager routes (refused); a file hidden until scanned
 * clean; a download link that stops working after revoke; oversize (413) and mis-typed content with a lying extension and
 * Content-Type (400); organisationId / status smuggled in the multipart body (400); an infected upload is refused and
 * nothing is stored; verifying before a clean scan (409) and an invalid transition (409).
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(180_000);

let verdict: VirusScanVerdict = {
  status: 'unavailable',
  reason: 'not_configured',
};
const scannerDouble = {
  get engine() {
    return verdict.status === 'unavailable' ? null : 'test-engine';
  },
  scan: async () => verdict,
};

describeIfDb('staff documents over HTTP (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;

  const pdf = () =>
    Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
  const png = () =>
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
  const gif = () => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 1)]);
  const html = () => Buffer.from('<!doctype html><script>alert(1)</script>');

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  interface World {
    orgId: string;
    a: TestIdentity;
    b: TestIdentity;
    s1: TestIdentity;
    s2: TestIdentity;
    other: TestIdentity;
    tokenA: string;
    tokenB: string;
    tokenS1: string;
    tokenS2: string;
    tokenOther: string;
  }

  async function world(): Promise<World> {
    const { organisation, managers } =
      await factory.createOrganisationWithManagers(2, { workspace: true });
    const [a, b] = managers as [TestIdentity, TestIdentity];
    const s1 = await factory.createStaff(
      { id: organisation.id },
      { owner: a, label: 's1' },
    );
    const s2 = await factory.createStaff(
      { id: organisation.id },
      { owner: a, label: 's2' },
    );
    const { managers: others } = await factory.createOrganisationWithManagers(
      1,
      { workspace: true },
    );
    const other = others[0]!;
    const [tokenA, tokenB, tokenS1, tokenS2, tokenOther] = await Promise.all(
      [a, b, s1, s2, other].map((i) => factory.login(i)),
    );
    return {
      orgId: organisation.id,
      a,
      b,
      s1,
      s2,
      other,
      tokenA,
      tokenB,
      tokenS1,
      tokenS2,
      tokenOther,
    };
  }

  const uploadFor = (
    token: string,
    staffProfileId: string,
    bytes: Buffer,
    fields: Record<string, string> = {
      documentType: 'right_to_work',
      expiresOn: '2031-01-31',
    },
    filename = 'doc.pdf',
    contentType = 'application/pdf',
  ) => {
    let req = http()
      .post(`/rest/v1/staff/${staffProfileId}/documents`)
      .set(auth(token));
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', bytes, { filename, contentType });
  };
  const uploadMine = (
    token: string,
    bytes: Buffer,
    fields: Record<string, string> = { documentType: 'first_aid' },
  ) => {
    let req = http().post('/rest/v1/staff-documents/me').set(auth(token));
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', bytes, {
      filename: 'mine.pdf',
      contentType: 'application/pdf',
    });
  };
  const action = (
    token: string,
    staffProfileId: string,
    documentId: string,
    name: 'verify' | 'reject' | 'revoke',
    body: object = {},
  ) =>
    http()
      .post(`/rest/v1/staff/${staffProfileId}/documents/${documentId}/${name}`)
      .set(auth(token))
      .send(body);
  const download = (token: string, fileId: string) =>
    http().get(`/rest/v1/files/${fileId}/download`).set(auth(token));
  const fileIdOf = async (documentId: string): Promise<string> =>
    (
      await adminDataSource.query(
        `SELECT file_id FROM core.staff_document WHERE id = $1`,
        [documentId],
      )
    )[0].file_id;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(VirusScanner)
      .useValue(scannerDouble)
      .compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource,
      adminDataSource,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
  });

  beforeEach(() => {
    verdict = { status: 'unavailable', reason: 'not_configured' };
  });

  afterAll(async () => {
    app.getHttpServer().closeAllConnections?.();
    await app.close();
    await adminDataSource.destroy();
  });

  it('no scanner: the upload is stored as not_scanned and stays HIDDEN (no fileId, download 404, verify 409)', async () => {
    const w = await world();
    const res = await uploadFor(w.tokenA, w.s1.profileId!, pdf());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      documentType: 'right_to_work',
      expiresOn: '2031-01-31',
      status: 'pending',
      scanStatus: 'not_scanned',
      fileId: null,
      uploadedBySelf: false,
    });
    const fileId = await fileIdOf(res.body.id);
    expect((await download(w.tokenA, fileId)).status).toBe(404);
    const verify = await action(
      w.tokenA,
      w.s1.profileId!,
      res.body.id,
      'verify',
    );
    expect(verify.status).toBe(409);
    expect(verify.body.code).toBe('STAFF_DOCUMENT_NOT_SCANNED');
    const [file] = await adminDataSource.query(
      `SELECT kind, resource_type, resource_id, workspace_id, object_key FROM core.stored_file WHERE id = $1`,
      [fileId],
    );
    expect(file).toMatchObject({
      kind: 'STAFF_DOCUMENT',
      resource_type: 'staff_document',
      resource_id: res.body.id,
      workspace_id: w.a.workspaceId,
    });
    // Private, server-built key: opaque ids only, never the filename, type label or staff name.
    expect(file.object_key).toMatch(
      new RegExp(
        `organisations/${w.orgId}/workspaces/${w.a.workspaceId}/staff-documents/${res.body.id}/[0-9a-f-]{36}\\.pdf$`,
      ),
    );
  });

  it('scanned clean: the manager and the staff member download it; another staff member, another workspace and another organisation get 404', async () => {
    const w = await world();
    verdict = { status: 'clean', engine: 'test-engine' };
    const res = await uploadFor(w.tokenA, w.s1.profileId!, pdf());
    expect(res.status).toBe(201);
    expect(res.body.scanStatus).toBe('clean');
    const fileId = res.body.fileId as string;
    expect(fileId).toEqual(expect.any(String));

    const mgr = await download(w.tokenA, fileId);
    expect(mgr.status).toBe(200);
    expect(mgr.headers['content-disposition']).toMatch(/^attachment/);
    expect(mgr.headers['x-content-type-options']).toBe('nosniff');
    expect((await download(w.tokenS1, fileId)).status).toBe(200);
    expect((await download(w.tokenS2, fileId)).status).toBe(404);
    expect((await download(w.tokenB, fileId)).status).toBe(404);
    expect((await download(w.tokenOther, fileId)).status).toBe(404);
  });

  it('a revoked document stops downloading at once (re-using the link = 404) and cannot be verified any more', async () => {
    const w = await world();
    verdict = { status: 'clean', engine: 'test-engine' };
    const res = await uploadFor(w.tokenA, w.s1.profileId!, pdf());
    const fileId = res.body.fileId as string;
    expect((await download(w.tokenA, fileId)).status).toBe(200);
    const revoked = await action(
      w.tokenA,
      w.s1.profileId!,
      res.body.id,
      'revoke',
      { reason: 'Wrong person on the document' },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ status: 'revoked', fileId: null });
    expect((await download(w.tokenA, fileId)).status).toBe(404);
    expect((await download(w.tokenS1, fileId)).status).toBe(404);
    expect(
      (await action(w.tokenA, w.s1.profileId!, res.body.id, 'verify')).status,
    ).toBe(409);
  });

  it('verify after a clean scan; verifying twice is an invalid transition (409); rejecting needs a reason (400)', async () => {
    const w = await world();
    verdict = { status: 'clean', engine: 'test-engine' };
    const res = await uploadFor(w.tokenA, w.s1.profileId!, pdf());
    expect(
      (await action(w.tokenA, w.s1.profileId!, res.body.id, 'reject', {}))
        .status,
    ).toBe(400);
    const verified = await action(
      w.tokenA,
      w.s1.profileId!,
      res.body.id,
      'verify',
    );
    expect(verified.status).toBe(200);
    expect(verified.body.status).toBe('verified');
    expect(
      (await action(w.tokenA, w.s1.profileId!, res.body.id, 'verify')).status,
    ).toBe(409);
    const audit = await adminDataSource.query(
      `SELECT action FROM core.audit_log WHERE organisation_id = $1 AND entity_id = $2 ORDER BY created_at`,
      [w.orgId, res.body.id],
    );
    expect(audit.map((r: { action: string }) => r.action)).toEqual([
      'staff_document.uploaded',
      'staff_document.verified',
    ]);
  });

  it("another workspace's and another organisation's manager get 404 on list, upload and decisions", async () => {
    const w = await world();
    const res = await uploadFor(w.tokenA, w.s1.profileId!, pdf());
    for (const token of [w.tokenB, w.tokenOther]) {
      expect(
        (
          await http()
            .get(`/rest/v1/staff/${w.s1.profileId}/documents`)
            .set(auth(token))
        ).status,
      ).toBe(404);
      expect((await uploadFor(token, w.s1.profileId!, pdf())).status).toBe(404);
      expect(
        (
          await action(token, w.s1.profileId!, res.body.id, 'revoke', {
            reason: 'not mine to revoke',
          })
        ).status,
      ).toBe(404);
    }
  });

  it("another staff member's document id under the wrong staff profile is 404", async () => {
    const w = await world();
    const res = await uploadFor(w.tokenA, w.s1.profileId!, pdf());
    expect(
      (
        await action(w.tokenA, w.s2.profileId!, res.body.id, 'revoke', {
          reason: 'mismatched staff',
        })
      ).status,
    ).toBe(404);
  });

  it("staff app: a staff member lists and uploads their own documents, never another person's, and cannot reach the manager routes", async () => {
    const w = await world();
    const mine = await uploadMine(w.tokenS1, pdf());
    expect(mine.status).toBe(201);
    expect(mine.body.uploadedBySelf).toBe(true);
    await uploadFor(w.tokenA, w.s2.profileId!, pdf());
    const list = await http()
      .get('/rest/v1/staff-documents/me')
      .set(auth(w.tokenS1));
    expect(list.status).toBe(200);
    expect(list.body.documents.map((d: { id: string }) => d.id)).toEqual([
      mine.body.id,
    ]);
    expect(list.body.requiredTypes).toEqual(['right_to_work']);
    const managerRoute = await http()
      .get(`/rest/v1/staff/${w.s1.profileId}/documents`)
      .set(auth(w.tokenS1));
    expect(managerRoute.status).toBeGreaterThanOrEqual(400);
    expect(
      (await uploadFor(w.tokenS1, w.s2.profileId!, pdf())).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await action(w.tokenS1, w.s1.profileId!, mine.body.id, 'verify')).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it('mis-typed content is refused by magic bytes whatever the filename / Content-Type says (400); PNG scans are accepted', async () => {
    const w = await world();
    expect(
      (
        await uploadFor(
          w.tokenA,
          w.s1.profileId!,
          gif(),
          undefined,
          'doc.pdf',
          'application/pdf',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await uploadFor(
          w.tokenA,
          w.s1.profileId!,
          html(),
          undefined,
          'doc.pdf',
          'application/pdf',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await uploadFor(
          w.tokenA,
          w.s1.profileId!,
          Buffer.from('MZ\x90\x00 not a pdf'),
          undefined,
          'doc.pdf',
          'application/pdf',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await uploadFor(
          w.tokenA,
          w.s1.profileId!,
          png(),
          undefined,
          'scan.png',
          'image/png',
        )
      ).status,
    ).toBe(201);
    const count = await adminDataSource.query(
      `SELECT count(*)::int AS n FROM core.staff_document WHERE organisation_id = $1`,
      [w.orgId],
    );
    expect(count[0].n).toBe(1);
  });

  it('a file over 10 MB is refused before storage (413)', async () => {
    const w = await world();
    const tooBig = Buffer.concat([pdf(), Buffer.alloc(10 * 1024 * 1024, 1)]);
    expect((await uploadFor(w.tokenA, w.s1.profileId!, tooBig)).status).toBe(
      413,
    );
  });

  it('organisationId, status or scanStatus in the multipart body is a 400; bad dates are 400', async () => {
    const w = await world();
    expect(
      (
        await uploadFor(w.tokenA, w.s1.profileId!, pdf(), {
          documentType: 'passport',
          organisationId: randomUUID(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await uploadFor(w.tokenA, w.s1.profileId!, pdf(), {
          documentType: 'passport',
          status: 'verified',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await uploadFor(w.tokenA, w.s1.profileId!, pdf(), {
          documentType: 'passport',
          scanStatus: 'clean',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await uploadFor(w.tokenA, w.s1.profileId!, pdf(), {
          documentType: 'passport',
          expiresOn: '2031-02-30',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await uploadFor(w.tokenA, w.s1.profileId!, pdf(), {
          documentType: 'passport',
          issuedOn: '2030-05-01',
          expiresOn: '2030-01-01',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await uploadFor(w.tokenA, w.s1.profileId!, pdf(), {
          documentType: 'tax_return',
        })
      ).status,
    ).toBe(400);
  });

  it('an infected upload is refused (400), audited, and nothing is stored', async () => {
    const w = await world();
    verdict = {
      status: 'infected',
      engine: 'test-engine',
      signature: 'Eicar-Test-Signature',
    };
    const res = await uploadFor(w.tokenA, w.s1.profileId!, pdf());
    expect(res.status).toBe(400);
    expect(
      await adminDataSource.query(
        `SELECT id FROM core.staff_document WHERE organisation_id = $1`,
        [w.orgId],
      ),
    ).toHaveLength(0);
    expect(
      await adminDataSource.query(
        `SELECT id FROM core.stored_file WHERE organisation_id = $1 AND kind = 'STAFF_DOCUMENT'`,
        [w.orgId],
      ),
    ).toHaveLength(0);
    const audit = await adminDataSource.query(
      `SELECT action FROM core.audit_log WHERE organisation_id = $1 AND action = 'staff_document.upload_rejected'`,
      [w.orgId],
    );
    expect(audit).toHaveLength(1);
  });

  it('requirements: default Right to Work; a manager replaces the list; a staff token cannot change it', async () => {
    const w = await world();
    const before = await http()
      .get('/rest/v1/staff-documents/requirements')
      .set(auth(w.tokenA));
    expect(before.status).toBe(200);
    expect(
      before.body.find(
        (r: { documentType: string }) => r.documentType === 'right_to_work',
      ),
    ).toMatchObject({ required: true, source: 'default' });
    const set = await http()
      .put('/rest/v1/staff-documents/requirements')
      .set(auth(w.tokenA))
      .send({ requiredTypes: ['dbs_check'] });
    expect(set.status).toBe(200);
    expect(
      set.body
        .filter((r: { required: boolean }) => r.required)
        .map((r: { documentType: string }) => r.documentType),
    ).toEqual(['dbs_check']);
    expect(
      (
        await http()
          .put('/rest/v1/staff-documents/requirements')
          .set(auth(w.tokenA))
          .send({ requiredTypes: ['other'] })
      ).status,
    ).toBe(400);
    expect(
      (
        await http()
          .put('/rest/v1/staff-documents/requirements')
          .set(auth(w.tokenA))
          .send({ requiredTypes: [], organisationId: randomUUID() })
      ).status,
    ).toBe(400);
    expect(
      (
        await http()
          .put('/rest/v1/staff-documents/requirements')
          .set(auth(w.tokenS1))
          .send({ requiredTypes: [] })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    // Another organisation still sees its own default.
    const other = await http()
      .get('/rest/v1/staff-documents/requirements')
      .set(auth(w.tokenOther));
    expect(
      other.body.find(
        (r: { documentType: string }) => r.documentType === 'right_to_work',
      ),
    ).toMatchObject({ required: true, source: 'default' });
  });
});
