import { DataSource } from 'typeorm';

import { BootstrapAdminCommand } from '../../command/bootstrap-admin.command';
import { AuditService } from '../../engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('bootstrap-admin command (integration)', () => {
  let dataSource: DataSource;
  let passwordHashing: PasswordHashingService;

  beforeAll(async () => {
    dataSource = createAdminDataSource();
    await dataSource.initialize();
    passwordHashing = new PasswordHashingService();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  function newCommand(): BootstrapAdminCommand {
    return new BootstrapAdminCommand(dataSource, new AuditService(new TenantContextService(dataSource)), passwordHashing);
  }

  async function clearPlatformAdmins(): Promise<void> {
    await dataSource.query(`DELETE FROM core.platform_admin`);
  }

  async function cleanupOrg(slug: string): Promise<void> {
    const [org] = await dataSource.query<[{ id: string } | undefined]>(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    if (!org) return;
    await dataSource.query(`DELETE FROM core.platform_admin WHERE user_id IN (SELECT id FROM core."user" WHERE organisation_id = $1)`, [org.id]);
    await dataSource.query(`DELETE FROM core."user" WHERE organisation_id = $1`, [org.id]);
    await dataSource.query(`DELETE FROM core.organisation WHERE id = $1`, [org.id]);
  }

  function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
    const prev: Record<string, string | undefined> = {};
    for (const key of Object.keys(vars)) prev[key] = process.env[key];
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn().finally(() => {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }

  it('fresh DB + valid env creates exactly one User and one active Platform Admin', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-fresh-${Date.now()}`;
    await withEnv(
      {
        BOOTSTRAP_ADMIN_EMAIL: `admin-${slug}@example.test`,
        BOOTSTRAP_ADMIN_PASSWORD: 'Correct-Horse-Battery-42!',
        BOOTSTRAP_ADMIN_ORG_SLUG: slug,
        BOOTSTRAP_ADMIN_ORG_NAME: 'Bootstrap Test Org',
      },
      async () => {
        await newCommand().run();

        const [org] = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
        expect(org).toBeDefined();
        const users = await dataSource.query(`SELECT id, status, must_reset_password FROM core."user" WHERE organisation_id = $1`, [org.id]);
        expect(users).toHaveLength(1);
        expect(users[0].status).toBe('active');
        const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`);
        expect(admins).toHaveLength(1);
        expect(admins[0].user_id).toBe(users[0].id);
      },
    );
    await cleanupOrg(slug);
  });

  it('running again (simulated restart) does not create a duplicate User or Platform Admin', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-restart-${Date.now()}`;
    const email = `admin-${slug}@example.test`;
    await withEnv(
      { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: 'Correct-Horse-Battery-42!', BOOTSTRAP_ADMIN_ORG_SLUG: slug },
      async () => {
        await newCommand().run();
        await newCommand().run();
        await newCommand().run();

        const orgs = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
        expect(orgs).toHaveLength(1);
        const users = await dataSource.query(`SELECT id FROM core."user" WHERE organisation_id = $1`, [orgs[0].id]);
        expect(users).toHaveLength(1);
        const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`);
        expect(admins).toHaveLength(1);
      },
    );
    await cleanupOrg(slug);
  });

  it('an existing active Platform Admin blocks bootstrap entirely — a different env email creates nothing', async () => {
    await clearPlatformAdmins();
    const existingSlug = `bootstrap-existing-admin-${Date.now()}`;
    const blockedSlug = `bootstrap-blocked-${Date.now()}`;

    await withEnv(
      { BOOTSTRAP_ADMIN_EMAIL: `first-${existingSlug}@example.test`, BOOTSTRAP_ADMIN_PASSWORD: 'Correct-Horse-Battery-42!', BOOTSTRAP_ADMIN_ORG_SLUG: existingSlug },
      () => newCommand().run(),
    );

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await withEnv(
      { BOOTSTRAP_ADMIN_EMAIL: `second-${blockedSlug}@example.test`, BOOTSTRAP_ADMIN_PASSWORD: 'Correct-Horse-Battery-42!', BOOTSTRAP_ADMIN_ORG_SLUG: blockedSlug },
      () => newCommand().run(),
    );
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('already exists'))).toBe(true);
    logSpy.mockRestore();

    const blockedOrg = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [blockedSlug]);
    expect(blockedOrg).toHaveLength(0);
    const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`);
    expect(admins).toHaveLength(1);

    await cleanupOrg(existingSlug);
    await cleanupOrg(blockedSlug);
  });

  it('no bootstrap env vars set — ordinary no-op, nothing touched', async () => {
    await clearPlatformAdmins();
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: undefined, BOOTSTRAP_ADMIN_PASSWORD: undefined }, () => newCommand().run());
    const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin`);
    expect(admins).toHaveLength(0);
  });

  it('only BOOTSTRAP_ADMIN_EMAIL set — fails startup with a configuration error, creates nothing', async () => {
    await clearPlatformAdmins();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: 'only-email@example.test', BOOTSTRAP_ADMIN_PASSWORD: undefined }, () => newCommand().run());
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('incomplete'))).toBe(true);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin`);
    expect(admins).toHaveLength(0);
  });

  it('only BOOTSTRAP_ADMIN_PASSWORD set — fails startup with a configuration error, creates nothing', async () => {
    await clearPlatformAdmins();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: undefined, BOOTSTRAP_ADMIN_PASSWORD: 'Correct-Horse-Battery-42!' }, () => newCommand().run());
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('incomplete'))).toBe(true);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin`);
    expect(admins).toHaveLength(0);
  });

  it('the raw password never appears in any console output, and is stored as a real argon2id hash', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-hash-${Date.now()}`;
    const rawPassword = 'Correct-Horse-Battery-42!';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await withEnv(
      { BOOTSTRAP_ADMIN_EMAIL: `admin-${slug}@example.test`, BOOTSTRAP_ADMIN_PASSWORD: rawPassword, BOOTSTRAP_ADMIN_ORG_SLUG: slug },
      () => newCommand().run(),
    );

    const allOutput = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join('\n');
    expect(allOutput).not.toContain(rawPassword);
    logSpy.mockRestore();
    errorSpy.mockRestore();

    const org = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    const [user] = await dataSource.query(`SELECT password_hash FROM core."user" WHERE organisation_id = $1`, [org[0].id]);
    expect(user.password_hash).toMatch(/^\$argon2id\$/);
    expect(user.password_hash).not.toBe(rawPassword);
    await expect(passwordHashing.verify(user.password_hash, rawPassword)).resolves.toBe(true);

    await cleanupOrg(slug);
  });

  it('the bootstrapped account can log in normally afterward, and a wrong password fails normally', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-login-${Date.now()}`;
    const rawPassword = 'Correct-Horse-Battery-42!';
    await withEnv(
      { BOOTSTRAP_ADMIN_EMAIL: `admin-${slug}@example.test`, BOOTSTRAP_ADMIN_PASSWORD: rawPassword, BOOTSTRAP_ADMIN_ORG_SLUG: slug },
      () => newCommand().run(),
    );

    const org = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    const [user] = await dataSource.query(`SELECT password_hash FROM core."user" WHERE organisation_id = $1`, [org[0].id]);
    await expect(passwordHashing.verify(user.password_hash, rawPassword)).resolves.toBe(true);
    await expect(passwordHashing.verify(user.password_hash, 'definitely-wrong')).resolves.toBe(false);

    await cleanupOrg(slug);
  });

  it('removing BOOTSTRAP_ADMIN_PASSWORD after creation does not reset or affect the existing account', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-envgone-${Date.now()}`;
    const email = `admin-${slug}@example.test`;
    const rawPassword = 'Correct-Horse-Battery-42!';
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: rawPassword, BOOTSTRAP_ADMIN_ORG_SLUG: slug }, () => newCommand().run());

    const org = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    const [before] = await dataSource.query(`SELECT password_hash FROM core."user" WHERE organisation_id = $1`, [org[0].id]);

    // Second boot with the env vars entirely absent (as recommended post-setup) —
    // an active admin already exists, so this is just the ordinary skip path.
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: undefined, BOOTSTRAP_ADMIN_PASSWORD: undefined }, () => newCommand().run());

    const [after] = await dataSource.query(`SELECT password_hash FROM core."user" WHERE organisation_id = $1`, [org[0].id]);
    expect(after.password_hash).toBe(before.password_hash);

    await cleanupOrg(slug);
  });

  it('an existing User matching the bootstrap email is granted admin, not duplicated', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-existinguser-${Date.now()}`;
    const email = `preexisting-${slug}@example.test`;

    const [org] = await dataSource.query(`INSERT INTO core.organisation (name, slug) VALUES ($1, $2) RETURNING id`, ['Pre-existing Org', slug]);
    const hash = await passwordHashing.hash('their-real-existing-password-1!');
    const [existingUser] = await dataSource.query(
      `INSERT INTO core."user" (organisation_id, email, password_hash, first_name, last_name, status)
       VALUES ($1, $2, $3, 'Existing', 'Person', 'active') RETURNING id, password_hash`,
      [org.id, email, hash],
    );

    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: 'Correct-Horse-Battery-42!' }, () => newCommand().run());

    const users = await dataSource.query(`SELECT id, password_hash FROM core."user" WHERE organisation_id = $1`, [org.id]);
    expect(users).toHaveLength(1); // no duplicate created
    expect(users[0].password_hash).toBe(existingUser.password_hash); // real password untouched by BOOTSTRAP_ADMIN_PASSWORD
    const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`);
    expect(admins.map((a: { user_id: string }) => a.user_id)).toEqual([existingUser.id]);

    await cleanupOrg(slug);
  });

  it('concurrent bootstrap attempts (simulated overlapping boots) result in exactly one Platform Admin', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-race-${Date.now()}`;
    await withEnv(
      { BOOTSTRAP_ADMIN_EMAIL: `admin-${slug}@example.test`, BOOTSTRAP_ADMIN_PASSWORD: 'Correct-Horse-Battery-42!', BOOTSTRAP_ADMIN_ORG_SLUG: slug },
      async () => {
        await Promise.all([newCommand().run(), newCommand().run(), newCommand().run()]);

        const orgs = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
        expect(orgs).toHaveLength(1);
        const users = await dataSource.query(`SELECT id FROM core."user" WHERE organisation_id = $1`, [orgs[0].id]);
        expect(users).toHaveLength(1);
        const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`);
        expect(admins).toHaveLength(1);
      },
    );
    await cleanupOrg(slug);
  });

  it('email is canonicalised (trim + lowercase) and the new organisation-scoped unique index rejects a case-only duplicate', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-case-${Date.now()}`;
    const mixedCaseEmail = `  Admin-${slug}@Example.TEST  `;
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: mixedCaseEmail, BOOTSTRAP_ADMIN_PASSWORD: 'Correct-Horse-Battery-42!', BOOTSTRAP_ADMIN_ORG_SLUG: slug }, () =>
      newCommand().run(),
    );

    const org = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    const [user] = await dataSource.query(`SELECT id, email FROM core."user" WHERE organisation_id = $1`, [org[0].id]);
    expect(user.email).toBe(`admin-${slug}@example.test`); // stored trimmed + lowercased, not the raw input

    // The DB-level unique index (organisation_id, email) is itself
    // case-insensitive because `email` is citext — a differing-case insert
    // for the same organisation must be rejected at the constraint level.
    await expect(
      dataSource.query(`INSERT INTO core."user" (organisation_id, email, password_hash, first_name, last_name, status) VALUES ($1, $2, 'x', 'x', 'x', 'active')`, [
        org[0].id,
        `ADMIN-${slug}@EXAMPLE.TEST`,
      ]),
    ).rejects.toThrow(/duplicate key|unique/i);

    await cleanupOrg(slug);
  });
});
