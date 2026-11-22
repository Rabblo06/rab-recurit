import 'reflect-metadata';
import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ReportKey } from '@rab/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { ReportExportService } from '@rab/server/modules/reports/services/report-export.service';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';
import { runReportExportCycle } from '../../queues/rab-reports/report-export.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessTable } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Owner decision 29 — the Worker half of the reports export on the real database (runtime role, FORCE RLS):
 *   - a pending export is built once (a second cycle builds nothing), stored ready with the CSV, the requester gets the
 *     in-app notice and the audit log a `report_export.ready` row; the CSV is scoped to the requester's own shifts;
 *   - a build that cannot succeed (a payroll run that does not exist) fails at once as `not_found`, audited;
 *   - 24 h after it was ready the file is deleted (status expired, content gone, audited) and no link can be issued.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(240_000);

describeIfDb('report export Worker cycle (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let notifications: NotificationService;
  let audit: AuditService;
  let exportsService: ReportExportService;
  let a: TestIdentity;
  let b: TestIdentity;
  let venueId: string;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const ctxOf = (i: TestIdentity) => ({ organisationId: i.organisationId, workspaceId: i.workspaceId, userId: i.userId, role: '' }) as AuthContext;
  const cycle = () => runReportExportCycle(dataSource, tenantContext, notifications, audit, { lateGraceMinutes: 10, organisationId: a.organisationId });
  const rowOf = async (id: string) =>
    (await adminDataSource.query(
      `SELECT e.status, f.csv_content, e.row_count, e.error_code, e.attempts, e.ready_at, e.file_expires_at, e.file_deleted_at
         FROM core.report_export e LEFT JOIN core.report_export_file f ON f.export_id = e.id WHERE e.id = $1`,
      [id],
    ))[0];

  async function seedShift(owner: TestIdentity, startsAt: string, required: number, filled: number, status = 'confirmed'): Promise<void> {
    const [role] = await adminDataSource.query(`SELECT id FROM ${businessTable(owner.workspaceId!, 'job_role')} LIMIT 1`);
    await adminDataSource.query(
      `INSERT INTO ${businessTable(owner.workspaceId!, 'shift')} (organisation_id, venue_id, job_role_id, starts_at, ends_at, required_count, filled_count, pay_rate_pence, created_by, workspace_id, status)
       VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '4 hours', $5, $6, 1500, $7, $8, $9)`,
      [owner.organisationId, venueId, role.id, startsAt, required, filled, owner.userId, owner.workspaceId, status],
    );
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    notifications = moduleRef.get(NotificationService);
    audit = moduleRef.get(AuditService);
    exportsService = moduleRef.get(ReportExportService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    const seeded = await factory.createOrganisationWithManagers(2, { workspace: true, permissions: 'production', label: 'repexp' });
    [a, b] = seeded.managers as [TestIdentity, TestIdentity];
    const tokenA = await factory.login(a);
    venueId = (await http().post('/rest/v1/venues').set(auth(tokenA)).send({ name: `Report Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' })).body.id;
    await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: `Role-${randomUUID()}`, defaultRatePence: 1500 });
    await seedShift(a, '2026-11-03T10:00:00Z', 2, 1);
    await seedShift(a, '2026-11-10T10:00:00Z', 3, 3);
    await seedShift(a, '2026-11-12T10:00:00Z', 5, 0, 'cancelled'); // not counted
    await seedShift(a, '2026-12-02T10:00:00Z', 4, 0); // outside the period
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  it('builds a pending export once, scoped to the requester, notifies and audits; a second cycle builds nothing', async () => {
    const created = await exportsService.request(ctxOf(a), { reportKey: ReportKey.FILL_RATE_BY_VENUE, periodFrom: '2026-11-01', periodTo: '2026-11-30' });
    const bExport = await exportsService.request(ctxOf(b), { reportKey: ReportKey.FILL_RATE_BY_VENUE, periodFrom: '2026-11-01', periodTo: '2026-11-30' });

    // B's cycle is in another workspace; restrict to A's organisation (both are in it) and run.
    const first = await cycle();
    expect(first.built).toBeGreaterThanOrEqual(2);
    const row = await rowOf(created.id);
    expect(row.status).toBe('ready');
    expect(row.csv_content.split('\n')).toEqual([
      'Venue,Period start,Period end,Shifts,Positions,Filled,Unfilled,Fill rate (%)',
      expect.stringMatching(/^Report Venue .{6},2026-11-01,2026-11-30,2,5,4,1,80\.0$/),
    ]);
    expect(row.row_count).toBe(1);
    expect(new Date(row.file_expires_at).getTime() - new Date(row.ready_at).getTime()).toBe(24 * 3600 * 1000);
    // B owns no shift: B's own export is header-only, never A's rows.
    expect((await rowOf(bExport.id)).csv_content).toBe('"Venue","Period start","Period end","Shifts","Positions","Filled","Unfilled","Fill rate (%)"');

    const notes = await adminDataSource.query(`SELECT user_id, type, related_entity_id FROM core.notification WHERE related_entity_id = $1`, [created.id]);
    expect(notes).toEqual([{ user_id: a.userId, type: 'report_export_ready', related_entity_id: created.id }]);
    const audits = await adminDataSource.query(`SELECT action, actor_user_id FROM core.audit_log WHERE entity_id = $1 AND action = 'report_export.ready'`, [created.id]);
    expect(audits).toEqual([{ action: 'report_export.ready', actor_user_id: null }]);

    const second = await cycle();
    expect(second.built).toBe(0);
    expect(await adminDataSource.query(`SELECT count(*)::int AS n FROM core.notification WHERE related_entity_id = $1`, [created.id])).toEqual([{ n: 1 }]);
  });

  it('one export's failing side effect neither undoes its build nor blocks the next export', async () => {
    const first = await exportsService.request(ctxOf(a), { reportKey: ReportKey.FILL_RATE_BY_VENUE, periodFrom: '2026-11-01', periodTo: '2026-11-02' });
    const second = await exportsService.request(ctxOf(a), { reportKey: ReportKey.FILL_RATE_BY_VENUE, periodFrom: '2026-11-03', periodTo: '2026-11-04' });
    const failing = { notify: jest.fn(async () => { throw new Error('notice down'); }) };
    const logged: string[] = [];
    await runReportExportCycle(dataSource, tenantContext, failing, audit, { lateGraceMinutes: 10, organisationId: a.organisationId, log: (l) => logged.push(l) });
    expect((await rowOf(first.id)).status).toBe('ready');
    expect((await rowOf(second.id)).status).toBe('ready');
    expect(logged.some((l) => /side effect report_export_notice failed: Error/.test(l))).toBe(true);
    expect(logged.join('
')).not.toContain('notice down');
  });

  it('a failing audit write is never dropped: that export rolls back to pending, the error name is logged, the next export still builds', async () => {
    const victim = await exportsService.request(ctxOf(b), { reportKey: ReportKey.FILL_RATE_BY_VENUE, periodFrom: '2026-11-05', periodTo: '2026-11-06' });
    const fine = await exportsService.request(ctxOf(a), { reportKey: ReportKey.FILL_RATE_BY_VENUE, periodFrom: '2026-11-07', periodTo: '2026-11-08' });
    class AuditDown extends Error {
      override name = 'AuditDown';
    }
    const flakyAudit = {
      record: jest.fn(async (m: Parameters<AuditService['record']>[0], ctx: { organisationId: string; userId: string }, action: string, opts: { entityId: string } & Record<string, unknown>) => {
        if (opts.entityId === victim.id) throw new AuditDown('audit storage unavailable');
        return audit.record(m, ctx as never, action as never, opts as never);
      }),
    };
    const logged: string[] = [];
    const result = await runReportExportCycle(dataSource, tenantContext, notifications, flakyAudit, { lateGraceMinutes: 10, organisationId: a.organisationId, log: (l) => logged.push(l) });
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(await rowOf(victim.id)).toMatchObject({ status: 'pending', csv_content: null });
    expect((await rowOf(fine.id)).status).toBe('ready');
    expect(logged.some((l) => l.includes(victim.id) && l.includes('AuditDown'))).toBe(true);
    expect(logged.join('
')).not.toContain('audit storage unavailable');
    // With audit back, the export builds on the next cycle.
    await cycle();
    expect((await rowOf(victim.id)).status).toBe('ready');
  });

  it('a build that cannot succeed fails at once (not_found), audited, never retried', async () => {
    // A row for a payroll run that does not exist, written as the requester (the service would have refused it with 404).
    const [{ id }] = await tenantContext.runInTenantContext({ organisationId: a.organisationId, workspaceId: a.workspaceId, userId: a.userId, role: '' }, (m) =>
      m.query(
        `INSERT INTO core.report_export (organisation_id, workspace_id, requested_by, report_key, payroll_run_id, include_pay, include_hours, scope_kind, scope_owner_user_id)
         VALUES ($1, $2, $3, 'payroll_run_summary', $4, true, true, 'owner', $3) RETURNING id`,
        [a.organisationId, a.workspaceId, a.userId, randomUUID()],
      ),
    );
    await cycle();
    expect(await rowOf(id)).toMatchObject({ status: 'failed', error_code: 'not_found', csv_content: null });
    expect(await adminDataSource.query(`SELECT action FROM core.audit_log WHERE entity_id = $1`, [id])).toEqual([{ action: 'report_export.failed' }]);
  });

  it('deletes the file 24 h after it was ready; the row and audit stay; no link afterwards', async () => {
    const created = await exportsService.request(ctxOf(a), { reportKey: ReportKey.HOURS_AND_PAY_BY_VENUE, periodFrom: '2026-11-01', periodTo: '2026-11-30' });
    await cycle();
    expect((await rowOf(created.id)).status).toBe('ready');
    // Age it past 24 h (triggers off for this owner statement only; the CHECK still holds expiry = ready + 24 h).
    await adminDataSource.transaction(async (m) => {
      await m.query(`SET LOCAL session_replication_role = replica`);
      await m.query(`UPDATE core.report_export SET ready_at = now() - interval '25 hours', file_expires_at = now() - interval '1 hour' WHERE id = $1`, [created.id]);
      await m.query(`UPDATE core.report_export_file SET created_at = now() - interval '25 hours', file_expires_at = now() - interval '1 hour' WHERE export_id = $1`, [created.id]);
    });
    const result = await cycle();
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const row = await rowOf(created.id);
    expect(row).toMatchObject({ status: 'expired', csv_content: null });
    // The content is gone; a tombstone row stays so no second file can ever be stored for this export.
    expect(await adminDataSource.query(`SELECT csv_content, purged_at IS NOT NULL AS purged FROM core.report_export_file WHERE export_id = $1`, [created.id])).toEqual([{ csv_content: null, purged: true }]);
    expect(row.file_deleted_at).not.toBeNull();
    expect(await adminDataSource.query(`SELECT action FROM core.audit_log WHERE entity_id = $1 AND action = 'report_export.file_deleted'`, [created.id])).toHaveLength(1);
    await expect(exportsService.issueLink(ctxOf(a), created.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
