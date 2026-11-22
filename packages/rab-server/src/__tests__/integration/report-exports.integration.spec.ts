import 'reflect-metadata';
import { ForbiddenException, HttpException, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PermissionFlag, PermissionFlagType, ReportKey } from '@rab/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { businessTables } from '../../engine/core-modules/tenant/business-tables';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { ReportExportService } from '../../modules/reports/services/report-export.service';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Owner decision 29, reports page v1 — the API half on the real AppModule (runtime role, FORCE RLS, no mocks):
 *   - database: no tenant context → 0 rows; another user's session → 0 rows; a person can never write the file or the
 *     status (guard + grants), the Worker never writes a link, nobody deletes a row;
 *   - abuse: organisationId / includePay / status in the body → 400; staff → 403; a Venue Manager → 403 on the payroll
 *     run summary, 404 on another venue, never pay; another manager / organisation → 404 on list, link and download;
 *     the hourly limit → 429; a used or expired link → 404; a lost pay permission → 403 at download.
 * The Worker half (building, notifying, deleting after 24 h) is rab-worker's report-export.integration.spec.ts.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(240_000);

const pgCode = (e: unknown) => (e as { driverError?: { code?: string }; code?: string })?.driverError?.code ?? (e as { code?: string })?.code;

describeIfDb('reports: background CSV exports (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let service: ReportExportService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    tenantContext = moduleRef.get(TenantContextService);
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(ReportExportService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const ctxOf = (i: TestIdentity) => ({ organisationId: i.organisationId, workspaceId: i.workspaceId, userId: i.userId, role: '' }) as AuthContext;
  const PERIOD = { periodFrom: '2026-11-01', periodTo: '2026-11-30' };

  async function venueOf(owner: TestIdentity, name: string): Promise<string> {
    const v = await tenantContext.runInTenantContext(
      { organisationId: owner.organisationId, workspaceId: owner.workspaceId, userId: owner.userId, role: '' },
      (m) => m.save(Venue, { organisationId: owner.organisationId, name, workspaceId: owner.workspaceId!, createdBy: owner.userId }),
    );
    return v.id;
  }

  async function workspace(label: string) {
    const org = await factory.createOrganisation(label);
    const manager = await factory.createInternalManager(org, { permissions: 'production' });
    return { org, manager, token: await factory.login(manager) };
  }

  /** Marks an export ready exactly as the Worker does (its own binding, rab.actor_type = 'worker'). */
  /** Marks an export ready exactly as the Worker does: the file through the Worker-only definer, then the export row. */
  async function markReady(owner: TestIdentity, id: string, csv = 'Venue,Shifts\nPier,1'): Promise<void> {
    await tenantContext.runInTenantContext({ organisationId: owner.organisationId, workspaceId: owner.workspaceId, userId: '', role: '', actorType: 'worker' }, async (m) => {
      const [{ requested_by }] = await m.query(`SELECT requested_by FROM core.report_export WHERE id = $1`, [id]);
      await m.query(`SELECT core.report_export_file_put($1::uuid, $2::uuid, $3::text)`, [id, requested_by, csv]);
      await m.query(
        `UPDATE core.report_export SET status = 'ready', csv_bytes = octet_length($2), row_count = 1, ready_at = now(), file_expires_at = now() + interval '24 hours' WHERE id = $1`,
        [id, csv],
      );
    });
  }

  /** Ages an export's file (and link) past their expiry: triggers off for this one owner statement; the CHECKs still hold. */
  async function ageFile(id: string): Promise<void> {
    await adminDataSource.transaction(async (m) => {
      await m.query(`SET LOCAL session_replication_role = replica`);
      await m.query(`UPDATE core.report_export_file SET created_at = now() - interval '25 hours', file_expires_at = now() - interval '1 hour' WHERE export_id = $1`, [id]);
      await m.query(`UPDATE core.report_export SET ready_at = now() - interval '25 hours', file_expires_at = now() - interval '1 hour' WHERE id = $1`, [id]);
    });
  }

  const asWorker = <T>(owner: TestIdentity, fn: (m: EntityManager) => Promise<T>) =>
    tenantContext.runInTenantContext({ organisationId: owner.organisationId, workspaceId: owner.workspaceId, userId: '', role: '', actorType: 'worker' }, fn);
  const asUser = <T>(who: TestIdentity, fn: (m: EntityManager) => Promise<T>) =>
    tenantContext.runInTenantContext({ organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' }, fn);

  async function withRevoked<T>(identity: TestIdentity, flag: PermissionFlagType, fn: () => Promise<T>): Promise<T> {
    await adminDataSource.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3`,
      [identity.userId, identity.organisationId, flag],
    );
    await adminDataSource.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [identity.userId]);
    try {
      return await fn();
    } finally {
      await adminDataSource.query(`DELETE FROM core.user_permission_override WHERE user_id = $1 AND permission_id = (SELECT id FROM core.permission WHERE key = $2)`, [identity.userId, flag]);
      await adminDataSource.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [identity.userId]);
    }
  }

  it('happy path: request (202, pending, pay included for a payroll.view holder) → list → ready → single-use link → CSV once', async () => {
    const { manager, token } = await workspace('rep-happy');
    const created = await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: ReportKey.HOURS_AND_PAY_BY_VENUE, ...PERIOD });
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ reportKey: 'hours_and_pay_by_venue', status: 'pending', includePay: true, periodFrom: '2026-11-01', periodTo: '2026-11-30' });
    expect(created.body).not.toHaveProperty('csvContent');

    const listed = await http().get('/rest/v1/reports/exports').set(auth(token));
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((e: { id: string }) => e.id)).toContain(created.body.id);

    // Not ready yet: no link.
    expect((await http().post(`/rest/v1/reports/exports/${created.body.id}/link`).set(auth(token))).status).toBe(404);

    await markReady(manager, created.body.id, 'Venue,Gross\n=1+1,2.00');
    const link = await http().post(`/rest/v1/reports/exports/${created.body.id}/link`).set(auth(token));
    expect(link.status).toBe(201);
    expect(link.body.expiresInSeconds).toBe(60);
    expect(link.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only the hash is stored.
    const [stored] = await adminDataSource.query(`SELECT download_token_hash FROM core.report_export_file WHERE export_id = $1`, [created.body.id]);
    expect(stored.download_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.download_token_hash).not.toContain(link.body.token);

    const file = await http().post(`/rest/v1/reports/exports/${created.body.id}/download`).set(auth(token)).send({ token: link.body.token });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/text\/csv/);
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.text).toBe('Venue,Gross\n=1+1,2.00'); // stored as the Worker built it (the builders neutralise cells)

    // Single use.
    expect((await http().post(`/rest/v1/reports/exports/${created.body.id}/download`).set(auth(token)).send({ token: link.body.token })).status).toBe(404);
    const audit = await adminDataSource.query(`SELECT action FROM core.audit_log WHERE entity_id = $1 ORDER BY created_at`, [created.body.id]);
    expect(audit.map((a: { action: string }) => a.action)).toEqual(['report_export.requested', 'report_export.link_issued', 'report_export.downloaded']);
  });

  it('an expired link is refused (404)', async () => {
    const { manager, token } = await workspace('rep-expired');
    const { id } = (await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: ReportKey.FILL_RATE_BY_VENUE, ...PERIOD })).body;
    await markReady(manager, id);
    const link = (await http().post(`/rest/v1/reports/exports/${id}/link`).set(auth(token))).body;
    // Age the link past 60 s (triggers off for this one owner statement; the CHECK still holds issue + 60 s).
    await adminDataSource.transaction(async (m) => {
      await m.query(`SET LOCAL session_replication_role = replica`);
      await m.query(`UPDATE core.report_export_file SET download_token_issued_at = now() - interval '2 minutes', download_token_expires_at = now() - interval '1 minute' WHERE export_id = $1`, [id]);
    });
    expect((await http().post(`/rest/v1/reports/exports/${id}/download`).set(auth(token)).send({ token: link.token })).status).toBe(404);
    // A fresh link works again.
    const again = (await http().post(`/rest/v1/reports/exports/${id}/link`).set(auth(token))).body;
    expect((await http().post(`/rest/v1/reports/exports/${id}/download`).set(auth(token)).send({ token: again.token })).status).toBe(200);
  });

  it('mass assignment: organisationId, includePay, status or any unknown field in the body is a 400', async () => {
    const { token } = await workspace('rep-mass');
    const other = await factory.createOrganisation('rep-mass-other');
    for (const extra of [{ organisationId: other.id }, { includePay: true }, { status: 'ready' }, { scopeKind: 'owner' }, { workspaceId: randomUUID() }]) {
      const res = await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: ReportKey.HOURS_AND_PAY_BY_VENUE, ...PERIOD, ...extra });
      expect(res.status).toBe(400);
    }
    expect((await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: 'everything', ...PERIOD })).status).toBe(400);
    expect((await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: ReportKey.HOURS_AND_PAY_BY_VENUE, periodFrom: '2026-12-01', periodTo: '2026-11-01' })).status).toBe(400);
    expect((await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: ReportKey.HOURS_AND_PAY_BY_VENUE, periodFrom: '2025-01-01', periodTo: '2026-01-02' })).status).toBe(400);
    expect((await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: ReportKey.PAYROLL_RUN_SUMMARY, ...PERIOD })).status).toBe(400);
    expect((await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: ReportKey.PAYROLL_RUN_SUMMARY, payrollRunId: randomUUID() })).status).toBe(404);
  });

  it('another manager (other organisation) and staff never see, link or download an export: 404 / 403', async () => {
    const a = await workspace('rep-iso-a');
    const b = await workspace('rep-iso-b');
    const { id } = (await http().post('/rest/v1/reports/exports').set(auth(a.token)).send({ reportKey: ReportKey.HOURS_AND_PAY_BY_VENUE, ...PERIOD })).body;
    await markReady(a.manager, id);
    const aLink = (await http().post(`/rest/v1/reports/exports/${id}/link`).set(auth(a.token))).body;

    expect((await http().get('/rest/v1/reports/exports').set(auth(b.token))).body.data).toEqual([]);
    expect((await http().post(`/rest/v1/reports/exports/${id}/link`).set(auth(b.token))).status).toBe(404);
    // Even holding A's valid token, B gets 404 and the link stays unused.
    expect((await http().post(`/rest/v1/reports/exports/${id}/download`).set(auth(b.token)).send({ token: aLink.token })).status).toBe(404);

    // A second manager in A's own organisation (their own workspace) sees nothing of A's either.
    const a2 = await factory.createInternalManager(a.org, { permissions: 'production', label: 'mgr2' });
    const a2Token = await factory.login(a2);
    expect((await http().get('/rest/v1/reports/exports').set(auth(a2Token))).body.data).toEqual([]);
    expect((await http().post(`/rest/v1/reports/exports/${id}/download`).set(auth(a2Token)).send({ token: aLink.token })).status).toBe(404);

    // Staff hold neither report flag.
    const staff = await factory.createStaff(a.org, { owner: a.manager });
    await expect(service.request(ctxOf(staff), { reportKey: ReportKey.FILL_RATE_BY_VENUE, ...PERIOD })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.list(ctxOf(staff))).rejects.toBeInstanceOf(ForbiddenException);

    // A's link was never burnt by the refused attempts.
    expect((await http().post(`/rest/v1/reports/exports/${id}/download`).set(auth(a.token)).send({ token: aLink.token })).status).toBe(200);
  });

  it('a Venue Manager: own venues only (404 elsewhere), never pay, never the payroll run summary (403)', async () => {
    const { org, manager } = await workspace('rep-vm');
    const mine = await venueOf(manager, 'Mine');
    const other = await venueOf(manager, 'Other');
    const vm = await factory.createVenueManager(org, { owner: manager, venueIds: [mine] });
    const ctx = ctxOf(vm);

    const own = await service.request(ctx, { reportKey: ReportKey.HOURS_AND_PAY_BY_VENUE, ...PERIOD, venueId: mine });
    expect(own.includePay).toBe(false);
    const [row] = await adminDataSource.query(`SELECT scope_kind, scope_venue_ids, include_pay FROM core.report_export WHERE id = $1`, [own.id]);
    expect(row).toMatchObject({ scope_kind: 'venue', scope_venue_ids: [mine], include_pay: false });

    await expect(service.request(ctx, { reportKey: ReportKey.HOURS_AND_PAY_BY_VENUE, ...PERIOD, venueId: other })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.request(ctx, { reportKey: ReportKey.HOURS_AND_PAY_BY_VENUE, ...PERIOD, venueId: randomUUID() })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.request(ctx, { reportKey: ReportKey.PAYROLL_RUN_SUMMARY, payrollRunId: randomUUID() })).rejects.toBeInstanceOf(ForbiddenException);

    // Unassigned from the venue after asking: the download is refused (404), the file is not handed out.
    await markReady(manager, own.id);
    const { token } = await service.issueLink(ctx, own.id);
    await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' }, (m) =>
      m.query(`DELETE FROM ${businessTables(m).manager_venue} WHERE manager_profile_id = $1`, [vm.profileId]),
    );
    await expect(service.download(ctx, own.id, token)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('pay columns are re-checked at download: losing payroll.view after asking refuses the file (403)', async () => {
    const { manager, token } = await workspace('rep-pay');
    const { id, includePay } = (await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: ReportKey.HOURS_AND_PAY_BY_VENUE, ...PERIOD })).body;
    expect(includePay).toBe(true);
    await markReady(manager, id);
    const link = await service.issueLink(ctxOf(manager), id);
    await withRevoked(manager, PermissionFlag.PAYROLL_VIEW, async () => {
      await expect(service.download(ctxOf(manager), id, link.token)).rejects.toBeInstanceOf(ForbiddenException);
      // Without payroll.view a NEW export of the same report has no pay column.
      const fresh = await service.request(ctxOf(manager), { reportKey: ReportKey.HOURS_AND_PAY_BY_VENUE, ...PERIOD });
      expect(fresh.includePay).toBe(false);
      await expect(service.request(ctxOf(manager), { reportKey: ReportKey.PAYROLL_RUN_SUMMARY, payrollRunId: randomUUID() })).rejects.toBeInstanceOf(NotFoundException);
    });
    await withRevoked(manager, PermissionFlag.REPORT_EXPORT, async () => {
      expect((await http().post(`/rest/v1/reports/exports/${id}/link`).set(auth(token))).status).toBe(403);
      await expect(service.issueLink(ctxOf(manager), id)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('each report also needs its object flag (attendance.view / schedule.view) at request, link issue and download (403)', async () => {
    const { manager, token } = await workspace('rep-objflag');
    const { id } = (await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: ReportKey.ATTENDANCE_EXCEPTIONS, ...PERIOD })).body;
    await markReady(manager, id);
    const link = await service.issueLink(ctxOf(manager), id);
    await withRevoked(manager, PermissionFlag.ATTENDANCE_VIEW, async () => {
      expect((await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: ReportKey.ATTENDANCE_EXCEPTIONS, ...PERIOD })).status).toBe(403);
      expect((await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: ReportKey.WEEKLY_HOURS_PER_STAFF, ...PERIOD })).status).toBe(403);
      await expect(service.issueLink(ctxOf(manager), id)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.download(ctxOf(manager), id, link.token)).rejects.toBeInstanceOf(ForbiddenException);
      // Fill rate needs schedule.view, not attendance.view.
      expect((await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: ReportKey.FILL_RATE_BY_VENUE, ...PERIOD })).status).toBe(202);
    });
    await withRevoked(manager, PermissionFlag.SCHEDULE_VIEW, async () => {
      expect((await http().post('/rest/v1/reports/exports').set(auth(token)).send({ reportKey: ReportKey.FILL_RATE_BY_VENUE, ...PERIOD })).status).toBe(403);
    });
    // The refused attempts never burnt the link.
    expect((await service.download(ctxOf(manager), id, link.token)).csv).toContain('Venue');
  });

  it('each user may start a limited number of exports per hour (429 after 10)', async () => {
    const { manager } = await workspace('rep-rate');
    for (let i = 0; i < 10; i++) await service.request(ctxOf(manager), { reportKey: ReportKey.FILL_RATE_BY_VENUE, ...PERIOD });
    const refused = await service.request(ctxOf(manager), { reportKey: ReportKey.FILL_RATE_BY_VENUE, ...PERIOD }).catch((e) => e);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(429);
  });

  it('database: no tenant context → 0 rows; another user → 0 rows; the runtime login holds no privilege on the file table; only the Worker updates; no DELETE; the database starts every row', async () => {
    const { org, manager } = await workspace('rep-db');
    const created = await service.request(ctxOf(manager), { reportKey: ReportKey.FILL_RATE_BY_VENUE, ...PERIOD });
    const id = created.id;

    expect(await dataSource.transaction((m) => m.query(`SELECT id FROM core.report_export WHERE id = $1`, [id]))).toEqual([]);
    const other = await factory.createInternalManager(org, { permissions: 'production', label: 'other' });
    expect(await asUser(other, (m) => m.query(`SELECT id FROM core.report_export WHERE id = $1`, [id]))).toEqual([]);

    // A person never updates an export (no update policy; the guard refuses a non-Worker update for the owner login).
    const personUpdate = await asUser(manager, (m) => m.query(`UPDATE core.report_export SET status = 'ready', csv_bytes = 1, ready_at = now(), file_expires_at = now() + interval '24 hours' WHERE id = $1 RETURNING id`, [id])).catch((e) => e);
    if (Array.isArray(personUpdate)) expect(personUpdate[0]).toEqual([]); // RLS: zero rows visible to update
    else expect(pgCode(personUpdate)).toMatch(/^(42501|23514)$/);
    expect((await adminDataSource.query(`SELECT status FROM core.report_export WHERE id = $1`, [id]))[0].status).toBe('pending');

    // The database starts every row: a backdated, pre-built insert is stored as a fresh pending row created now.
    const inserted = await asUser(manager, (m) =>
      m.query(
        `INSERT INTO core.report_export (organisation_id, workspace_id, requested_by, report_key, period_from, period_to, include_pay, include_hours, scope_kind, scope_owner_user_id)
         VALUES ($1, $2, $3, 'fill_rate_by_venue', '2026-11-01', '2026-11-02', false, false, 'owner', $3) RETURNING id`,
        [org.id, manager.workspaceId, manager.userId],
      ),
    );
    const backdated = await adminDataSource.transaction(async (m) => {
      // As the table owner (the owner-login shape: column grants do not bind it), still through the BEFORE INSERT trigger.
      await m.query(`SET LOCAL ROLE crewflow`);
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [org.id, manager.workspaceId, manager.userId]);
      return m.query(
        `INSERT INTO core.report_export (organisation_id, workspace_id, requested_by, report_key, period_from, period_to, include_pay, include_hours, scope_kind, scope_owner_user_id, status, attempts, row_count, created_at)
         VALUES ($1, $2, $3, 'fill_rate_by_venue', '2026-11-01', '2026-11-02', false, false, 'owner', $3, 'pending', 0, 99, '2001-01-01T00:00:00Z') RETURNING id`,
        [org.id, manager.workspaceId, manager.userId],
      );
    });
    const [fresh] = await adminDataSource.query(`SELECT status, attempts, row_count, created_at > now() - interval '1 minute' AS recent FROM core.report_export WHERE id = $1`, [backdated[0].id]);
    expect(fresh).toEqual({ status: 'pending', attempts: 0, row_count: null, recent: true });
    expect(inserted[0].id).toBeDefined();

    // The file table: the runtime login can neither read nor write it directly, even its own row.
    await markReady(manager, id, 'secret,content');
    expect(pgCode(await asUser(manager, (m) => m.query(`SELECT csv_content FROM core.report_export_file WHERE export_id = $1`, [id])).catch((e) => e))).toBe('42501');
    expect(pgCode(await asWorker(manager, (m) => m.query(`SELECT csv_content FROM core.report_export_file WHERE export_id = $1`, [id])).catch((e) => e))).toBe('42501');
    expect(pgCode(await asUser(manager, (m) => m.query(`UPDATE core.report_export_file SET download_count = 0 WHERE export_id = $1`, [id])).catch((e) => e))).toBe('42501');
    expect(pgCode(await asUser(manager, (m) => m.query(`DELETE FROM core.report_export_file WHERE export_id = $1`, [id])).catch((e) => e))).toBe('42501');
    // The definers keep their callers apart: a person cannot store or purge a file, the Worker cannot issue or take a link.
    expect(pgCode(await asUser(manager, (m) => m.query(`SELECT core.report_export_file_put($1::uuid, $2::uuid, 'x')`, [randomUUID(), manager.userId])).catch((e) => e))).toBe('42501');
    expect(pgCode(await asUser(manager, (m) => m.query(`SELECT core.report_export_file_purge($1::uuid)`, [id])).catch((e) => e))).toBe('42501');
    expect((await asWorker(manager, (m) => m.query(`SELECT core.report_export_file_issue_link($1::uuid, repeat('a', 64)) AS ok`, [id])))[0].ok).toBe(false);
    // Another user of the organisation gets nothing from the definers.
    expect((await asUser(other, (m) => m.query(`SELECT core.report_export_file_issue_link($1::uuid, repeat('a', 64)) AS ok`, [id])))[0].ok).toBe(false);

    // The Worker cannot delete a file early, nor move the export back.
    expect((await asWorker(manager, (m) => m.query(`SELECT core.report_export_file_purge($1::uuid) AS purged`, [id])))[0].purged).toBe(false);
    expect(pgCode(await asWorker(manager, (m) => m.query(`UPDATE core.report_export SET status = 'expired', file_deleted_at = now() WHERE id = $1`, [id])).catch((e) => e))).toBe('23514');
    expect(pgCode(await asWorker(manager, (m) => m.query(`UPDATE core.report_export SET status = 'pending', csv_bytes = NULL, row_count = NULL, ready_at = NULL, file_expires_at = NULL WHERE id = $1`, [id])).catch((e) => e))).toBe('23514');

    // No DELETE for the runtime login on the export row (grant parity / no grant); the row stays.
    expect(pgCode(await asUser(manager, (m) => m.query(`DELETE FROM core.report_export WHERE id = $1`, [id])).catch((e) => e))).toBe('42501');
    expect(await adminDataSource.query(`SELECT 1 FROM core.report_export WHERE id = $1`, [id])).toHaveLength(1);

    // The file must belong to an existing export of this workspace with the same requester (composite FK), once (PK).
    expect(pgCode(await asWorker(manager, (m) => m.query(`SELECT core.report_export_file_put($1::uuid, $2::uuid, 'x')`, [randomUUID(), manager.userId])).catch((e) => e))).toBe('23503');
    expect(pgCode(await asWorker(manager, (m) => m.query(`SELECT core.report_export_file_put($1::uuid, $2::uuid, 'x')`, [inserted[0].id, other.userId])).catch((e) => e))).toBe('23503');
    expect(pgCode(await asWorker(manager, (m) => m.query(`SELECT core.report_export_file_put($1::uuid, $2::uuid, 'x')`, [id, manager.userId])).catch((e) => e))).toBe('23505');

    // A link issued (database-fixed 60 s); a session bound to another organisation gets nothing from it and does not burn it.
    const otherOrg = await factory.createOrganisation('rep-db-other');
    const stranger = await factory.createInternalManager(otherOrg, { permissions: 'production' });
    const live = 'e'.repeat(64);
    expect((await asUser(manager, (m) => m.query(`SELECT core.report_export_file_issue_link($1::uuid, $2::text) AS ok`, [id, live])))[0].ok).toBe(true);
    const crossOrg = await tenantContext.runInTenantContext({ organisationId: otherOrg.id, workspaceId: stranger.workspaceId, userId: manager.userId, role: '' }, (m) =>
      m.query(`SELECT core.report_export_file_take($1::uuid, $2::text) AS csv`, [id, live]),
    );
    expect(crossOrg[0].csv).toBeNull();
    expect((await asUser(manager, (m) => m.query(`SELECT core.report_export_file_take($1::uuid, $2::text) AS csv`, [id, live])))[0].csv).toBe('secret,content');

    // Then the file expires: issuing and using a link are refused by the database.
    const hash = 'c'.repeat(64);
    expect((await asUser(manager, (m) => m.query(`SELECT core.report_export_file_issue_link($1::uuid, $2::text) AS ok`, [id, hash])))[0].ok).toBe(true);
    const [link] = await adminDataSource.query(`SELECT extract(epoch FROM download_token_expires_at - download_token_issued_at)::int AS ttl FROM core.report_export_file WHERE export_id = $1`, [id]);
    expect(link.ttl).toBe(60);
    await ageFile(id);
    expect((await asUser(manager, (m) => m.query(`SELECT core.report_export_file_take($1::uuid, $2::text) AS csv`, [id, hash])))[0].csv).toBeNull();
    expect((await asUser(manager, (m) => m.query(`SELECT core.report_export_file_issue_link($1::uuid, $2::text) AS ok`, [id, 'd'.repeat(64)])))[0].ok).toBe(false);
    await expect(service.issueLink(ctxOf(manager), id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
