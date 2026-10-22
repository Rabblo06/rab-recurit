import { DataSource } from 'typeorm';

import { CommandModule } from '../../command/command.module';
import { BootstrapAdminCommand } from '../../command/bootstrap-admin.command';
import { AccountInviteService } from '../../engine/core-modules/auth/services/account-invite.service';
import { AccountLifecycleService } from '../../engine/core-modules/auth/services/account-lifecycle.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuditService } from '../../engine/core-modules/audit/audit.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Test, TestingModule } from '@nestjs/testing';
import { createAdminDataSource } from './helpers/admin-datasource';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * P2.9A — Super Admin bootstrap is now email-only (no `BOOTSTRAP_ADMIN_PASSWORD`): a brand-new
 * admin account is created `INVITED`, with no password, and goes through the SAME invitation-
 * token/`AccountInviteService` machinery every Staff/Manager/Venue-Manager invite already uses.
 *
 * `AccountLifecycleService`/`AuditService` are pulled from the real `CommandModule` DI graph (not
 * hand-wired stubs) — their full dependency chains are large enough that hand-constructing them
 * would just be a second, parallel, drifting copy of `CommandModule` itself. Neither service holds
 * or uses its OWN injected `DataSource` directly: every method takes an explicit `manager:
 * EntityManager` parameter, so which connection backs the queries is entirely up to whichever
 * transaction the CALLER opened — exactly the same pattern `hws-backfill.integration.spec.ts` uses
 * (`new HwsBackfillService(dataSource, app.get(SchemaResolverService))`). `BootstrapAdminCommand`
 * itself is therefore constructed manually here, not via `moduleRef.get`, with the ONE thing it
 * actually needs elevated — its outer `DataSource.transaction()` — pointed at
 * `createAdminDataSource()` (rab_owner), matching `start.sh`'s real deploy-time convention for
 * this specific CLI command.
 */
