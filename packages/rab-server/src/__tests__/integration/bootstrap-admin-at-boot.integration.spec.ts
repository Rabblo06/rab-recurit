import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { DataSource } from 'typeorm';

import { CommandModule } from '../../command/command.module';
import { BootstrapAdminCommand } from '../../command/bootstrap-admin.command';
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

/** Every address this suite creates ends with this, so its own platform_admin rows can be removed by scope at the end. */
const DOMAIN = 'boot-at-boot.example.test';

/**
 * First platform administrator at API boot (owner request 2026-11-19), against PostgreSQL: the API's boot hook
 * (PlatformAdminBootstrapOnBoot) runs the SAME PlatformAdminBootstrapService as the bootstrap-admin command, on the runtime
 * login crewflow_owner. Each "replica" below is its own DataSource (its own pool) and its own provider instance, exactly
 * like two rab-api containers starting together. The HTTP-level proofs (MFA enrolment at first sign-in, the tenant side
 * refused on the admin's account, a staff-only email) are in bootstrap-admin-at-boot-app.integration.spec.ts.
 *
 * Hygiene: bootstrap is GLOBAL state (it is open only while no platform_admin row exists), so each case starts by clearing
 * core.platform_admin. ci-server runs the server suite with --runInBand (and every shard on its own database), so no other
 * suite runs concurrently with this one; afterAll removes the rows this suite created (scoped by DOMAIN).
 *
 * Abuse cases (CLAUDE.md testing floor): MFA enforcement off -> refused; an existing admin -> no-op and no email; concurrent
 * boots (and a boot racing the CLI) -> exactly one admin and one email; no password ever accepted; a pending / unproven
 * existing account -> refused; ambiguous email / organisation -> refused; a login that may not run the bootstrap -> refused,
 * nothing written, boot continues; the email goes only to the configured address; the token never reaches logs or audit.
 */
