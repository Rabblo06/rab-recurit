import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { DataSource } from 'typeorm';

import { CommandModule } from '../../command/command.module';
import { AuditAction, AuditService } from '../../engine/core-modules/audit/audit.service';
import { AccountLifecycleService } from '../../engine/core-modules/auth/services/account-lifecycle.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { coreDataSourceOptions } from '../../database/typeorm/core/core.datasource';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { runtimeEnvRefusal } from '../../database/typeorm/core/never-in-runtime-env';
import {
  PLATFORM_ADMIN_BOOT_LOG,
  PlatformAdminBootstrapOnBoot,
} from '../../modules/identity/platform-admin-bootstrap/services/platform-admin-bootstrap-on-boot.service';
import { PlatformAdminBootstrapService } from '../../modules/identity/platform-admin-bootstrap/services/platform-admin-bootstrap.service';
import { createAdminDataSource, createCrewflowOwnerProbeDataSource } from './helpers/admin-datasource';

const describeIfDb = integrationTestDatabaseReady() ? describe : describe.skip;

/**
 * First platform administrator at API boot (owner request 2026-11-19), against PostgreSQL: the API's boot hook
 * (PlatformAdminBootstrapOnBoot) runs the SAME PlatformAdminBootstrapService as the bootstrap-admin command, on the runtime
 * login crewflow_owner. Each "replica" below is its own DataSource (its own pool) and its own provider instance, exactly
 * like two rab-api containers starting together.
 *
 * Abuse cases (CLAUDE.md testing floor): an existing admin -> no-op and no email; concurrent boots -> exactly one admin and
 * one email; no password ever accepted; a login that may not run the bootstrap -> refused, nothing written, boot continues;
 * the email goes only to the configured address.
 */
