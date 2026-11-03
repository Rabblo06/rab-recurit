import { Test, TestingModule } from '@nestjs/testing';
import { CommandRunner } from 'nest-commander';
import { DataSource } from 'typeorm';

import { CommandModule } from '../../command/command.module';
import { SeedQaCommand } from '../../command/seed-qa.command';
import { AuditAction } from '../../engine/core-modules/audit/audit.service';
import { createAdminDataSource } from './helpers/admin-datasource';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const QA_ORGANISATION_SLUG = 'adolphus-qa';

/**
 * `seed-qa` runs as the restricted runtime role (`crewflow_app`) — never an owner, superuser or BYPASSRLS login — and
 * creates its organisation through the supported provisioning path, `core.create_organisation()`, under an active platform
 * administrator's authority (CF-13). Before this, it INSERTed into `core.organisation` directly, which the runtime role
 * cannot do ("new row violates row-level security policy for table organisation"), so the fixture failed on every
 * Phase-B database (Worker-bundle integration harness cases 10, 16-19, 20b, 24, 25).
 *
 * Fixtures (the platform administrator) and inspection use the disposable cluster's bootstrap superuser, as everywhere
 * in this suite; the command itself only ever uses the module's own DataSource, which is `crewflow_app`.
 */
describeIfDb('seed-qa under the restricted runtime role (integration)', () => {
  let moduleRef: TestingModule;
  let admin: DataSource; // superuser: fixture setup and inspection only
  let runtime: DataSource; // the command's own connection
  let command: CommandRunner;
  let adminEmail: string;
  let adminUserId: string;
  let plainUserEmail: string;

  const QA_EMAILS = ['manager.qa@example.test', 'venue.qa@example.test', ...[1, 2, 3, 4, 5].map((i) => `staff0${i}.qa@example.test`)];

  async function withQaPassword<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.SEED_QA_PASSWORD;
    process.env.SEED_QA_PASSWORD = `Qa-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.SEED_QA_PASSWORD;
      else process.env.SEED_QA_PASSWORD = prev;
    }
  }

  const qaOrganisations = (): Promise<Array<{ id: string; name: string }>> =>
    admin.query(`SELECT id, name FROM core.organisation WHERE slug = $1`, [QA_ORGANISATION_SLUG]);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [CommandModule] }).compile();
    command = moduleRef.get(SeedQaCommand);
    runtime = moduleRef.get(DataSource);
    admin = createAdminDataSource();
    await admin.initialize();

    // The fixture is fixed-name (slug and seven @example.test accounts): it must not exist yet in this database.
    expect(await qaOrganisations()).toHaveLength(0);
    expect(await admin.query(`SELECT id FROM core."user" WHERE lower(email::text) = ANY($1::text[])`, [QA_EMAILS])).toHaveLength(0);

    // An active platform administrator in its own organisation, and an ordinary account that is not one.
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [org] = await admin.query(`INSERT INTO core.organisation (name, slug) VALUES ('Seed QA admin org', $1) RETURNING id`, [`seed-qa-admin-${unique}`]);
    adminEmail = `seed-qa-admin-${unique}@example.test`;
    plainUserEmail = `seed-qa-plain-${unique}@example.test`;
    const [adminUser] = await admin.query(
      `INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'Seed', 'Admin', 'active') RETURNING id`,
      [org.id, adminEmail],
    );
    adminUserId = adminUser.id;
    await admin.query(`INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'Plain', 'User', 'active')`, [org.id, plainUserEmail]);
    await admin.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1)`, [adminUserId]);
  });

  afterAll(async () => {
    await admin?.destroy();
    await moduleRef?.close();
  });

  it('the command connection is the restricted runtime role: crewflow_app, not a superuser, no BYPASSRLS, owns no core table', async () => {
    const [who] = await runtime.query(
      `SELECT current_user AS u, r.rolsuper AS s, r.rolbypassrls AS b,
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relowner = r.oid) AS owned
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(who).toEqual({ u: 'crewflow_app', s: false, b: false, owned: 0 });
    // The direct write the old seed-qa made is refused to this role: the definer is the only path.
    await expect(runtime.query(`INSERT INTO core.organisation (name, slug) VALUES ('Direct', $1)`, [`seed-qa-direct-${Date.now()}`])).rejects.toThrow(
      /row-level security policy for table "organisation"/,
    );
  });

  describe('abuse cases: refused before any write', () => {
    it('no --admin-email', async () => {
      await expect(withQaPassword(() => command.run([], {}))).rejects.toThrow(/--admin-email .* is required/);
      expect(await qaOrganisations()).toHaveLength(0);
    });

    it('an ordinary account that is not a platform administrator (and the definer refuses it too)', async () => {
      await expect(withQaPassword(() => command.run([], { adminEmail: plainUserEmail }))).rejects.toThrow(/not an active platform administrator/);
      await expect(withQaPassword(() => command.run([], { adminEmail: `nobody-${Date.now()}@example.test` }))).rejects.toThrow(/not an active platform administrator/);
      expect(await qaOrganisations()).toHaveLength(0);
    });

    it('a revoked platform administrator', async () => {
      await admin.query(`UPDATE core.platform_admin SET revoked_at = now() WHERE user_id = $1`, [adminUserId]);
      try {
        await expect(withQaPassword(() => command.run([], { adminEmail }))).rejects.toThrow(/not an active platform administrator/);
      } finally {
        await admin.query(`UPDATE core.platform_admin SET revoked_at = NULL WHERE user_id = $1`, [adminUserId]);
      }
      expect(await qaOrganisations()).toHaveLength(0);
    });
  });

  it('creates the organisation through core.create_organisation (audited, actor = the administrator) and seeds the whole fixture', async () => {
    await withQaPassword(() => command.run([], { adminEmail }));

    const orgs = await qaOrganisations();
    expect(orgs).toHaveLength(1);
    const organisationId = orgs[0]!.id;
    expect(orgs[0]!.name).toBe('ADOLPHUS QA');
    const audit = await admin.query(`SELECT actor_user_id, entity_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = $2`, [
      organisationId,
      AuditAction.ORGANISATION_CREATED,
    ]);
    expect(audit).toEqual([{ actor_user_id: adminUserId, entity_id: organisationId, metadata: expect.objectContaining({ slug: QA_ORGANISATION_SLUG, via: 'seed-qa' }) }]);

    const users = await admin.query(`SELECT email FROM core."user" WHERE organisation_id = $1 ORDER BY email`, [organisationId]);
    expect(users.map((u: { email: string }) => u.email)).toEqual([...QA_EMAILS].sort());
    expect(await admin.query(`SELECT subdomain FROM core.manager_workspace WHERE organisation_id = $1`, [organisationId])).toEqual([{ subdomain: 'adolphus-qa' }]);
    expect(await admin.query(`SELECT type FROM core.manager_profile WHERE organisation_id = $1 ORDER BY type`, [organisationId])).toEqual([
      { type: 'internal' },
      { type: 'venue' },
    ]);
  });

  it('is idempotent: a second run finds the organisation (no second organisation, account or audit entry)', async () => {
    await withQaPassword(() => command.run([], { adminEmail }));
    const orgs = await qaOrganisations();
    expect(orgs).toHaveLength(1);
    expect(await admin.query(`SELECT id FROM core."user" WHERE organisation_id = $1`, [orgs[0]!.id])).toHaveLength(QA_EMAILS.length);
    expect(await admin.query(`SELECT id FROM core.audit_log WHERE organisation_id = $1 AND action = $2`, [orgs[0]!.id, AuditAction.ORGANISATION_CREATED])).toHaveLength(1);
  });

  it('the database posture is unchanged: runtime role still restricted, organisation RLS enabled, tenant tables still FORCE RLS', async () => {
    const [role] = await admin.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'crewflow_app'`);
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const rls = await admin.query(
      `SELECT c.relname AS t, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'core' AND c.relname IN ('organisation', 'role', 'user_role', 'manager_profile', 'staff_profile', 'workspace_membership', 'audit_log')
        ORDER BY c.relname`,
    );
    const byName = Object.fromEntries(rls.map((r: { t: string }) => [r.t, r]));
    // organisation: RLS on, deliberately not FORCEd (pre-auth/bootstrap exception), owned by the NOLOGIN secure owner.
    expect(byName.organisation).toEqual({ t: 'organisation', enabled: true, forced: false, owner: 'rab_secure_owner' });
    for (const t of ['role', 'user_role', 'manager_profile', 'staff_profile', 'workspace_membership', 'audit_log']) {
      expect(byName[t]).toMatchObject({ enabled: true, forced: true });
    }
    // With no tenant bound the runtime role still sees no organisation at all.
    expect(await runtime.query(`SELECT id FROM core.organisation WHERE slug = $1`, [QA_ORGANISATION_SLUG])).toHaveLength(0);
  });
});
