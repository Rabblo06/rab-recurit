import 'reflect-metadata';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { executeCalendarImport } from '../../command/payroll-import-calendar.command';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { PayrollCalendarService } from '../../modules/payroll/services/payroll-calendar.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * `payroll:import-calendar` on the RUNTIME role. Regression for the dev finding (2026-10-21): the command looked up the
 * organisation / actor with no tenant context, which only worked on a privileged connection — on `crewflow_app` RLS
 * correctly returned zero rows ("No such manager in that organisation."). The command logic now runs entirely through
 * pre-auth routing + tenant contexts; this suite drives it with the application DataSource (crewflow_app, RLS forced).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(240_000);

describeIfDb('payroll:import-calendar command on the runtime role (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let deps: Parameters<typeof executeCalendarImport>[0];
  let orgId: string;
  let orgSlug: string;
  let initial: TestIdentity;
  let internal: TestIdentity;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = moduleRef.get(DataSource);
    const tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    const factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    const seeded = await factory.createOrganisationWithManagers(2, { workspace: true, permissions: 'production', label: 'calcli' });
    orgId = seeded.organisation.id;
    orgSlug = seeded.organisation.slug;
    [initial, internal] = seeded.managers as [TestIdentity, TestIdentity];
    await adminDataSource.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE user_id = $1`, [initial.userId]);
    deps = { dataSource, tenantContext, calendars: moduleRef.get(PayrollCalendarService) };
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  it('runs on crewflow_app, which cannot bypass RLS and sees no organisation rows without a tenant context', async () => {
    const [who] = await dataSource.query(`SELECT current_user AS u, r.rolbypassrls AS b FROM pg_roles r WHERE r.rolname = current_user`);
    expect(who).toEqual({ u: 'crewflow_app', b: false });
    expect(await dataSource.query(`SELECT id FROM core.organisation WHERE id = $1`, [orgId])).toEqual([]);
  });

  it('the Initial Manager can dry-run and import by organisation slug or id', async () => {
    const dry = await executeCalendarImport(deps, { org: orgSlug, actor: initial.email.toUpperCase(), official2026: true, dryRun: true });
    expect(dry).toMatchObject({ ok: true, applied: false, version: null, report: { periodCount: 28, overlaps: [], errors: [] } });
    expect(await adminDataSource.query(`SELECT 1 FROM core.payroll_calendar WHERE organisation_id = $1`, [orgId])).toEqual([]);
    const real = await executeCalendarImport(deps, { org: orgId, actor: initial.email, official2026: true });
    expect(real).toMatchObject({ ok: true, applied: true, version: 1 });
    const [audit] = await adminDataSource.query(`SELECT actor_user_id FROM core.audit_log WHERE organisation_id = $1 AND action = 'payroll_calendar.imported'`, [orgId]);
    expect(audit.actor_user_id).toBe(initial.userId);
  });

  it('refuses a non-Initial actor, an unknown actor, an unknown organisation and missing arguments', async () => {
    expect(await executeCalendarImport(deps, { org: orgSlug, actor: internal.email, official2026: true, dryRun: true }))
      .toEqual({ ok: false, message: "Refused: --actor must be the organisation's current Initial Manager." });
    expect(await executeCalendarImport(deps, { org: orgSlug, actor: 'nobody@example.test', official2026: true, dryRun: true }))
      .toEqual({ ok: false, message: 'No such manager in that organisation.' });
    expect(await executeCalendarImport(deps, { org: 'no-such-org-slug', actor: initial.email, official2026: true, dryRun: true }))
      .toEqual({ ok: false, message: 'No such organisation.' });
    expect((await executeCalendarImport(deps, { org: orgSlug })).ok).toBe(false);
    const versions = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.payroll_calendar WHERE organisation_id = $1`, [orgId]);
    expect(versions[0].n).toBe(1);
  });
});
