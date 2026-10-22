import { Test, TestingModule } from '@nestjs/testing';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { DataSource } from 'typeorm';

import { CommandModule } from '../../command/command.module';
import { BootstrapAdminCommand } from '../../command/bootstrap-admin.command';
import { AuditAction, AuditService } from '../../engine/core-modules/audit/audit.service';
import { AccountLifecycleService } from '../../engine/core-modules/auth/services/account-lifecycle.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { coreDataSourceOptions } from '../../database/typeorm/core/core.datasource';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { createAdminDataSource, createCrewflowOwnerProbeDataSource } from './helpers/admin-datasource';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Foundation fix P2 (2026-10-22): the first Platform Admin is created by the `crewflow` operator identity through the
 * narrow `core.bootstrap_first_platform_admin` SECURITY DEFINER function (BootstrapFirstPlatformAdminFunction1786719620000)
 * — no superuser, no manual SQL, no new privilege for `crewflow_app`.
 *
 * `bootstrap-admin.integration.spec.ts` keeps running the command over the superuser fixture connection (the historical
 * convention); THIS suite runs it with `current_user = crewflow` (`-c role=crewflow` on the fixture login, so every
 * privilege and RLS check is crewflow's own) and with the runtime role `crewflow_app`, which must be refused.
 */
describeIfDb('bootstrap-admin as the crewflow identity (integration, P2)', () => {
  let moduleRef: TestingModule;
  let admin: DataSource; // superuser: fixture setup/inspection only
  let crewflow: DataSource; // current_user = crewflow
  let runtime: DataSource; // crewflow_app
  let commandAsCrewflow: BootstrapAdminCommand;
  let commandAsRuntime: BootstrapAdminCommand;
  let passwordHashing: PasswordHashingService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [CommandModule] }).compile();
    passwordHashing = moduleRef.get(PasswordHashingService);
    admin = createAdminDataSource();
    await admin.initialize();
    const { adminUrl } = resolveIntegrationTestDatabase(process.env);
    const base = coreDataSourceOptions as PostgresConnectionOptions;
    crewflow = new DataSource({
      ...base,
      url: adminUrl,
      name: `crewflow-bootstrap-${Math.random().toString(36).slice(2)}`,
      extra: { ...(base.extra as object | undefined), options: '-c search_path=core -c role=crewflow' },
    });
    await crewflow.initialize();
    runtime = createCrewflowOwnerProbeDataSource();
    await runtime.initialize();
    const deps = [moduleRef.get(AuditService), moduleRef.get(AccountLifecycleService), moduleRef.get(TenantContextService)] as const;
    commandAsCrewflow = new BootstrapAdminCommand(crewflow, ...deps);
    commandAsRuntime = new BootstrapAdminCommand(runtime, ...deps);
  });

  afterAll(async () => {
    await crewflow.destroy();
    await runtime.destroy();
    await admin.destroy();
    await moduleRef.close();
  });

  async function clearPlatformAdmins(): Promise<void> {
    await admin.query(`DELETE FROM core.platform_admin`);
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

  it('the connection really is crewflow (not a superuser, no BYPASSRLS) and the runtime role is crewflow_app', async () => {
    const [who] = await crewflow.query(`SELECT current_user AS u, r.rolsuper AS s, r.rolbypassrls AS b FROM pg_roles r WHERE r.rolname = current_user`);
    expect(who).toEqual({ u: 'crewflow', s: false, b: false });
    const [rt] = await runtime.query(`SELECT current_user AS u`);
    expect(rt.u).toBe('crewflow_app');
  });

  it('fresh database: creates exactly one INVITED admin (no password), its operational CEO identity, a queued activation email and the audit entry', async () => {
    await clearPlatformAdmins();
    const slug = `p2-crewflow-fresh-${Date.now()}`;
    const email = `admin-${slug}@example.test`;
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_ORG_SLUG: slug, BOOTSTRAP_ADMIN_ORG_NAME: 'P2 Org' }, () => commandAsCrewflow.run());

    const [org] = await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    const users = await admin.query(`SELECT id, status, password_hash FROM core."user" WHERE organisation_id = $1`, [org.id]);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ status: 'invited', password_hash: null });
    const userId = users[0].id as string;
    expect(await admin.query(`SELECT user_id, granted_by FROM core.platform_admin WHERE revoked_at IS NULL`)).toEqual([{ user_id: userId, granted_by: null }]);
    expect(await admin.query(`SELECT type FROM core.manager_profile WHERE user_id = $1`, [userId])).toEqual([{ type: 'ceo' }]);
    const [invite] = await admin.query(`SELECT id FROM core.account_invite WHERE user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [userId]);
    expect(invite).toBeDefined();
    const outbox = await admin.query(`SELECT job_type, rendered_subject FROM core.email_outbox WHERE account_invite_id = $1`, [invite.id]);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].rendered_subject).toMatch(/Super Admin/i);
    const audit = await admin.query(`SELECT actor_user_id, target_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = $2`, [
      org.id,
      AuditAction.PLATFORM_ADMIN_BOOTSTRAPPED,
    ]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: null, target_user_id: userId, metadata: { via: 'env_bootstrap', pendingActivation: true, createdOrganisation: true } });
  });

  it('idempotent: re-running (restart) and three overlapping runs create no second user, admin, invite or organisation', async () => {
    await clearPlatformAdmins();
    const slug = `p2-crewflow-race-${Date.now()}`;
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: `admin-${slug}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: slug }, async () => {
      await Promise.all([commandAsCrewflow.run(), commandAsCrewflow.run(), commandAsCrewflow.run()]);
      await commandAsCrewflow.run();
    });
    const orgs = await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    expect(orgs).toHaveLength(1);
    const users = await admin.query(`SELECT id FROM core."user" WHERE organisation_id = $1`, [orgs[0].id]);
    expect(users).toHaveLength(1);
    expect(await admin.query(`SELECT user_id FROM core.platform_admin`)).toEqual([{ user_id: users[0].id }]);
    expect(await admin.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [users[0].id])).toHaveLength(1);
    expect(await admin.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [users[0].id])).toHaveLength(1);
  });

  it('an existing admin blocks a second administrator: a different email creates nothing (database answer ALREADY_BOOTSTRAPPED)', async () => {
    await clearPlatformAdmins();
    const first = `p2-crewflow-first-${Date.now()}`;
    const second = `p2-crewflow-second-${Date.now()}`;
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: `admin-${first}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: first }, () => commandAsCrewflow.run());
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: `admin-${second}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: second }, () => commandAsCrewflow.run());
    expect(await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [second])).toHaveLength(0);
    expect(await admin.query(`SELECT user_id FROM core.platform_admin`)).toHaveLength(1);

    // Calling the function directly (no command) cannot mint a second admin either.
    const [direct] = await crewflow.query(`SELECT outcome, created_user FROM core.bootstrap_first_platform_admin($1, 'X', 'Y', $2, NULL)`, [`direct-${second}@example.test`, second]);
    expect(direct).toEqual({ outcome: 'ALREADY_BOOTSTRAPPED', created_user: false });
    expect(await admin.query(`SELECT user_id FROM core.platform_admin`)).toHaveLength(1);
  });

  it('one-time: once every admin has been revoked the bootstrap is CLOSED (fails loudly, changes nothing) — it can never mint a replacement', async () => {
    await clearPlatformAdmins();
    const slug = `p2-crewflow-closed-${Date.now()}`;
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: `admin-${slug}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: slug }, () => commandAsCrewflow.run());
    await admin.query(`UPDATE core.platform_admin SET revoked_at = now(), security_version = security_version + 1`);
    const other = `p2-crewflow-closed-other-${Date.now()}`;
    await expect(withEnv({ BOOTSTRAP_ADMIN_EMAIL: `admin-${other}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: other }, () => commandAsCrewflow.run())).rejects.toThrow(
      /bootstrap is closed/,
    );
    expect(await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [other])).toHaveLength(0);
    expect(await admin.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`)).toHaveLength(0);
  });

  it('an existing active account is granted (no duplicate, no invite, password untouched) and its sessions are reset', async () => {
    await clearPlatformAdmins();
    const slug = `p2-crewflow-existing-${Date.now()}`;
    const email = `existing-${slug}@example.test`;
    const [org] = await admin.query(`INSERT INTO core.organisation (name, slug) VALUES ('P2 existing', $1) RETURNING id`, [slug]);
    const hash = await passwordHashing.hash('an-existing-real-password-1!');
    const [user] = await admin.query(
      `INSERT INTO core."user" (organisation_id, email, password_hash, first_name, last_name, status) VALUES ($1, $2, $3, 'Existing', 'Person', 'active') RETURNING id`,
      [org.id, email, hash],
    );
    await withEnv({ BOOTSTRAP_ADMIN_EMAIL: email }, () => commandAsCrewflow.run());
    expect(await admin.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`)).toEqual([{ user_id: user.id }]);
    expect(await admin.query(`SELECT id FROM core."user" WHERE organisation_id = $1`, [org.id])).toHaveLength(1);
    expect(await admin.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [user.id])).toHaveLength(0);
    const [{ password_hash }] = await admin.query(`SELECT password_hash FROM core."user" WHERE id = $1`, [user.id]);
    expect(password_hash).toBe(hash);
  });

  describe('abuse cases', () => {
    it('the runtime role crewflow_app is refused by the command and by the database, and nothing is created', async () => {
      await clearPlatformAdmins();
      const slug = `p2-runtime-${Date.now()}`;
      await expect(withEnv({ BOOTSTRAP_ADMIN_EMAIL: `admin-${slug}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: slug }, () => commandAsRuntime.run())).rejects.toThrow(
        /"crewflow_app" may not run the bootstrap/,
      );
      await expect(runtime.query(`SELECT * FROM core.bootstrap_first_platform_admin($1, 'A', 'B', $2, NULL)`, [`admin-${slug}@example.test`, slug])).rejects.toMatchObject({
        code: '42501',
      });
      expect(await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug])).toHaveLength(0);
      expect(await admin.query(`SELECT user_id FROM core.platform_admin`)).toHaveLength(0);
    });

    it('crewflow itself still cannot write platform_admin or organisation directly — the narrow function is the only path', async () => {
      await clearPlatformAdmins();
      const [someUser] = await admin.query(`SELECT id FROM core."user" LIMIT 1`);
      await expect(crewflow.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1)`, [someUser.id])).rejects.toMatchObject({ code: '42501' });
      await expect(crewflow.query(`INSERT INTO core.organisation (name, slug) VALUES ('x', $1)`, [`p2-direct-${Date.now()}`])).rejects.toMatchObject({ code: '42501' });
      await expect(crewflow.query(`SELECT core.create_organisation('x', $1)`, [`p2-direct-fn-${Date.now()}`])).rejects.toMatchObject({ code: '42501' });
      expect(await admin.query(`SELECT user_id FROM core.platform_admin`)).toHaveLength(0);
    });

    it('rejects malformed input inside the database (no partial writes)', async () => {
      await clearPlatformAdmins();
      await expect(crewflow.query(`SELECT * FROM core.bootstrap_first_platform_admin('not-an-email', 'A', 'B', NULL, NULL)`)).rejects.toMatchObject({ code: '22023' });
      await expect(crewflow.query(`SELECT * FROM core.bootstrap_first_platform_admin('a@b.test', 'A', 'B', 'Bad Slug!', NULL)`)).rejects.toMatchObject({ code: '22023' });
      expect(await admin.query(`SELECT user_id FROM core.platform_admin`)).toHaveLength(0);
    });
  });
});