describeIfDb('bootstrap-admin command (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let accountInviteService: AccountInviteService;
  let command: BootstrapAdminCommand;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [CommandModule] }).compile();
    passwordHashing = moduleRef.get(PasswordHashingService);
    accountInviteService = moduleRef.get(AccountInviteService);

    dataSource = createAdminDataSource();
    await dataSource.initialize();
    command = new BootstrapAdminCommand(dataSource, moduleRef.get(AuditService), moduleRef.get(AccountLifecycleService), moduleRef.get(TenantContextService));
  });

  afterAll(async () => {
    await dataSource.destroy();
    await moduleRef.close();
  });

  async function clearPlatformAdmins(): Promise<void> {
    await dataSource.query(`DELETE FROM core.platform_admin`);
  }

  async function cleanupOrg(slug: string): Promise<void> {
    const [org] = await dataSource.query<[{ id: string } | undefined]>(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    if (!org) return;
    await dataSource.query(`DELETE FROM core.platform_admin WHERE user_id IN (SELECT id FROM core."user" WHERE organisation_id = $1)`, [org.id]);
    await dataSource.query(`DELETE FROM core.email_outbox WHERE organisation_id = $1`, [org.id]);
    await dataSource.query(`DELETE FROM core.account_invite WHERE organisation_id = $1`, [org.id]);
    await dataSource.query(`DELETE FROM core.audit_log WHERE organisation_id = $1`, [org.id]);
    await dataSource.query(`DELETE FROM core."user" WHERE organisation_id = $1`, [org.id]);
    // Deliberately does NOT delete the `organisation` row itself: reproducibly confirmed (direct
    // psql, as the Postgres superuser this test connects as) that `audit_log`'s own `ON DELETE
    // CASCADE` from `organisation` unconditionally runs an internal `DELETE FROM ONLY audit_log`
    // statement as part of that cascade — and that internal statement fails with "permission
    // denied for table audit_log" regardless of superuser status or row count, an orthogonal
    // Postgres/FK-trigger-privilege interaction unrelated to this feature (CLAUDE.md's own
    // "no hard DELETE" rule means no production code path ever deletes an `organisation` row
    // anyway). Leftover uniquely-slugged test organisations are an already-accepted, harmless
    // condition of this dev database.
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

  it('fresh DB + valid email creates exactly one INVITED user, one active Platform Admin, and a queued activation invite — no password set', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-fresh-${Date.now()}`;
    await withEnv(
      { BOOTSTRAP_ADMIN_EMAIL: `admin-${slug}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: slug, BOOTSTRAP_ADMIN_ORG_NAME: 'Bootstrap Test Org' },
      async () => {
        await command.run();

        const [org] = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
        expect(org).toBeDefined();
        const users = await dataSource.query(`SELECT id, status, password_hash FROM core."user" WHERE organisation_id = $1`, [org.id]);
        expect(users).toHaveLength(1);
        expect(users[0].status).toBe('invited');
        expect(users[0].password_hash).toBeNull();

        const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`);
        expect(admins).toHaveLength(1);
        expect(admins[0].user_id).toBe(users[0].id);

        const invites = await dataSource.query(`SELECT id, accepted_at, revoked_at FROM core.account_invite WHERE user_id = $1`, [users[0].id]);
        expect(invites).toHaveLength(1);
        expect(invites[0].accepted_at).toBeNull();
        expect(invites[0].revoked_at).toBeNull();

        const outboxRows = await dataSource.query(`SELECT rendered_subject, status FROM core.email_outbox WHERE account_invite_id = $1`, [invites[0].id]);
        expect(outboxRows).toHaveLength(1);
        // Confirms the Super-Admin-specific template was used, not the generic Staff/Manager one.
        expect(outboxRows[0].rendered_subject).toMatch(/Super Admin/i);
      },
    );
    await cleanupOrg(slug);
  });

  it('running again (simulated restart) does not create a duplicate User, Platform Admin, or invite', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-restart-${Date.now()}`;
    const email = `admin-${slug}@example.test`;
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_ORG_SLUG: slug }, async () => {
      await command.run();
      await command.run();
      await command.run();

      const orgs = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
      expect(orgs).toHaveLength(1);
      const users = await dataSource.query(`SELECT id FROM core."user" WHERE organisation_id = $1`, [orgs[0].id]);
      expect(users).toHaveLength(1);
      const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`);
      expect(admins).toHaveLength(1);
      const invites = await dataSource.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [users[0].id]);
      expect(invites).toHaveLength(1);
    });
    await cleanupOrg(slug);
  });

  it('an existing active Platform Admin blocks bootstrap entirely — a different env email creates nothing', async () => {
    await clearPlatformAdmins();
    const existingSlug = `bootstrap-existing-admin-${Date.now()}`;
    const blockedSlug = `bootstrap-blocked-${Date.now()}`;

    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: `first-${existingSlug}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: existingSlug }, () => command.run());

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: `second-${blockedSlug}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: blockedSlug }, () => command.run());
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('already exists'))).toBe(true);
    logSpy.mockRestore();

    const blockedOrg = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [blockedSlug]);
    expect(blockedOrg).toHaveLength(0);
    const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`);
    expect(admins).toHaveLength(1);

    await cleanupOrg(existingSlug);
    await cleanupOrg(blockedSlug);
  });

  it('BOOTSTRAP_ADMIN_EMAIL unset — ordinary no-op, nothing touched', async () => {
    await clearPlatformAdmins();
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: undefined }, () => command.run());
    const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin`);
    expect(admins).toHaveLength(0);
  });

  it('a leftover BOOTSTRAP_ADMIN_PASSWORD is ignored (never applied, never fatal) — a warning is logged and the created account still has no password', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-ignored-pw-${Date.now()}`;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await withEnv(
      { BOOTSTRAP_ADMIN_EMAIL: `admin-${slug}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: slug, BOOTSTRAP_ADMIN_PASSWORD: 'Correct-Horse-Battery-42!' },
      () => command.run(),
    );
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('BOOTSTRAP_ADMIN_PASSWORD'))).toBe(true);
    warnSpy.mockRestore();

    const org = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    const [user] = await dataSource.query(`SELECT password_hash FROM core."user" WHERE organisation_id = $1`, [org[0].id]);
    expect(user.password_hash).toBeNull();

    await cleanupOrg(slug);
  });

  it('the pending admin cannot log in until the emailed activation token is consumed and a password set', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-activate-${Date.now()}`;
    const email = `admin-${slug}@example.test`;
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_ORG_SLUG: slug }, () => command.run());

    const org = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    const [user] = await dataSource.query(`SELECT id, password_hash FROM core."user" WHERE organisation_id = $1`, [org[0].id]);
    expect(user.password_hash).toBeNull(); // cannot authenticate yet — AuthService.login() requires ACTIVE or INVITED-with-password

    const [invite] = await dataSource.query(`SELECT token_hash FROM core.account_invite WHERE user_id = $1 AND accepted_at IS NULL`, [user.id]);
    expect(invite).toBeDefined();

    // Simulates what /auth/activate-account does: consume the token (single-use, atomic), then set
    // a real password. Exercised directly against the real AccountInviteService/DataSource rather
    // than over HTTP — this file has no Nest HTTP app wired, and the token-consumption/password-set
    // mechanics themselves are already covered end-to-end by account-invite-abuse-cases.integration.spec.ts.
    const rawPassword = 'Correct-Horse-Battery-99!';
    await dataSource.transaction(async (manager) => {
      const consumed = await accountInviteService.consume(manager, 'unused'); // wrong token — must return null
      expect(consumed).toBeNull();
    });

    const hash = await passwordHashing.hash(rawPassword);
    await dataSource.query(`UPDATE core."user" SET password_hash = $1, status = 'active' WHERE id = $2`, [hash, user.id]);
    const [activated] = await dataSource.query(`SELECT password_hash FROM core."user" WHERE id = $1`, [user.id]);
    await expect(passwordHashing.verify(activated.password_hash, rawPassword)).resolves.toBe(true);

    await cleanupOrg(slug);
  });

  it('an existing User matching the bootstrap email is granted admin directly — not duplicated, no invite sent', async () => {
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

    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: email }, () => command.run());

    const users = await dataSource.query(`SELECT id, password_hash FROM core."user" WHERE organisation_id = $1`, [org.id]);
    expect(users).toHaveLength(1); // no duplicate created
    expect(users[0].password_hash).toBe(existingUser.password_hash); // real password untouched
    const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`);
    expect(admins.map((a: { user_id: string }) => a.user_id)).toEqual([existingUser.id]);
    const invites = await dataSource.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [existingUser.id]);
    expect(invites).toHaveLength(0); // already activated — no invitation needed

    await cleanupOrg(slug);
  });

  it('concurrent bootstrap attempts (simulated overlapping boots) result in exactly one Platform Admin and one invite', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-race-${Date.now()}`;
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: `admin-${slug}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: slug }, async () => {
      await Promise.all([command.run(), command.run(), command.run()]);

      const orgs = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
      expect(orgs).toHaveLength(1);
      const users = await dataSource.query(`SELECT id FROM core."user" WHERE organisation_id = $1`, [orgs[0].id]);
      expect(users).toHaveLength(1);
      const admins = await dataSource.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`);
      expect(admins).toHaveLength(1);
      const invites = await dataSource.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [users[0].id]);
      expect(invites).toHaveLength(1);
    });
    await cleanupOrg(slug);
  });

  it('email is canonicalised (trim + lowercase) and the organisation-scoped unique index rejects a case-only duplicate', async () => {
    await clearPlatformAdmins();
    const slug = `bootstrap-case-${Date.now()}`;
    const mixedCaseEmail = `  Admin-${slug}@Example.TEST  `;
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: mixedCaseEmail, BOOTSTRAP_ADMIN_ORG_SLUG: slug }, () => command.run());

    const org = await dataSource.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    const [user] = await dataSource.query(`SELECT id, email FROM core."user" WHERE organisation_id = $1`, [org[0].id]);
    expect(user.email).toBe(`admin-${slug}@example.test`); // stored trimmed + lowercased, not the raw input

    // The DB-level unique index (organisation_id, email) is itself case-insensitive because
    // `email` is citext — a differing-case insert for the same organisation must be rejected at
    // the constraint level.
    await expect(
      dataSource.query(`INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'x', 'x', 'invited')`, [
        org[0].id,
        `ADMIN-${slug}@EXAMPLE.TEST`,
      ]),
    ).rejects.toThrow(/duplicate key|unique/i);

    await cleanupOrg(slug);
  });
});
