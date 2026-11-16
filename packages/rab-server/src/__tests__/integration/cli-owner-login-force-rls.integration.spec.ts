import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CommandModule } from '../../command/command.module';
import { GrantPlatformAdminCommand } from '../../command/grant-platform-admin.command';
import { SeedCommand } from '../../command/seed.command';
import { StorageMigrateLocalCommand } from '../../command/storage-migrate-local.command';
import { AuditAction } from '../../engine/core-modules/audit/audit.service';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';

const describeIfDb = integrationTestDatabaseReady() ? describe : describe.skip;

/** Smallest buffer the image sniffer accepts as PNG (signature + an IHDR chunk header). */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01]);

/**
 * O-2 (docs/plans/untangle/server-database.md): every CLI command connects as the owner login crewflow_owner (main.ts boot
 * gate 1), and since M-T1 (PreAuthTablesForceOwnerOnly1786721400000) core."user", core.organisation, core.platform_admin and
 * core.manager_workspace are FORCE ROW LEVEL SECURITY with an owner-only definer policy. A session that merely INHERITS
 * rab_secure_owner sees zero rows there without a tenant context, and the platform_admin write policy additionally demands
 * an acting platform admin. These commands read those tables with no tenant context, so on the real login they refused or
 * did nothing.
 *
 * Each command is taken from the real CommandModule DI graph, so it runs on the same DataSource the CLI uses (DATABASE_URL,
 * routed by the test guard to TEST_DATABASE_URL = crewflow_owner); the first test asserts that identity, so the suite can
 * never pass vacuously on a superuser or BYPASSRLS login. The superuser fixture connection is used only to create and
 * inspect rows.
 */