describeIfDb('first platform admin at API boot (integration)', () => {
  let moduleRef: TestingModule;
  let admin: DataSource; // superuser: fixture setup / inspection only
  let replicaA: DataSource; // crewflow_owner (the runtime login)
  let replicaB: DataSource; // crewflow_owner, a second pool
  let schemaApp: DataSource; // the schema role crewflow_app (may not run the bootstrap)
  let deps: readonly [AuditService, AccountLifecycleService, TenantContextService];
  let env: EnvironmentService;
  let mfaEnforced: boolean;
  let logs: { level: string; message: string }[];
  let allOutput: string[];

  function bootOn(dataSource: DataSource): PlatformAdminBootstrapOnBoot {
    return new PlatformAdminBootstrapOnBoot(new PlatformAdminBootstrapService(dataSource, ...deps), env);
  }

  const mail = (local: string) => `${local}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@${DOMAIN}`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [CommandModule] }).compile();
    deps = [moduleRef.get(AuditService), moduleRef.get(AccountLifecycleService), moduleRef.get(TenantContextService)] as const;
    const realEnv = moduleRef.get(EnvironmentService);
    env = { get: (key: string) => (key === 'AUTH_MFA_ENFORCE_PLATFORM_ADMIN' ? mfaEnforced : realEnv.get(key as never)) } as unknown as EnvironmentService;
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
    await admin.query(`DELETE FROM core.platform_admin WHERE user_id IN (SELECT id FROM core."user" WHERE email::text LIKE $1)`, [`%@${DOMAIN}`]);
    await schemaApp.destroy();
    await replicaB.destroy();
    await replicaA.destroy();
    await admin.destroy();
    await moduleRef.close();
  });

  beforeEach(async () => {
    mfaEnforced = true;
    logs = [];
    allOutput = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      // `logs`: this provider's own lines (context PlatformAdminBootstrap). `allOutput`: every Nest log line and console line.
      jest.spyOn(Logger.prototype, level).mockImplementation(function (this: Logger, ...args: unknown[]) {
        allOutput.push(args.map(String).join(' '));
        if ((this as unknown as { context?: string }).context === 'PlatformAdminBootstrap') logs.push({ level, message: String(args[0]) });
      });
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        allOutput.push(args.map(String).join(' '));
      });
    }
    await admin.query(`DELETE FROM core.platform_admin`); // global by nature; see the hygiene note above
  });

  afterEach(() => jest.restoreAllMocks());

  async function dbNow(): Promise<Date> {
    const [{ now }] = await admin.query(`SELECT clock_timestamp() AS now`);
    return now as Date;
  }

  async function outboxSince(since: Date): Promise<Array<{ recipient_email: string; rendered_subject: string; rendered_html: string | null; rendered_text: string | null }>> {
    return admin.query(`SELECT recipient_email, rendered_subject, rendered_html, rendered_text FROM core.email_outbox WHERE created_at >= $1 ORDER BY created_at`, [since]);
  }

  const platformAdmins = async () => admin.query(`SELECT user_id FROM core.platform_admin`);

  function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
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

  it('DENIAL (F1): AUTH_MFA_ENFORCE_PLATFORM_ADMIN not true -> refused before anything runs: no admin, no user, no email', async () => {
    mfaEnforced = false;
    const since = await dbNow();
    const slug = `boot-nomfa-${Date.now()}`;
    expect(await bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: mail('nomfa'), BOOTSTRAP_ADMIN_ORG_SLUG: slug })).toBe('REFUSED_MFA_NOT_ENFORCED');
    expect(logs).toEqual([{ level: 'error', message: PLATFORM_ADMIN_BOOT_LOG.mfaNotEnforced }]);
    expect(await platformAdmins()).toHaveLength(0);
    expect(await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug])).toHaveLength(0);
    expect(await outboxSince(since)).toHaveLength(0);
  });

  it('fresh database: one INVITED admin with no password, ONE activation email to the configured address only, an audit entry; the token never reaches a log line or the audit metadata', async () => {
    const since = await dbNow();
    const slug = `boot-fresh-${Date.now()}`;
    const email = mail('fresh');
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

    // (d) the activation token: only inside the email itself.
    const token = /token=([A-Za-z0-9_-]+)/.exec(`${outbox[0]!.rendered_html ?? ''} ${outbox[0]!.rendered_text ?? ''}`)?.[1];
    expect(token).toBeDefined();
    expect(token!.length).toBeGreaterThan(20);
    expect(allOutput.join('\n')).not.toContain(token!);
    const allAuditMetadata = await admin.query(`SELECT metadata::text AS m FROM core.audit_log WHERE created_at >= $1`, [since]);
    expect(allAuditMetadata.map((r: { m: string }) => r.m).join('\n')).not.toContain(token!);

    expect(logs).toEqual([{ level: 'log', message: PLATFORM_ADMIN_BOOT_LOG.created(new Date(invite.expires_at)) }]);
    expect(JSON.stringify(logs).toLowerCase()).not.toContain(email); // this provider's lines never name the address
  });

  it('DENIAL: an admin already exists -> restart is a no-op: no user, invite, email or audit row, one "can be removed" line per boot', async () => {
    const slug = `boot-existing-${Date.now()}`;
    const first = mail('first');
    await bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: first, BOOTSTRAP_ADMIN_ORG_SLUG: slug });
    const [{ users: usersBefore }] = await admin.query(`SELECT count(*)::int AS users FROM core."user"`);
    const [{ audits: auditsBefore }] = await admin.query(`SELECT count(*)::int AS audits FROM core.audit_log WHERE action = $1`, [AuditAction.PLATFORM_ADMIN_BOOTSTRAPPED]);
    logs = [];

    const since = await dbNow();
    // Same address (a plain restart) and a different address (someone edits the variable): neither does anything.
    for (const email of [first, mail('someone-else')]) {
      expect(await bootOn(replicaB).runOnce({ BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_ORG_SLUG: `${slug}-other` })).toBe('ALREADY_BOOTSTRAPPED');
    }
    expect(await outboxSince(since)).toHaveLength(0);
    expect(await admin.query(`SELECT id FROM core.account_invite WHERE created_at >= $1`, [since])).toHaveLength(0);
    expect(await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [`${slug}-other`])).toHaveLength(0);
    const [{ users: usersAfter }] = await admin.query(`SELECT count(*)::int AS users FROM core."user"`);
    const [{ audits: auditsAfter }] = await admin.query(`SELECT count(*)::int AS audits FROM core.audit_log WHERE action = $1`, [AuditAction.PLATFORM_ADMIN_BOOTSTRAPPED]);
    expect(usersAfter).toBe(usersBefore);
    expect(auditsAfter).toBe(auditsBefore);
    expect(await platformAdmins()).toHaveLength(1);
    expect(logs).toEqual([
      { level: 'log', message: PLATFORM_ADMIN_BOOT_LOG.alreadyExists },
      { level: 'log', message: PLATFORM_ADMIN_BOOT_LOG.alreadyExists },
    ]);
  });

  it('F5: the existing admin never activated and its link expired -> a distinct line, nothing re-sent', async () => {
    const slug = `boot-expired-${Date.now()}`;
    await bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: mail('expired'), BOOTSTRAP_ADMIN_ORG_SLUG: slug });
    const [{ user_id: adminId }] = await platformAdmins();
    await admin.query(`UPDATE core.account_invite SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [adminId]);
    logs = [];
    const since = await dbNow();
    expect(await bootOn(replicaB).runOnce({ BOOTSTRAP_ADMIN_EMAIL: mail('expired-again') })).toBe('ALREADY_BOOTSTRAPPED');
    expect(logs).toEqual([{ level: 'warn', message: PLATFORM_ADMIN_BOOT_LOG.activationExpired }]);
    expect(await outboxSince(since)).toHaveLength(0);
    expect(await admin.query(`SELECT id FROM core.account_invite WHERE created_at >= $1`, [since])).toHaveLength(0);
  });

  it('DENIAL: two (and four) replicas booting together create exactly ONE admin and send exactly ONE email', async () => {
    const since = await dbNow();
    const slug = `boot-race-${Date.now()}`;
    const email = mail('race');
    const vars = { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_ORG_SLUG: slug };
    const outcomes = await Promise.all([bootOn(replicaA), bootOn(replicaB), bootOn(replicaA), bootOn(replicaB)].map((boot) => boot.runOnce(vars)));
    expect(outcomes.filter((o) => o === 'CREATED_INVITED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'ALREADY_BOOTSTRAPPED')).toHaveLength(3);

    const orgs = await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    expect(orgs).toHaveLength(1);
    const users = await admin.query(`SELECT id FROM core."user" WHERE organisation_id = $1`, [orgs[0].id]);
    expect(users).toHaveLength(1);
    expect(await platformAdmins()).toEqual([{ user_id: users[0].id }]);
    expect(await admin.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [users[0].id])).toHaveLength(1);
    const outbox = await outboxSince(since);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.recipient_email).toBe(email);
  });

  it('DENIAL (c): a boot racing the bootstrap-admin CLI creates exactly ONE admin and sends exactly ONE email', async () => {
    const since = await dbNow();
    const slug = `boot-cli-race-${Date.now()}`;
    const email = mail('cli-race');
    const vars = { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_ORG_SLUG: slug };
    const command = new BootstrapAdminCommand(replicaB, ...deps);
    const [, bootOutcome] = await withEnv(vars, () => Promise.all([command.run(), bootOn(replicaA).runOnce(vars)]));
    expect(['CREATED_INVITED', 'ALREADY_BOOTSTRAPPED']).toContain(bootOutcome);
    const orgs = await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug]);
    expect(orgs).toHaveLength(1);
    const users = await admin.query(`SELECT id FROM core."user" WHERE organisation_id = $1`, [orgs[0].id]);
    expect(users).toHaveLength(1);
    expect(await platformAdmins()).toEqual([{ user_id: users[0].id }]);
    expect(await admin.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [users[0].id])).toHaveLength(1);
    const outbox = await outboxSince(since);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.recipient_email).toBe(email);
  });

  it('DENIAL (F2): the email of an INVITED manager (ownership never proven) -> refused and rolled back: no platform_admin row, no email', async () => {
    const since = await dbNow();
    const email = mail('invited-mgr');
    const [org] = await admin.query(`INSERT INTO core.organisation (name, slug) VALUES ('F2 org', $1) RETURNING id`, [`boot-f2-${Date.now()}`]);
    const [user] = await admin.query(`INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'Pending', 'Manager', 'invited') RETURNING id`, [
      org.id,
      email,
    ]);
    await admin.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type) VALUES ($1, $2, 'internal')`, [org.id, user.id]);

    expect(await bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: email })).toBe('REFUSED_EXISTING_ACCOUNT_UNVERIFIED');
    expect(logs).toEqual([{ level: 'error', message: PLATFORM_ADMIN_BOOT_LOG.existingUnverified }]);
    expect(await platformAdmins()).toHaveLength(0);
    expect(await outboxSince(since)).toHaveLength(0);
    expect(await admin.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [user.id])).toHaveLength(0);
  });

  it('DENIAL (e): an email matching accounts in two organisations -> REFUSED_AMBIGUOUS_EMAIL, nothing written', async () => {
    const since = await dbNow();
    const email = mail('ambiguous');
    // The database now refuses a second account with an existing email (a global-uniqueness trigger), so this legacy state
    // (accounts created before that rule) is planted with triggers off, by the fixture superuser, in its own transaction.
    // The bootstrap function still has to refuse it rather than guess.
    await admin.transaction(async (m) => {
      await m.query(`SET LOCAL session_replication_role = replica`);
      for (const n of [1, 2]) {
        const [org] = await m.query(`INSERT INTO core.organisation (name, slug) VALUES ('Ambiguous', $1) RETURNING id`, [`boot-amb-${n}-${Date.now()}`]);
        await m.query(`INSERT INTO core."user" (organisation_id, email, first_name, last_name, status, email_verified_at) VALUES ($1, $2, 'A', 'B', 'active', now())`, [org.id, email]);
      }
    });
    expect(await bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: email })).toBe('REFUSED_AMBIGUOUS_EMAIL');
    expect(logs).toEqual([{ level: 'error', message: PLATFORM_ADMIN_BOOT_LOG.ambiguousEmail }]);
    expect(await platformAdmins()).toHaveLength(0);
    expect(await outboxSince(since)).toHaveLength(0);
  });

  it('DENIAL (e): several organisations, no BOOTSTRAP_ADMIN_ORG_SLUG and no matching account -> REFUSED_AMBIGUOUS_ORGANISATION, nothing written', async () => {
    for (const n of [1, 2]) await admin.query(`INSERT INTO core.organisation (name, slug) VALUES ('Several', $1)`, [`boot-several-${n}-${Date.now()}`]);
    const since = await dbNow();
    const [{ orgs: orgsBefore }] = await admin.query(`SELECT count(*)::int AS orgs FROM core.organisation`);
    expect(await bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: mail('no-match') })).toBe('REFUSED_AMBIGUOUS_ORGANISATION');
    expect(logs).toEqual([{ level: 'error', message: PLATFORM_ADMIN_BOOT_LOG.ambiguousOrganisation }]);
    expect(await platformAdmins()).toHaveLength(0);
    const [{ orgs: orgsAfter }] = await admin.query(`SELECT count(*)::int AS orgs FROM core.organisation`);
    expect(orgsAfter).toBe(orgsBefore);
    expect(await outboxSince(since)).toHaveLength(0);
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
    const slug = `boot-password-${Date.now()}`;
    expect(await bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: mail('pw'), BOOTSTRAP_ADMIN_ORG_SLUG: slug, BOOTSTRAP_ADMIN_PASSWORD: 'Correct-Horse-Battery-42!' })).toBe('REFUSED_PASSWORD_SET');
    expect(await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug])).toHaveLength(0);
    expect(await platformAdmins()).toHaveLength(0);
  });

  it('FAIL CLOSED: a login that may not run the bootstrap (crewflow_app) -> fixed error line, nothing written, no email, no throw', async () => {
    const since = await dbNow();
    const slug = `boot-refused-${Date.now()}`;
    await expect(bootOn(schemaApp).runOnce({ BOOTSTRAP_ADMIN_EMAIL: mail('refused'), BOOTSTRAP_ADMIN_ORG_SLUG: slug })).resolves.toBe('FAILED');
    expect(logs).toEqual([{ level: 'error', message: PLATFORM_ADMIN_BOOT_LOG.failed('not-authorised') }]);
    expect(await admin.query(`SELECT id FROM core.organisation WHERE slug = $1`, [slug])).toHaveLength(0);
    expect(await platformAdmins()).toHaveLength(0);
    expect(await outboxSince(since)).toHaveLength(0);
  });

  it('FAIL CLOSED: a malformed BOOTSTRAP_ADMIN_EMAIL is refused by the database function -> invalid-input, nothing written', async () => {
    await expect(bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: 'not-an-email' })).resolves.toBe('FAILED');
    expect(logs).toEqual([{ level: 'error', message: PLATFORM_ADMIN_BOOT_LOG.failed('invalid-input') }]);
    expect(await platformAdmins()).toHaveLength(0);
  });

  it('CLOSED (every admin revoked): the boot never mints a replacement and says the variable can be removed', async () => {
    const slug = `boot-closed-${Date.now()}`;
    await bootOn(replicaA).runOnce({ BOOTSTRAP_ADMIN_EMAIL: mail('closed'), BOOTSTRAP_ADMIN_ORG_SLUG: slug });
    await admin.query(`UPDATE core.platform_admin SET revoked_at = now(), security_version = security_version + 1`);
    logs = [];
    const since = await dbNow();
    expect(await bootOn(replicaB).runOnce({ BOOTSTRAP_ADMIN_EMAIL: mail('closed-other'), BOOTSTRAP_ADMIN_ORG_SLUG: `${slug}-x` })).toBe('CLOSED');
    expect(logs).toEqual([{ level: 'warn', message: PLATFORM_ADMIN_BOOT_LOG.closed }]);
    expect(await admin.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`)).toHaveLength(0);
    expect(await outboxSince(since)).toHaveLength(0);
  });
});
