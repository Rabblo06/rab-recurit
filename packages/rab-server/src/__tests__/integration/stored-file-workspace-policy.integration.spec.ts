import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Hyper Workspace Phase 3, Parts 5–7. stored_file's RLS is decoupled from every physical business table: the boundary is
 * the file's own organisation_id and workspace_id. Real Postgres. Reads go through rab_app with the caller's real context.
 * Seeding goes through the owner, bound to the file's own organisation and workspace.
 */
const RUN = Boolean(process.env.DATABASE_URL);

/** Plain stored_file insert, RETURNING id. Called inside a transaction that already binds the row's own organisation. */
function insertFile(
  m: EntityManager,
  organisationId: string,
  row: { kind: string; ws: string | null; resourceType: string; resourceId: string; createdBy: string },
): Promise<Array<{ id: string }>> {
  return m.query(
    `INSERT INTO core.stored_file (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, object_key, original_filename, mime_type, size_bytes, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'LOCAL', $6, 'f.bin', 'application/octet-stream', 10, 'PENDING', $7) RETURNING id`,
    [organisationId, row.ws, row.kind, row.resourceType, row.resourceId, `obj/${randomUUID()}`, row.createdBy],
  );
}
(RUN ? describe : describe.skip)('stored_file workspace policy (integration)', () => {
  let app: INestApplication;
  let appDs: DataSource;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;

  let org: { id: string };
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let venueA: TestIdentity;
  let venueB: TestIdentity;
  let staffA: TestIdentity;
  let wsA: string;
  let wsB: string;

  let reportFileA: string;
  let reportFileB: string;
  let avatarOfA: string;
  let orgLogo: string;
  let nullWorkspaceOther: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    appDs = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({ app, dataSource: appDs, adminDataSource: owner, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'spol' });
    org = seeded.organisation;
    managerA = seeded.managers[0]!;
    managerB = seeded.managers[1]!;
    wsA = managerA.workspaceId!;
    wsB = managerB.workspaceId!;
    staffA = await factory.createStaff(org, { owner: managerA, label: 'spolStaff' });
    venueA = await factory.createVenueManager(org, { owner: managerA, label: 'spolVmA' });
    venueB = await factory.createVenueManager(org, { owner: managerB, label: 'spolVmB' });

    // Each row is inserted with the org AND workspace bound to the row's own values, as the production writers do.
    const seed = async (ws: string | null, row: { kind: string; resourceType: string; resourceId: string; createdBy: string }) => {
      return owner.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [org.id, ws ?? '', row.createdBy]);
        const [{ id }] = await insertFile(m, org.id, { ...row, ws });
        return id as string;
      });
    };
    reportFileA = await seed(wsA, { kind: 'FINAL_TIMESHEET_PDF', resourceType: 'shift_report', resourceId: randomUUID(), createdBy: managerA.userId });
    reportFileB = await seed(wsB, { kind: 'FINAL_TIMESHEET_PDF', resourceType: 'shift_report', resourceId: randomUUID(), createdBy: managerB.userId });
    avatarOfA = await seed(null, { kind: 'PROFILE_IMAGE', resourceType: 'user', resourceId: managerA.userId, createdBy: managerA.userId });
    orgLogo = await seed(null, { kind: 'ORGANISATION_LOGO', resourceType: 'organisation', resourceId: org.id, createdBy: managerA.userId });
    // The new policy refuses writing this row (a NULL-workspace shift-report file is not a category anyone may create).
    // It stands for LEGACY data, so plant it directly inside one transaction that disables RLS and restores it before commit.
    nullWorkspaceOther = await owner.transaction(async (m) => {
      await m.query(`ALTER TABLE core.stored_file DISABLE ROW LEVEL SECURITY`);
      const [{ id }] = await insertFile(m, org.id, { kind: 'FINAL_TIMESHEET_PDF', ws: null, resourceType: 'shift_report', resourceId: randomUUID(), createdBy: managerA.userId });
      await m.query(`ALTER TABLE core.stored_file ENABLE ROW LEVEL SECURITY`);
      await m.query(`ALTER TABLE core.stored_file FORCE ROW LEVEL SECURITY`);
      return id;
    });
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
  });

  /** Runs a read as rab_app with the identity's real organisation, workspace and user bound. */
  async function visibleTo(identity: { userId: string; workspaceId: string | null }, ids: string[]): Promise<string[]> {
    return appDs.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [org.id, identity.workspaceId ?? '', identity.userId]);
      const rows = await m.query(`SELECT id FROM core.stored_file WHERE id = ANY($1::uuid[])`, [ids]);
      return rows.map((r: { id: string }) => r.id);
    });
  }

  it('Manager A reads a permitted Workspace A report file', async () => {
    expect(await visibleTo({ userId: managerA.userId, workspaceId: wsA }, [reportFileA])).toEqual([reportFileA]);
  });

  it('Manager A cannot read a Workspace B report file', async () => {
    expect(await visibleTo({ userId: managerA.userId, workspaceId: wsA }, [reportFileB])).toEqual([]);
  });

  it('Venue Manager A can read Workspace A report rows (venue scope is enforced by ReportFilePolicy, not here)', async () => {
    expect(await visibleTo({ userId: venueA.userId, workspaceId: wsA }, [reportFileA])).toEqual([reportFileA]);
  });

  it('Venue Manager B cannot read a Workspace A report file', async () => {
    expect(await visibleTo({ userId: venueB.userId, workspaceId: wsB }, [reportFileA])).toEqual([]);
  });

  it('Staff A cannot read a Workspace B report file', async () => {
    expect(await visibleTo({ userId: staffA.userId, workspaceId: wsA }, [reportFileB])).toEqual([]);
    expect(await visibleTo({ userId: staffA.userId, workspaceId: wsA }, [reportFileA])).toEqual([reportFileA]);
  });

  it('a NULL-workspace PROFILE_IMAGE of a user (the justified org-global category) is visible inside the organisation', async () => {
    expect(await visibleTo({ userId: managerB.userId, workspaceId: wsB }, [avatarOfA])).toEqual([avatarOfA]);
  });

  it('a NULL-workspace ORGANISATION_LOGO (the justified org-global category) is visible inside the organisation', async () => {
    expect(await visibleTo({ userId: staffA.userId, workspaceId: wsA }, [orgLogo])).toEqual([orgLogo]);
  });

  it('a NULL-workspace file of any OTHER kind is invisible, even to members of the same organisation (no NULL = everyone)', async () => {
    expect(await visibleTo({ userId: managerB.userId, workspaceId: wsB }, [nullWorkspaceOther])).toEqual([]);
    expect(await visibleTo({ userId: managerA.userId, workspaceId: wsA }, [nullWorkspaceOther])).toEqual([]);
  });

  it('a forged workspace_id cannot be written across workspaces: an insert naming Workspace B from Workspace A is refused by RLS', async () => {
    await expect(
      appDs.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [org.id, wsA, managerA.userId]);
        await insertFile(m, org.id, { kind: 'FINAL_TIMESHEET_PDF', ws: wsB, resourceType: 'shift_report', resourceId: randomUUID(), createdBy: managerA.userId });
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a forged organisation_id cannot be written: an insert into another organisation is refused by RLS', async () => {
    const other = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'spolX' });
    await expect(
      appDs.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [org.id, wsA, managerA.userId]);
        await m.query(
          `INSERT INTO core.stored_file (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, object_key, original_filename, mime_type, size_bytes, status, created_by)
           VALUES ($1, $2, 'FINAL_TIMESHEET_PDF', 'shift_report', $3, 'LOCAL', $4, 'f.bin', 'application/octet-stream', 1, 'PENDING', $5)`,
          [other.organisation.id, wsA, randomUUID(), `obj/${randomUUID()}`, managerA.userId],
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a query with NO tenant context bound returns zero stored_file rows (fail closed)', async () => {
    const rows = await appDs.transaction(async (m) => m.query(`SELECT id FROM core.stored_file WHERE id = ANY($1::uuid[])`, [[reportFileA, avatarOfA, orgLogo]]));
    expect(rows).toEqual([]);
  });

  it('the stored_file SELECT policy no longer references core.shift_report (no physical business table in generic RLS)', async () => {
    const [{ qual, with_check }] = await owner.query(
      `SELECT qual, with_check FROM pg_policies WHERE schemaname = 'core' AND tablename = 'stored_file' AND policyname = 'stored_file_tenant'`,
    );
    expect(String(qual)).not.toMatch(/shift_report/i);
    expect(String(with_check)).not.toMatch(/shift_report/i);
  });

  it('the object key does not grant authorization: a stored_file row another workspace owns is not readable through its key', async () => {
    // Authorisation is the row, not the storage path. Reading the row by its object_key as Manager A still returns nothing for B's file.
    const [{ object_key }] = await owner.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [org.id, wsB]);
      return m.query(`SELECT object_key FROM core.stored_file WHERE id = $1`, [reportFileB]);
    });
    const rows = await appDs.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [org.id, wsA, managerA.userId]);
      return m.query(`SELECT id FROM core.stored_file WHERE object_key = $1`, [object_key]);
    });
    expect(rows).toEqual([]);
  });
});