describeIfDb('CLI commands on the owner login under M-T1 FORCE RLS (O-2)', () => {
  let moduleRef: TestingModule;
  let runtime: DataSource;
  let admin: DataSource;
  let grant: GrantPlatformAdminCommand;
  let seed: SeedCommand;
  let migrateLocal: StorageMigrateLocalCommand;
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  const createdUserIds: string[] = [];
  const tempDirs: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [CommandModule] }).compile();
    runtime = moduleRef.get(DataSource);
    grant = moduleRef.get(GrantPlatformAdminCommand);
    seed = moduleRef.get(SeedCommand);
    migrateLocal = moduleRef.get(StorageMigrateLocalCommand);
    admin = createAdminDataSource();
    await admin.initialize();
  });

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (createdUserIds.length) await admin.query(`DELETE FROM core.platform_admin WHERE user_id = ANY($1::uuid[])`, [createdUserIds]);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    await admin.destroy();
    await moduleRef.close();
  });

  async function seedOrgUser(label: string): Promise<{ organisationId: string; slug: string; userId: string; email: string }> {
    const slug = `o2-${label}-${randomUUID().slice(0, 8)}`;
    const email = `${slug}@example.test`;
    const [org] = await admin.query(`INSERT INTO core.organisation (name, slug) VALUES ($1, $2) RETURNING id`, [slug, slug]);
    const [user] = await admin.query(
      `INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'O2', 'Probe', 'active') RETURNING id`,
      [org.id, email],
    );
    createdUserIds.push(user.id);
    return { organisationId: org.id, slug, userId: user.id, email };
  }

  function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const prev: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(vars)) {
      prev[key] = process.env[key];
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

  it('the commands run on the owner login crewflow_owner: not superuser, not BYPASSRLS, acting as itself', async () => {
    const [who] = await runtime.query(
      `SELECT current_user AS acting, session_user AS login, r.rolsuper AS su, r.rolbypassrls AS bypass
         FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
    );
    expect(who).toEqual({ acting: 'crewflow_owner', login: 'crewflow_owner', su: false, bypass: false });
    // The precondition O-2 is about: with no tenant context this login sees no row of the FORCE'd pre-auth tables.
    const [{ n }] = await runtime.query(`SELECT count(*)::int AS n FROM core.organisation`);
    expect(n).toBe(0);
  });

  describe('grant-platform-admin', () => {
    it('grants an existing user: one active platform_admin row, granted_by NULL, and the audit entry', async () => {
      const target = await seedOrgUser('grant');
      await grant.run([], { email: target.email });

      expect(exitSpy).not.toHaveBeenCalled();
      expect(await admin.query(`SELECT revoked_at, granted_by FROM core.platform_admin WHERE user_id = $1`, [target.userId])).toEqual([
        { revoked_at: null, granted_by: null },
      ]);
      const audit = await admin.query(`SELECT actor_user_id, metadata FROM core.audit_log WHERE target_user_id = $1 AND action = $2`, [
        target.userId,
        AuditAction.PLATFORM_ADMIN_GRANTED,
      ]);
      expect(audit).toEqual([{ actor_user_id: null, metadata: { via: 'bootstrap_cli' } }]);
    });

    it('a second run sees the active grant and changes nothing', async () => {
      const target = await seedOrgUser('grant-again');
      await grant.run([], { email: target.email });
      const [before] = await admin.query(`SELECT granted_at, security_version FROM core.platform_admin WHERE user_id = $1`, [target.userId]);
      await grant.run([], { email: target.email, org: target.slug });
      const [after] = await admin.query(`SELECT granted_at, security_version FROM core.platform_admin WHERE user_id = $1`, [target.userId]);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(after).toEqual(before);
    });

    it('re-grants a revoked admin', async () => {
      const target = await seedOrgUser('regrant');
      await grant.run([], { email: target.email });
      await admin.query(`UPDATE core.platform_admin SET revoked_at = now(), security_version = security_version + 1 WHERE user_id = $1`, [target.userId]);
      await grant.run([], { email: target.email });
      expect(exitSpy).not.toHaveBeenCalled();
      expect(await admin.query(`SELECT revoked_at FROM core.platform_admin WHERE user_id = $1`, [target.userId])).toEqual([{ revoked_at: null }]);
    });

    it('abuse case: --org naming a different organisation refuses (exit 1) and writes nothing', async () => {
      const target = await seedOrgUser('grant-wrong-org');
      const other = await seedOrgUser('grant-other-org');
      await expect(grant.run([], { email: target.email, org: other.slug })).rejects.toThrow('process.exit(1)');
      expect(errorSpy.mock.calls.flat().join('\n')).toMatch(/No active user found/);
      expect(await admin.query(`SELECT 1 FROM core.platform_admin WHERE user_id = $1`, [target.userId])).toHaveLength(0);
    });

    it('abuse case: a soft-deleted user is never granted', async () => {
      const target = await seedOrgUser('grant-deleted');
      await admin.query(`UPDATE core."user" SET deleted_at = now() WHERE id = $1`, [target.userId]);
      await expect(grant.run([], { email: target.email })).rejects.toThrow('process.exit(1)');
      expect(await admin.query(`SELECT 1 FROM core.platform_admin WHERE user_id = $1`, [target.userId])).toHaveLength(0);
    });

    it('after the command the pooled connection acts as the login again (no role left behind)', async () => {
      const target = await seedOrgUser('grant-role-reset');
      await grant.run([], { email: target.email });
      const [who] = await runtime.query(`SELECT current_user AS acting`);
      expect(who.acting).toBe('crewflow_owner');
    });
  });

  describe('seed', () => {
    it('creates the organisation, the administrator and the platform admin, and a second run is idempotent', async () => {
      const slug = `o2-seed-${randomUUID().slice(0, 8)}`;
      const email = `${slug}@example.test`;
      await withEnv({ SEED_ORG_SLUG: slug, SEED_ORG_NAME: 'O2 Seed', SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: generateFixturePassword() }, async () => {
        await seed.run();
        await seed.run();
      });

      const orgs = await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
      expect(orgs).toHaveLength(1);
      const users = await admin.query(`SELECT id FROM core."user" WHERE organisation_id = $1`, [orgs[0].id]);
      expect(users).toHaveLength(1);
      createdUserIds.push(users[0].id);
      expect(await admin.query(`SELECT revoked_at FROM core.platform_admin WHERE user_id = $1`, [users[0].id])).toEqual([{ revoked_at: null }]);
      expect(await admin.query(`SELECT 1 FROM core.user_role WHERE user_id = $1`, [users[0].id])).toHaveLength(1);
    });
  });

  describe('storage:migrate-local', () => {
    it('dry run discovers legacy keys across tenants, classifies them, and changes nothing', async () => {
      const tenant = await seedOrgUser('migrate');
      const avatarKey = `org/${tenant.organisationId}/avatars/${randomUUID()}.png`;
      const logoKey = `org/${tenant.organisationId}/logos/${randomUUID()}.png`;
      await admin.query(`UPDATE core."user" SET avatar_key = $1 WHERE id = $2`, [avatarKey, tenant.userId]);
      await admin.query(`UPDATE core.organisation SET logo_key = $1 WHERE id = $2`, [logoKey, tenant.organisationId]);

      const root = mkdtempSync(join(tmpdir(), 'o2-migrate-local-'));
      tempDirs.push(root);
      mkdirSync(dirname(join(root, avatarKey)), { recursive: true });
      writeFileSync(join(root, avatarKey), PNG_BYTES);
      const reportFile = join(root, 'report.json');

      await migrateLocal.run([], { source: root, reportFile });

      const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { mode: string; results: Array<{ table: string; rowId: string; outcome: string }> };
      expect(report.mode).toBe('DRY-RUN');
      const mine = report.results.filter((r) => r.rowId === tenant.userId || r.rowId === tenant.organisationId);
      expect(mine).toEqual(
        expect.arrayContaining([
          { table: 'user', rowId: tenant.userId, outcome: 'would_migrate' },
          { table: 'organisation', rowId: tenant.organisationId, outcome: 'source_missing' },
        ]),
      );
      expect(mine).toHaveLength(2);
      expect(await admin.query(`SELECT avatar_key, avatar_file_id FROM core."user" WHERE id = $1`, [tenant.userId])).toEqual([
        { avatar_key: avatarKey, avatar_file_id: null },
      ]);
    });
  });
});
