import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { resolveIntegrationTestDatabase } from '@rab/server/database/typeorm/core/test-database-guard';
import { provisionWorkspaceSchema } from '@rab/server/database/typeorm/workspace-schema/provision-workspace-schema';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { SchemaResolverService } from '@rab/server/engine/core-modules/tenant/schema-resolver.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { SHIFT_STATEMENT_MAX_ATTEMPTS, ShiftStatementJobData } from '@rab/server/modules/payroll/constants/shift-statement';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { DispatchQueue, DispatchScopeWork, runGlobalDispatch } from '../../core/database/dispatch-claims';
import { DispatchCoordinator, DispatchQueueBinding } from '../../core/wake/dispatch-coordinator';
import { dispatchEmailScope, runEmailDispatchCycle } from '../../queues/rab-email/email-dispatch.job';
import { dispatchPushScope, runPushDispatchCycle } from '../../queues/rab-push/push-dispatch.job';
import { publishRealtimeScope, runRealtimeOutboxPublishCycle } from '../../queues/rab-realtime/publish-outbox.job';
import { dispatchStatementScope, runShiftStatementDispatchCycle } from '../../queues/rab-reports/shift-statement.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Phase D wave 2 — FIRST CUTOVER (owner prompt §9). The pointer table starts EMPTY: work written before the pointer
 * triggers existed has no pointer until its next state change, so the global claim alone never sees it. In global mode
 * the coordinator's FIRST tick after start runs the legacy per-scope sweep (reconcileDueAt = 0; B-report d2 §4), which
 * finds and dispatches it — so no pre-cutover pending work waits for the 900 s reconciliation interval.
 *
 * OPT-IN: needs migrations 1786721300000–1786721320000 applied and the operator-created `crewflow_worker` login.
 * Skipped unless PHASE_D_SQL_APPROVED=true and TEST_DATABASE_WORKER_URL are set. The admin connection
 * (TEST_DATABASE_URL_UNPOOLED) must be the test cluster's SUPERUSER: it is the only identity that can remove the
 * fixtures' pointers (pointer table: rab_secure_owner, FORCE RLS, runtime deny policy) to reproduce "rows written before
 * the triggers existed". It deletes ONLY the pointers of this suite's own rows.
 *
 *  1. Synthetic PENDING email / push / realtime rows in TWO organisations and one pending statement request, then their
 *     pointers removed → no pointer exists for any of them.
 *  2. The global claim alone (what a wake-up runs) does not reach them.
 *  3. ONE tick per queue on a fresh global-mode coordinator (= the first tick after Worker start) dispatches every one of
 *     them exactly once, each under its own organisation (publish callbacks / job data / envelope carry the row's own
 *     organisation; every globally-claimed scope only ever holds subjects of that scope's organisation).
 *
 * Wave 3 (owner request (b)): statement rows in a WORKSPACE SCHEMA too. Organisation B's workspace is provisioned to
 * READY (real provisioner, as `crewflow`) and a pending payroll_record is written straight into `workspace_<hex>` with
 * `session_replication_role = replica` (superuser, that transaction only) — no trigger fires, exactly like a row that
 * existed before module v1.019 put the pointer triggers on that schema. The test app runs HWS off, so organisation B's
 * statement scopes use an HWS-ON TenantContextService (the construction of report-email-recipient-safety-hws.integration
 * .spec.ts); production's Worker has one tenant context with HWS on for every organisation.
 */
const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;
const RUN = process.env.PHASE_D_SQL_APPROVED === 'true' && Boolean(WORKER_URL && process.env.DATABASE_URL);
const describeIfApproved = RUN ? describe : describe.skip;
const TEST_ENV = 'inttest';
jest.setTimeout(300_000);

describeIfApproved('Phase D first cutover: pre-trigger pending work is dispatched by the first reconciliation (integration — opt-in)', () => {
  let app: INestApplication;
  let runtime: DataSource;
  let admin: DataSource;
  let worker: DataSource;
  let tenantContext: TenantContextService;
  let attendanceQr: AttendanceQrService;
  let factory: TestIdentityFactory;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** subject id → its own organisation (the oracle for "no cross-tenant processing"). */
  const orgOf = new Map<string, string>();
  const ids: Record<DispatchQueue, string[]> = { email: [], push: [], realtime: [], statement: [] };
  let orgA: TestIdentity;
  let orgB: TestIdentity;
  let hwsTenant: TenantContextService;
  let provisioner: Client;
  /** Organisation B's physical workspace schema and the pre-trigger statement row written into it. */
  let wsSchema: string;
  let wsStatementId: string;
  let coreSourceOfWsStatement: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    runtime = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    attendanceQr = app.get(AttendanceQrService);
    admin = createAdminDataSource();
    await admin.initialize();
    const [{ rolsuper }] = await admin.query<[{ rolsuper: boolean }]>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    expect(rolsuper).toBe(true); // see the box above
    factory = new TestIdentityFactory({ app, dataSource: runtime, adminDataSource: admin, tenantContext, passwordHashing: app.get(PasswordHashingService) });
    worker = new DataSource({ type: 'postgres', url: WORKER_URL, entities: [], synchronize: false, extra: { max: 4, application_name: 'crewflow-worker-it' } });
    await worker.initialize();
    const [{ current_user: who }] = await worker.query<[{ current_user: string }]>('SELECT current_user');
    expect(who).toBe('crewflow_worker');

    // ── fixtures: two organisations, each with email / push / realtime pending work ──────────────────────────────────
    const seededA = await factory.createOrganisationWithManagers(1, { workspace: true, permissions: 'production', label: 'cut-a' });
    const seededB = await factory.createOrganisationWithManagers(1, { workspace: true, permissions: 'production', label: 'cut-b' });
    orgA = seededA.managers[0]!;
    orgB = seededB.managers[0]!;
    for (const owner of [orgA, orgB]) {
      for (let i = 0; i < 3; i += 1) {
        ids.email.push(await seedEmail(owner));
        ids.push.push(await seedPush(owner));
        ids.realtime.push(await seedRealtime(owner));
      }
    }
    // One pending Approved Shift Statement request in organisation A (the real approval flow; the Worker dispatches it).
    ids.statement.push(await approvedRecord(seededA.organisation, orgA));

    // Wave 3 (b): a pending statement row in organisation B's PHYSICAL workspace schema, written with no trigger firing.
    const env = app.get(EnvironmentService);
    const hwsEnv = { get: (key: string) => (key === 'HWS_RUNTIME_ENABLED' ? true : env.get(key as never)) } as unknown as EnvironmentService;
    hwsTenant = new TenantContextService(runtime, app.get(SchemaResolverService), hwsEnv);
    coreSourceOfWsStatement = await approvedRecord(seededB.organisation, orgB); // a real approved record (core) as the template
    orgOf.delete(coreSourceOfWsStatement);
    const { adminUrl } = resolveIntegrationTestDatabase(process.env);
    provisioner = new Client({ connectionString: adminUrl });
    await provisioner.connect();
    await provisioner.query('SET ROLE crewflow'); // the real provisioner identity
    const provisioned = await provisionWorkspaceSchema(provisioner, orgB.workspaceId!);
    expect(provisioned.outcome).toBe('READY');
    wsSchema = provisioned.schemaName;
    expect(wsSchema).toMatch(/^workspace_[0-9a-f]{32}$/);
    wsStatementId = randomUUID();
    await admin.transaction(async (m) => {
      await m.query('SET LOCAL session_replication_role = replica'); // no trigger fires: a "pre-trigger" row
      await m.query(
        `INSERT INTO "${wsSchema}".payroll_record
           SELECT * FROM jsonb_populate_record(NULL::"${wsSchema}".payroll_record,
             (SELECT to_jsonb(c) || jsonb_build_object('id', $2::uuid) FROM core.payroll_record c WHERE c.id = $1))`,
        [coreSourceOfWsStatement, wsStatementId],
      );
      // The core template must not be due itself.
      await m.query(`UPDATE core.payroll_record SET statement_status = 'failed', statement_attempts = $2 WHERE id = $1`, [coreSourceOfWsStatement, SHIFT_STATEMENT_MAX_ATTEMPTS]);
    });
    const [wsRow] = await admin.query<[{ statement_status: string; workspace_id: string }]>(
      `SELECT statement_status, workspace_id FROM "${wsSchema}".payroll_record WHERE id = $1`,
      [wsStatementId],
    );
    expect(wsRow).toEqual({ statement_status: 'pending', workspace_id: orgB.workspaceId });
    ids.statement.push(wsStatementId);
    orgOf.set(wsStatementId, orgB.organisationId);

    // ── "written before the triggers existed": remove exactly these rows' pointers ───────────────────────────────────
    const all = [...Object.values(ids).flat(), coreSourceOfWsStatement];
    await admin.query('DELETE FROM core.worker_dispatch_pointer WHERE subject_id = ANY($1::uuid[])', [all]);
    const [{ n }] = await admin.query<[{ n: number }]>('SELECT count(*)::int AS n FROM core.worker_dispatch_pointer WHERE subject_id = ANY($1::uuid[])', [all]);
    expect(n).toBe(0);
  });

  afterAll(async () => {
    await provisioner?.end();
    await worker?.destroy();
    await app?.close();
    await admin?.destroy();
  });

  async function seedEmail(owner: TestIdentity): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO core.email_outbox (id, organisation_id, job_type, status, recipient_email, rendered_subject, rendered_html, rendered_text)
       VALUES ($1, $2, 'NOTIFICATION', 'PENDING', 'cutover@example.test', 'Subject', '<p>body</p>', 'body')`,
      [id, owner.organisationId],
    );
    orgOf.set(id, owner.organisationId);
    return id;
  }

  async function seedPush(owner: TestIdentity): Promise<string> {
    const notificationId = randomUUID();
    const deviceId = randomUUID();
    await admin.query(`INSERT INTO core.notification (id, organisation_id, user_id, type, title, message) VALUES ($1, $2, $3, 'TEST', 't', 'm')`, [
      notificationId,
      owner.organisationId,
      owner.userId,
    ]);
    const envelope = Buffer.concat([Buffer.from('RAB2'), Buffer.from([1]), Buffer.from('x'), Buffer.alloc(40, 7)]);
    await admin.query(
      `INSERT INTO core.push_device (id, organisation_id, user_id, device_id, platform, push_token_encrypted) VALUES ($1, $2, $3, $4, 'ios', $5)`,
      [deviceId, owner.organisationId, owner.userId, `cutover-${deviceId}`, envelope],
    );
    const id = randomUUID();
    await admin.query(`INSERT INTO core.push_delivery (id, organisation_id, notification_id, push_device_id, status) VALUES ($1, $2, $3, $4, 'PENDING')`, [
      id,
      owner.organisationId,
      notificationId,
      deviceId,
    ]);
    orgOf.set(id, owner.organisationId);
    return id;
  }

  async function seedRealtime(owner: TestIdentity): Promise<string> {
    const id = await tenantContext.runInTenantContext(
      { organisationId: owner.organisationId, workspaceId: owner.workspaceId, userId: owner.userId, role: '' },
      async (m) =>
        (
          await m.query<Array<{ id: string }>>(
            `INSERT INTO core.realtime_event (organisation_id, workspace_id, target_user_id, event_key, event_type, entity_type, entity_id, payload, max_attempts, schema_version)
             VALUES ($1, $2, $3, $4, 'offer.sent', 'offer', $5, '{}'::jsonb, 10, 1) RETURNING id`,
            [owner.organisationId, owner.workspaceId, owner.userId, `cutover:${randomUUID()}`, randomUUID()],
          )
        )[0]!.id,
    );
    orgOf.set(id, owner.organisationId);
    return id;
  }

  /** The approval flow of shift-statement.integration.spec.ts (approvedRecordFor), compacted: returns a PENDING record id. */
  async function approvedRecord(org: { id: string }, manager: TestIdentity): Promise<string> {
    const staff = await factory.createStaff(org, { owner: manager, label: 'cut-staff' });
    await admin.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = $1`, [staff.profileId]);
    const tokenM = await factory.login(manager);
    const tokenS = await factory.login(staff);
    const venueId = (await http().post('/rest/v1/venues').set(auth(tokenM)).send({ name: `Cutover Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' })).body.id as string;
    const jobRoleId = (await http().post('/rest/v1/job-roles').set(auth(tokenM)).send({ name: `Role-${randomUUID()}`, defaultRatePence: 1337 })).body.id as string;
    const shiftId = (
      await http().post('/rest/v1/shifts').set(auth(tokenM)).send({
        venueId, jobRoleId, startsAt: new Date(Date.now() - 5 * 60_000).toISOString(), endsAt: new Date(Date.now() + 8 * 3600_000).toISOString(), requiredCount: 1,
      })
    ).body.id as string;
    const signQr = async () =>
      tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' }, async (m) =>
        attendanceQr.sign(await m.findOneByOrFail(Shift, { id: shiftId })));
    expect((await http().post(`/rest/v1/shifts/${shiftId}/publish`).set(auth(tokenM))).status).toBe(201);
    const offer = await http().post(`/rest/v1/shifts/${shiftId}/offers`).set(auth(tokenM)).send({ staffProfileId: staff.profileId });
    expect((await http().post(`/rest/v1/offers/${offer.body.id}/accept`).set(auth(tokenS))).status).toBe(201);
    expect((await http().post(`/rest/v1/offers/${offer.body.id}/confirm`).set(auth(tokenM))).status).toBe(201);
    expect((await http().post('/rest/v1/attendance/check-in').set(auth(tokenS)).send({ shiftId })).status).toBe(200);
    expect((await http().post('/rest/v1/attendance/clock-in').set(auth(tokenS)).send({ shiftId, qrToken: await signQr() })).status).toBe(201);
    const out = await http().post('/rest/v1/attendance/clock-out').set(auth(tokenS)).send({ qrToken: await signQr() });
    const clockOutAt = new Date(out.body.clockOutAt).getTime();
    expect((await http().post(`/rest/v1/attendance/${out.body.id}/correct`).set(auth(tokenM))
      .send({ field: 'clockInAt', newValue: new Date(clockOutAt - 247 * 60_000).toISOString(), reason: 'Cutover test worked time' })).status).toBe(201);
    expect((await http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${staff.profileId}/attendance-review`).set(auth(tokenM))).status).toBe(200);
    expect((await http().patch(`/rest/v1/attendance/report/shift/${shiftId}/finalise`).set(auth(tokenM))).status).toBe(200);
    const [rec] = await admin.query<[{ id: string }]>(`SELECT id FROM core.payroll_record WHERE attendance_id = $1`, [out.body.id]);
    expect((await http().post(`/rest/v1/payroll/records/${rec.id}/approve`).set(auth(tokenM))).status).toBe(200);
    const [row] = await admin.query<[{ statement_status: string }]>(`SELECT statement_status FROM core.payroll_record WHERE id = $1`, [rec.id]);
    expect(row.statement_status).toBe('pending');
    orgOf.set(rec.id, org.id);
    return rec.id;
  }

  /** Every dispatch of OUR subjects: subject → organisation it was dispatched under (one entry per dispatch). */
  const dispatched: Array<{ queue: DispatchQueue; subjectId: string; organisationId: string; workspaceId?: string }> = [];
  const ours = (id: string) => orgOf.has(id);
  const record = (queue: DispatchQueue, subjectId: string, organisationId: string, workspaceId?: string) => {
    if (ours(subjectId)) dispatched.push({ queue, subjectId, organisationId, ...(workspaceId ? { workspaceId } : {}) });
  };
  /** Statement scopes of organisation B run under the HWS-on tenant context (its workspace is a physical schema). */
  const statementTenant = (organisationId: string) => (organisationId === orgB.organisationId ? hwsTenant : tenantContext);
  /** Globally-claimed scopes that contained our subjects (each must be the subject's own organisation). */
  const scopesSeen: DispatchScopeWork[] = [];

  function bindings(): DispatchQueueBinding[] {
    const emailPublish = async (id: string, orgId: string) => record('email', id, orgId);
    const pushPublish = async (id: string, orgId: string) => record('push', id, orgId);
    const realtimePublish = async (_channel: string, message: string) => {
      const envelope = JSON.parse(message) as { eventId: string; organisationId: string };
      record('realtime', envelope.eventId, envelope.organisationId);
      return 1;
    };
    const statementPublish = async (data: ShiftStatementJobData) => record('statement', data.payrollRecordId, data.organisationId, data.workspaceId);
    const noRepublish = async () => undefined;
    const seen = (scope: DispatchScopeWork) => {
      if (scope.subjectIds.some(ours)) scopesSeen.push(scope);
    };
    return [
      {
        queue: 'email',
        legacy: () => runEmailDispatchCycle(worker, tenantContext, emailPublish, noRepublish, true).then((r) => r.claimed > 0),
        processScope: async (scope) => (seen(scope), (await dispatchEmailScope(tenantContext, scope.organisationId, scope.subjectIds, emailPublish, noRepublish, true)).claimed),
      },
      {
        queue: 'push',
        legacy: () => runPushDispatchCycle(worker, tenantContext, pushPublish, noRepublish, true).then((r) => r.claimed > 0),
        processScope: async (scope) => (seen(scope), (await dispatchPushScope(tenantContext, scope.organisationId, scope.subjectIds, pushPublish, noRepublish, true)).claimed),
      },
      {
        queue: 'realtime',
        legacy: () => runRealtimeOutboxPublishCycle(worker, tenantContext, realtimePublish, TEST_ENV).then((r) => r.claimed > 0),
        processScope: async (scope) => (seen(scope), (await publishRealtimeScope(tenantContext, realtimePublish, TEST_ENV, scope, { ids: scope.subjectIds })).claimed),
      },
      {
        queue: 'statement',
        // The production sweep (all organisations; HWS off in this test app → core) plus the same sweep for organisation B
        // under HWS on (its workspace schema): together what production's single HWS-on Worker walks.
        legacy: async () => {
          const core = await runShiftStatementDispatchCycle(worker, tenantContext, statementPublish);
          const physical = await runShiftStatementDispatchCycle(worker, hwsTenant, statementPublish, { organisationId: orgB.organisationId });
          return core.claimed + physical.claimed > 0;
        },
        processScope: async (scope) =>
          (seen(scope),
          (await dispatchStatementScope(statementTenant(scope.organisationId), scope.organisationId, scope.workspaceId!, scope.subjectIds, statementPublish)).claimed),
      },
    ];
  }

  it('the global claim alone (a wake-up: no sweep) never reaches pointer-less pre-cutover work', async () => {
    const logger = { log: () => undefined, warn: () => undefined };
    for (const binding of bindings()) {
      await runGlobalDispatch({ claimer: worker, queue: binding.queue, batch: 200, maxBatches: 10, logger, processScope: binding.processScope });
    }
    expect(dispatched).toEqual([]);
  });

  it('ONE tick per queue on a fresh global-mode coordinator (the first tick after start) dispatches all of it exactly once, each under its own organisation', async () => {
    const logger = { log: () => undefined, warn: () => undefined };
    const coordinator = new DispatchCoordinator(bindings(), { claimer: worker, batch: 200, reconcileMs: 900_000, logger });
    for (const queue of ['email', 'push', 'realtime', 'statement'] as const) await coordinator.tick(queue);

    for (const queue of ['email', 'push', 'realtime', 'statement'] as const) {
      for (const id of ids[queue]) {
        const hits = dispatched.filter((d) => d.queue === queue && d.subjectId === id);
        if (queue === 'push') {
          // A PENDING push row stays PENDING after its first publish (queued_at stamped, B-report d1 §5.2); a re-visit in the
          // same tick re-publishes the SAME deduplicated BullMQ jobId (`<id>.attempt.0` — `publish`, never `republish`), so
          // it is still exactly one job. Republishes would be a second job: none are expected (noRepublish records nothing).
          expect(hits.length).toBeGreaterThanOrEqual(1);
        } else {
          expect({ queue, id, count: hits.length }).toEqual({ queue, id, count: 1 }); // exactly once
        }
        for (const hit of hits) expect(hit.organisationId).toBe(orgOf.get(id)); // under its own organisation
      }
    }
    // Wave 3 (b): the workspace-schema statement row was found by the sweep and dispatched for ITS workspace; the row in the
    // physical schema is now queued, and the non-due core template was never dispatched.
    expect(dispatched.find((d) => d.subjectId === wsStatementId)).toMatchObject({ organisationId: orgB.organisationId, workspaceId: orgB.workspaceId });
    const [wsAfter] = await admin.query<[{ statement_status: string }]>(`SELECT statement_status FROM "${wsSchema}".payroll_record WHERE id = $1`, [wsStatementId]);
    expect(wsAfter.statement_status).toBe('queued');
    const [coreAfter] = await admin.query<[{ statement_status: string }]>(`SELECT statement_status FROM core.payroll_record WHERE id = $1`, [coreSourceOfWsStatement]);
    expect(coreAfter.statement_status).toBe('failed');
    // Both organisations really were processed (the per-scope sweep walked each scope separately).
    expect(new Set(dispatched.map((d) => d.organisationId))).toEqual(new Set([orgA.organisationId, orgB.organisationId]));
    // Any of our subjects that ALSO came through the global claim in this tick (its state change re-created a pointer)
    // was in a scope of its own organisation only.
    for (const scope of scopesSeen) {
      for (const id of scope.subjectIds.filter(ours)) expect(orgOf.get(id)).toBe(scope.organisationId);
    }
  });
});