describeIfDb('first platform admin at API boot (integration)', () => {
  let moduleRef: TestingModule;
  let admin: DataSource; // superuser: fixture setup / inspection only
  let replicaA: DataSource; // crewflow_owner (the runtime login)
  let replicaB: DataSource; // crewflow_owner, a second pool
  let schemaApp: DataSource; // the schema role crewflow_app (may not run the bootstrap)
  let deps: readonly [AuditService, AccountLifecycleService, TenantContextService];
  let env: EnvironmentService;
  let logs: { level: string; message: string }[];

  function bootOn(dataSource: DataSource): PlatformAdminBootstrapOnBoot {
    return new PlatformAdminBootstrapOnBoot(new PlatformAdminBootstrapService(dataSource, ...deps), env);
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [CommandModule] }).compile();
    deps = [moduleRef.get(AuditService), moduleRef.get(AccountLifecycleService), moduleRef.get(TenantContextService)] as const;
    env = moduleRef.get(EnvironmentService);
    admin = createAdminDataSource();
    await admin.initialize();
    replicaA = createCrewflowOwnerProbeDataSource();
    await replicaA.initialize();
    replicaB = createCrewflowOwnerProbeDataSource();
    await replicaB.initialize();
    const { adminUrl } = resolveIntegrationTestDatabase(process.env);
    const base = coreDataSourceOptions as PostgresConnectionOptions;
    schemaApp = new DataSource({
      ...base,
      url: adminUrl,
      name: `boot-bootstrap-app-${Math.random().toString(36).slice(2)}`,
      extra: { ...(base.extra as object | undefined), options: '-c search_path=core -c role=crewflow_app' },
    });
    await schemaApp.initialize();
  });

  afterAll(async () => {
    await schemaApp.destroy();
    await replicaB.destroy();
    await replicaA.destroy();
    await admin.destroy();
    await moduleRef.close();
  });

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      // Only this provider's own lines (context PlatformAdminBootstrap): an after-commit queue publish elsewhere may log too.
      jest.spyOn(Logger.prototype, level).mockImplementation(function (this: Logger, ...args: unknown[]) {
        if ((this as unknown as { context?: string }).context === 'PlatformAdminBootstrap') logs.push({ level, message: String(args[0]) });
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  async function clearPlatformAdmins(): Promise<void> {
    await admin.query(`DELETE FROM core.platform_admin`);
  }

  async function outboxSince(since: Date): Promise<Array<{ recipient_email: string; job_type: string; rendered_subject: string }>> {
    return admin.query(`SELECT recipient_email, job_type, rendered_subject FROM core.email_outbox WHERE created_at >= $1 ORDER BY created_at`, [since]);
  }

  async function dbNow(): Promise<Date> {
    const [{ now }] = await admin.query(`SELECT clock_timestamp() AS now`);
    return now as Date;
  }

  it('fresh database: creates exactly one INVITED admin with no password, ONE activation email to the configured address only, and an audit entry', async () => {
    await clearPlatformAdmins();
    const since = await dbNow();
    const slug = `boot-fresh-${Date.now()}`;
    const email = `boot-admin-${slug}@example.test`;
    const outcome = await bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: email.toUpperCase(), BOOTSTRAP_ADMIN_ORG_SLUG: slug, BOOTSTRAP_ADMIN_ORG_NAME: 'Boot Org' });
    expect(outcome).toBe('CREATED_INVITED');

    const [org] = await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    const users = await admin.query(`SELECT id, email, status, password_hash FROM core."user" WHERE organisation_id = $1`, [org.id]);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email, status: 'invited', password_hash: null });
    expect(await admin.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`)).toEqual([{ user_id: users[0].id }]);

    // The link expires: the ordinary account-invite TTL (24 h), the same as the CLI.
    const [invite] = await admin.query(`SELECT id, expires_at FROM core.account_invite WHERE user_id = $1`, [users[0].id]);
    const ttlHours = (new Date(invite.expires_at).getTime() - since.getTime()) / 3_600_000;
    expect(ttlHours).toBeGreaterThan(23.9);
    expect(ttlHours).toBeLessThanOrEqual(24.1);

    // ONE email in the whole outbox since the boot started, to the configured address and nobody else.
    const outbox = await outboxSince(since);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.recipient_email).toBe(email);
    expect(outbox[0]!.rendered_subject).toMatch(/Super Admin/i);

    const audit = await admin.query(`SELECT actor_user_id, target_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = $2`, [
      org.id,
      AuditAction.PLATFORM_ADMIN_BOOTSTRAPPED,
    ]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: null, target_user_id: users[0].id, metadata: { via: 'env_bootstrap', pendingActivation: true, trigger: 'api_boot' } });

    expect(logs.map((l) => l.message)).toContain(PLATFORM_ADMIN_BOOT_LOG.created(new Date(invite.expires_at)));
    expect(JSON.stringify(logs).toLowerCase()).not.toContain(email);
  });

  it('DENIAL: an admin already exists -> restart is a no-op: no user, invite, email or audit row, one "can be removed" line', async () => {
    await clearPlatformAdmins();
    const slug = `boot-existing-${Date.now()}`;
    await bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: `first-${slug}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: slug });
    const [{ users: usersBefore }] = await admin.query(`SELECT count(*)::int AS users FROM core."user"`);
    const [{ audits: auditsBefore }] = await admin.query(`SELECT count(*)::int AS audits FROM core.audit_log WHERE action = $1`, [AuditAction.PLATFORM_ADMIN_BOOTSTRAPPED]);
    logs = [];

    const since = await dbNow();
    // Same address (a plain restart) and a different address (someone edits the variable): neither does anything.
    for (const email of [`first-${slug}@example.test`, `someone-else-${slug}@example.test`]) {
      expect(await bootOn(replicaB).runOnce({ BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_ORG_SLUG: `${slug}-other` })).toBe('ALREADY_BOOTSTRAPPED');
    }
    expect(await outboxSince(since)).toHaveLength(0);
    expect(await admin.query(`SELECT id FROM core.account_invite WHERE created_at >= $1`, [since])).toHaveLength(0);
    expect(await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [`${slug}-other`])).toHaveLength(0);
    const [{ users: usersAfter }] = await admin.query(`SELECT count(*)::int AS users FROM core."user"`);
    const [{ audits: auditsAfter }] = await admin.query(`SELECT count(*)::int AS audits FROM core.audit_log WHERE action = $1`, [AuditAction.PLATFORM_ADMIN_BOOTSTRAPPED]);
    expect(usersAfter).toBe(usersBefore);
    expect(auditsAfter).toBe(auditsBefore);
    expect(await admin.query(`SELECT user_id FROM core.platform_admin`)).toHaveLength(1);
    expect(logs).toEqual([
      { level: 'log', message: PLATFORM_ADMIN_BOOT_LOG.alreadyExists },
      { level: 'log', message: PLATFORM_ADMIN_BOOT_LOG.alreadyExists },
    ]); // once per boot
  });

  it('DENIAL: two (and four) replicas booting together create exactly ONE admin and send exactly ONE email', async () => {
    await clearPlatformAdmins();
    const since = await dbNow();
    const slug = `boot-race-${Date.now()}`;
    const email = `race-${slug}@example.test`;
    const vars = { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_ORG_SLUG: slug };
    const outcomes = await Promise.all([bootOn(replicaA), bootOn(replicaB), bootOn(replicaA), bootOn(replicaB)].map((boot) => boot.runOnce(vars)));
    expect(outcomes.filter((o) => o === 'CREATED_INVITED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'ALREADY_BOOTSTRAPPED')).toHaveLength(3);

    const orgs = await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    expect(orgs).toHaveLength(1);
    const users = await admin.query(`SELECT id FROM core."user" WHERE organisation_id = $1`, [orgs[0].id]);
    expect(users).toHaveLength(1);
    expect(await admin.query(`SELECT user_id FROM core.platform_admin`)).toEqual([{ user_id: users[0].id }]);
    expect(await admin.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [users[0].id])).toHaveLength(1);
    const outbox = await outboxSince(since);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.recipient_email).toBe(email);
  });

  it('DENIAL: BOOTSTRAP_ADMIN_PASSWORD is never accepted: the API refuses to start with it, and the boot hook refuses it too', async () => {
    // The in-process runtime guard (main.ts, before Nest) refuses the variable in the API, the Worker and the provisioner.
    for (const processName of ['api', 'worker', 'provisioner'] as const) {
      expect(runtimeEnvRefusal({ NODE_ENV: 'production', BOOTSTRAP_ADMIN_PASSWORD: 'x' }, processName)?.name).toBe('BOOTSTRAP_ADMIN_PASSWORD');
    }
    // ...while the five inputs the API reads are allowed.
    for (const name of ['BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_FIRST_NAME', 'BOOTSTRAP_ADMIN_LAST_NAME', 'BOOTSTRAP_ADMIN_ORG_SLUG', 'BOOTSTRAP_ADMIN_ORG_NAME']) {
      expect(runtimeEnvRefusal({ NODE_ENV: 'production', [name]: 'x' }, 'api')).toBeNull();
    }
    // Service-level copy: even if the guard were bypassed, nothing is created.
    await clearPlatformAdmins();
    const slug = `boot-password-${Date.now()}`;
    expect(await bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: `pw-${slug}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: slug, BOOTSTRAP_ADMIN_PASSWORD: 'Correct-Horse-Battery-42!' })).toBe('REFUSED_PASSWORD_SET');
    expect(await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug])).toHaveLength(0);
    expect(await admin.query(`SELECT user_id FROM core.platform_admin`)).toHaveLength(0);
  });

  it('FAIL CLOSED: a login that may not run the bootstrap (crewflow_app) -> fixed error line, nothing written, no email, no throw', async () => {
    await clearPlatformAdmins();
    const since = await dbNow();
    const slug = `boot-refused-${Date.now()}`;
    await expect(bootOn(schemaApp).runOnce({ BOOTSTRAP_ADMIN_EMAIL: `refused-${slug}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: slug })).resolves.toBe('FAILED');
    expect(logs).toEqual([{ level: 'error', message: PLATFORM_ADMIN_BOOT_LOG.failed('not-authorised') }]);
    expect(await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug])).toHaveLength(0);
    expect(await admin.query(`SELECT user_id FROM core.platform_admin`)).toHaveLength(0);
    expect(await outboxSince(since)).toHaveLength(0);
  });

  it('FAIL CLOSED: a malformed BOOTSTRAP_ADMIN_EMAIL is refused by the database function -> invalid-input, nothing written', async () => {
    await clearPlatformAdmins();
    await expect(bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: 'not-an-email' })).resolves.toBe('FAILED');
    expect(logs).toEqual([{ level: 'error', message: PLATFORM_ADMIN_BOOT_LOG.failed('invalid-input') }]);
    expect(await admin.query(`SELECT user_id FROM core.platform_admin`)).toHaveLength(0);
  });

  it('CLOSED (every admin revoked): the boot never mints a replacement and says the variable can be removed', async () => {
    await clearPlatformAdmins();
    const slug = `boot-closed-${Date.now()}`;
    await bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: `closed-${slug}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: slug });
    await admin.query(`UPDATE core.platform_admin SET revoked_at = now(), security_version = security_version + 1`);
    logs = [];
    const since = await dbNow();
    expect(await bootOn(replicaB).runOnce({ BOOTSTRAP_ADMIN_EMAIL: `closed-other-${slug}@example.test`, BOOTSTRAP_ADMIN_ORG_SLUG: `${slug}-x` })).toBe('CLOSED');
    expect(logs).toEqual([{ level: 'warn', message: PLATFORM_ADMIN_BOOT_LOG.closed }]);
    expect(await admin.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`)).toHaveLength(0);
    expect(await outboxSince(since)).toHaveLength(0);
  });
});
