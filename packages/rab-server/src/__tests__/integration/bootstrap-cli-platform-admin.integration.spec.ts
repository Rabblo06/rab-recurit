import 'reflect-metadata';
import { UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, User } from '../../modules/identity/entities';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Stage 2A final verification, item 4 — the bootstrap CLI's `--org` flag
 * (`grant-platform-admin.command.ts`).
 *
 * Read directly from the command's own source (quoted in the Stage 2A
 * addendum): `--org` is used ONLY to filter the disambiguation SELECT that
 * resolves an email to a single `core.user` row — necessary because
 * `core."user"`'s own uniqueness constraint is `(organisation_id, email)`,
 * not email alone, so the same address can legitimately belong to two
 * different people in two different organisations. Once that SELECT
 * resolves a single `target.id`, `--org` is never referenced again — the
 * actual grant is `INSERT INTO core.platform_admin (user_id, granted_by)
 * VALUES ($1, NULL)`, and `core.platform_admin` (confirmed via its own
 * entity, `platform-admin.entity.ts`) has NO `organisation_id`/
 * `workspace_id` column at all. There is structurally no column for an
 * organisation-scoped grant to be written into.
 *
 * This file can't invoke the real `GrantPlatformAdminCommand` class
 * directly in this shared test run — that class's own module
 * (`CommandModule`) reads `coreDataSourceOptions.url` from
 * `process.env.DATABASE_URL` at import time, and this suite's `DATABASE_URL`
 * is already pinned to `rab_app` for the whole `--runInBand` run (the
 * command is meant to be invoked with `DATABASE_URL` pointed at `rab_owner`
 * instead — a different, deliberately separate real-world invocation, see
 * the command's own docstring). Instead, this file empirically replays the
 * command's exact SQL (the disambiguation SELECT, then the INSERT) via
 * `adminDataSource` (already connected as `rab_owner`, the same role the
 * real CLI uses) against two real users who share one email across two
 * different organisations, and then proves the resulting grant carries no
 * organisation dimension whatsoever — at the schema level, the function
 * level, and the behavioral level.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('bootstrap CLI --org flag — no authorization/privilege semantics (Stage 2A final verification)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';
  const sharedEmail = `shared-${randomUUID()}@example.test`;

  async function seedOrgWithUser(email: string): Promise<{ organisation: Organisation; userId: string }> {
    const slug = `test-${randomUUID()}`;
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, { id: orgInsert.identifiers[0]!.id as string });

    let userId!: string;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (m) => {
      const passwordHash = await passwordHashing.hash(password);
      const userResult = await m.insert(User, {
        organisationId: organisation.id,
        email,
        passwordHash,
        firstName: 'Bootstrap',
        lastName: 'Test',
        status: UserStatus.ACTIVE,
      });
      userId = userResult.identifiers[0]!.id as string;
    });
    return { organisation, userId };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('core.platform_admin has no organisation_id/workspace_id column — structurally cannot hold an org-scoped grant', async () => {
    const columns = await adminDataSource.manager.query<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'core' AND table_name = 'platform_admin'`,
    );
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('organisation_id');
    expect(names).not.toContain('workspace_id');
    expect(names.sort()).toEqual(['granted_at', 'granted_by', 'revoked_at', 'revoked_by', 'user_id'].sort());
  });

  it('core.is_active_platform_admin() takes a single user id and no organisation parameter — the check itself cannot be scoped by org', async () => {
    const params = await adminDataSource.manager.query<Array<{ parameter_name: string | null; data_type: string }>>(
      `SELECT parameter_name, data_type FROM information_schema.parameters
        WHERE specific_schema = 'core' AND specific_name IN (
          SELECT specific_name FROM information_schema.routines WHERE routine_schema = 'core' AND routine_name = 'is_active_platform_admin'
        )
        ORDER BY ordinal_position`,
    );
    expect(params).toHaveLength(1);
    expect(params[0].data_type).toBe('uuid');
  });

  it('--org disambiguates the email lookup only: two users share one email across two orgs, and the grant targets exactly the disambiguated user_id, never the other', async () => {
    const orgA = await seedOrgWithUser(sharedEmail);
    const orgB = await seedOrgWithUser(sharedEmail);
    expect(orgA.userId).not.toBe(orgB.userId); // same email, genuinely two different people/rows

    // Replays the command's own disambiguation SELECT exactly, filtered to
    // orgA's slug — the real CLI's `--org <slug>` behavior.
    const resolved = await adminDataSource.manager.query<Array<{ id: string }>>(
      `SELECT u.id FROM core."user" u JOIN core.organisation o ON o.id = u.organisation_id
        WHERE u.email = $1 AND u.deleted_at IS NULL AND o.slug = $2`,
      [sharedEmail, orgA.organisation.slug],
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe(orgA.userId);

    // Without --org, the same lookup is genuinely ambiguous — the real
    // command fails closed here (process.exit(1)) rather than guessing.
    const ambiguous = await adminDataSource.manager.query<Array<{ id: string }>>(
      `SELECT u.id FROM core."user" u JOIN core.organisation o ON o.id = u.organisation_id WHERE u.email = $1 AND u.deleted_at IS NULL`,
      [sharedEmail],
    );
    expect(ambiguous.length).toBe(2);

    // The command's actual grant statement — no organisation_id anywhere in it.
    await adminDataSource.manager.query(
      `INSERT INTO core.platform_admin (user_id, granted_by) VALUES ($1, NULL)
         ON CONFLICT (user_id) DO UPDATE SET granted_at = now(), granted_by = NULL, revoked_at = NULL, revoked_by = NULL`,
      [orgA.userId],
    );

    const grantedA = await adminDataSource.manager.query<Array<{ ok: boolean }>>(`SELECT core.is_active_platform_admin($1) AS ok`, [orgA.userId]);
    const grantedB = await adminDataSource.manager.query<Array<{ ok: boolean }>>(`SELECT core.is_active_platform_admin($1) AS ok`, [orgB.userId]);
    expect(grantedA[0].ok).toBe(true);
    expect(grantedB[0].ok).toBe(false); // the same-email user in the OTHER org is untouched — --org selected a person, not an org-wide grant

    // The grant is genuinely global, not confined to reads run "within" orgA
    // — checked with zero tenant context bound, still resolves true, since
    // `is_active_platform_admin` never consults core.current_org() at all.
    const globalCheck = await adminDataSource.manager.query<Array<{ ok: boolean }>>(`SELECT core.is_active_platform_admin($1) AS ok`, [orgA.userId]);
    expect(globalCheck[0].ok).toBe(true);
  });

  it('a query with no tenant context bound over rab_app still returns zero rows from platform_admin — the pre-auth NOT-FORCE exemption never leaks it to an unauthenticated caller', async () => {
    const rows = await dataSource.manager.query(`SELECT 1 FROM core.platform_admin LIMIT 1`);
    expect(rows).toHaveLength(0);
  });
});
