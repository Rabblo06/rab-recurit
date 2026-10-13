/**
 * REAL-TIME END-TO-END LATENCY BENCHMARK (opt-in — excluded from the default suite; run with
 * `RAB_LOAD_TEST=1 npx jest --config jest.config.ts --testPathIgnorePatterns=/node_modules/
 * --testPathPattern=realtime-e2e-latency.load`).
 *
 * Measures the REAL, independently-verifiable legs of the Stage 4 exit gate's path: offer-accept
 * transaction commits -> Redis publish -> SSE delivery -> (simulated) React receives event -> query
 * refetch. `rab-server`'s `AppModule` runs in-process on a genuinely bound TCP port (same convention
 * as `realtime-gateway.integration.spec.ts`) against the real local PostgreSQL (forced RLS) and real
 * local Redis — the offer accept, the SSE stream and the refetch are all the actual production code
 * path, zero mocks.
 *
 * The Redis-publish leg below publishes a REAL envelope directly to Redis (the exact mechanism
 * `realtime-gateway.integration.spec.ts`'s own `publishRaw` helper already uses, test 13) rather
 * than going through `rab-worker`'s outbox-claim cycle — deliberately, not as a shortcut: this
 * benchmark was built to also run `rab-worker`'s own `runRealtimeOutboxPublishCycle` for real, either
 * as a separately spawned `dist/main.js` OS process or as a direct in-process call. Both were
 * abandoned, for different, both-correct reasons, and are reported here rather than worked around:
 *   1. The spawned-process form failed its own `assertRuntimeDbRole()` boot guard — this local dev
 *      environment's `crewflow_app` credential no longer authenticates, and a SEPARATE attempt using
 *      the unmodified `.env` `DATABASE_URL` (which does specify `crewflow_app` correctly) failed with
 *      "permission denied for table user_session" — a missing grant for that role, independent of
 *      Stage 4, pre-existing in this local database. Neither is something this benchmark should fix
 *      unsupervised (a password rotation or a grant restoration).
 *   2. The in-process direct-call form would have run genuinely tenant-scoped outbox work under the
 *      `crewflow` OWNER role (this test's own in-process app connection) specifically to route around
 *      guard #1 — i.e. doing, deliberately, the exact thing `assertRuntimeDbRole` exists to prevent.
 *      Correctly refused; not attempted a second way.
 * The real, documented production schedule for that leg (`REALTIME_OUTBOX_PUBLISH_INTERVAL_MS` =
 * 2000ms, read from `rab-worker/src/main.ts`) is reported below as a DOCUMENTED fact, not claimed as
 * measured in this run.
 *
 * What is NOT measured, and why: there is no browser automation tool in this repository (no
 * Playwright/Puppeteer/Cypress dependency exists anywhere in the monorepo, confirmed before writing
 * this file) — so actual React re-render/paint time after a query refetch resolves is NOT included.
 * The "query refetch" segment below measures the real `GET /offers` HTTP round trip
 * `RealtimeProvider`'s `invalidateQueries` would trigger — the dominant, measurable cost of that
 * step — but the final DOM paint is a sub-frame React commit this harness cannot observe without a
 * real browser, and is not claimed as measured.
 *
 * Limits of this rig: the load generator, PostgreSQL, Redis and the in-process API all share one
 * developer machine, so absolute latencies are a same-machine baseline, not a production SLO.
 * Concurrency is modelled as multiple INDEPENDENT organisations (multiple manager workspaces), each
 * with its own manager (SSE-connected) and staff member — proving cross-tenant isolation under load
 * is unaffected, not just raw throughput.
 */
process.env.REALTIME_ENABLED = 'true';

import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthCacheRedisClientProvider } from '@rab/server/engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { realtimeUserChannel, REALTIME_ENVELOPE_SCHEMA_VERSION } from '@rab/server/engine/core-modules/realtime/realtime-envelope';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { createAdminDataSource } from '../integration/helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentity, TestIdentityFactory } from '../integration/helpers/test-identities';

const RUN = process.env.RAB_LOAD_TEST === '1';
const describeIf = RUN ? describe : describe.skip;
jest.setTimeout(5 * 60_000);

const OUT_DIR = 'C:/Rab-recruit/.audit/prod-readiness';
const OUT = `${OUT_DIR}/realtime-e2e-latency-results.json`;

// The real production schedule (`rab-worker/src/main.ts`'s own `REALTIME_OUTBOX_PUBLISH_INTERVAL_MS`)
// — reported, never measured in this run; see the header comment for why.
const REAL_WORKER_POLL_INTERVAL_MS = 2_000;

interface SseEvent { event?: string; id?: string; data: string }
interface SseConnection {
  waitForEvent: (timeoutMs?: number) => Promise<SseEvent>;
  close: () => void;
}

function connectSse(baseUrl: string, headers: Record<string, string>): SseConnection {
  let pendingResolve: ((e: SseEvent) => void) | null = null;
  let buffer = '';
  const url = new URL('/rest/v1/realtime/stream', baseUrl);
  const req = http.request(url, { method: 'GET', headers }, (res) => {
    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      // eslint-disable-next-line no-cond-assign
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evt: SseEvent = { data: '' };
        for (const line of raw.split('\n')) {
          if (line.startsWith('data:')) evt.data += line.slice(5).trim();
          else if (line.startsWith('event:')) evt.event = line.slice(6).trim();
          else if (line.startsWith('id:')) evt.id = line.slice(3).trim();
        }
        if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(evt); }
      }
    });
  });
  req.on('error', () => undefined);
  req.end();
  return {
    waitForEvent: (timeoutMs = 5_000) =>
      new Promise((resolve, reject) => {
        pendingResolve = resolve;
        setTimeout(() => { if (pendingResolve) { pendingResolve = null; reject(new Error('timed out waiting for an SSE event')); } }, timeoutMs);
      }),
    close: () => req.destroy(),
  };
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function summarize(samples: number[]): { p50: number; p95: number; p99: number; max: number; min: number; mean: number; n: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = n ? sorted.reduce((a, b) => a + b, 0) / n : 0;
  return { p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted[n - 1] ?? 0, min: sorted[0] ?? 0, mean: Math.round(mean * 100) / 100, n };
}

describeIf('real-time end-to-end latency (offer accept HTTP, redis publish -> sse delivery, query refetch HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let redisProvider: AuthCacheRedisClientProvider;
  let nodeEnv: string;
  const openConnections: SseConnection[] = [];

  const http_ = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0); // a real bound port — required for the SSE client to read a streaming response
    baseUrl = await app.getUrl();

    tenantContext = moduleRef.get(TenantContextService);
    redisProvider = moduleRef.get(AuthCacheRedisClientProvider);
    nodeEnv = moduleRef.get(EnvironmentService).get('NODE_ENV');
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = createTestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  }, 120_000);

  afterAll(async () => {
    for (const c of openConnections) c.close();
    if (app) await app.close();
    if (adminDataSource?.isInitialized) await adminDataSource.destroy();
  });

  /** One independent manager workspace: its own organisation, venue, job role and manager — mirrors "multiple independent manager workspaces" under concurrent load, not one shared tenant. */
  async function seedWorkspace(label: string): Promise<{ manager: TestIdentity; managerToken: string; staff: TestIdentity; staffToken: string; venueId: string; jobRoleId: string }> {
    const org = await factory.createOrganisation(label);
    const manager = await factory.createInternalManager(org, { label });
    const staff = await factory.createStaff(org, { owner: manager, label: `${label}-staff` });
    const managerToken = await factory.login(manager);
    const staffToken = await factory.login(staff);

    const venueRes = await http_().post('/rest/v1/venues').set(auth(managerToken)).send({ name: `${label} Venue`, type: 'hotel', lat: 51.5, lng: -0.12, geofenceRadiusM: 100, enforceGeofence: false });
    const jobRoleRes = await http_().post('/rest/v1/job-roles').set(auth(managerToken)).send({ name: `${label}-role-${randomUUID()}`, defaultRatePence: 1200 });
    if (venueRes.status !== 201 || jobRoleRes.status !== 201) {
      throw new Error(`workspace seed failed for ${label}: venue=${venueRes.status} ${JSON.stringify(venueRes.body)} jobRole=${jobRoleRes.status} ${JSON.stringify(jobRoleRes.body)}`);
    }
    return { manager, managerToken, staff, staffToken, venueId: venueRes.body.id, jobRoleId: jobRoleRes.body.id };
  }

  /** One fresh shift + sent offer, ready to be accepted — isolated per sample so no two samples contend on the same row. */
  async function seedOffer(ws: Awaited<ReturnType<typeof seedWorkspace>>): Promise<{ offerId: string }> {
    const startsAt = new Date(Date.now() + 48 * 3600 * 1000 + Math.random() * 1000);
    const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
    const shiftRes = await http_().post('/rest/v1/shifts').set(auth(ws.managerToken)).send({
      venueId: ws.venueId, jobRoleId: ws.jobRoleId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), requiredCount: 1,
    });
    if (shiftRes.status !== 201) throw new Error(`shift create failed: ${shiftRes.status} ${JSON.stringify(shiftRes.body)}`);
    const publishRes = await http_().post(`/rest/v1/shifts/${shiftRes.body.id}/publish`).set(auth(ws.managerToken));
    if (publishRes.status !== 201) throw new Error(`publish failed: ${publishRes.status} ${JSON.stringify(publishRes.body)}`);
    const offerRes = await http_().post(`/rest/v1/shifts/${shiftRes.body.id}/offers`).set(auth(ws.managerToken)).send({ staffProfileId: ws.staff.profileId });
    if (offerRes.status !== 201) throw new Error(`offer send failed: ${offerRes.status} ${JSON.stringify(offerRes.body)}`);
    return { offerId: offerRes.body.id };
  }

  interface Sample {
    acceptMs: number; // offer-accept HTTP round trip itself (the "transaction commits" call) — real
    publishToSseMs: number; // Redis PUBLISH -> this connection's SSE delivery — real, direct publish (see header comment on why this bypasses the outbox/worker claim leg)
    refetchMs: number; // the authoritative GET /offers refetch a real RealtimeProvider would trigger on receiving the event — real
    totalMs: number; // accept call start -> refetch complete (excludes the undocumented-this-run outbox/worker leg)
  }

  /** One full measured cycle for one manager workspace: open SSE, accept an offer as staff (real transaction), publish a real envelope directly to Redis for that exact accept, wait for delivery, then refetch. */
  async function runOneSample(ws: Awaited<ReturnType<typeof seedWorkspace>>): Promise<Sample> {
    const conn = connectSse(baseUrl, auth(ws.managerToken));
    openConnections.push(conn);
    await new Promise((r) => setTimeout(r, 200)); // let the SSE handshake + Redis subscribe complete before anything is published

    const { offerId } = await seedOffer(ws);

    const acceptStart = Date.now();
    const acceptRes = await fetch(`${baseUrl}/rest/v1/offers/${offerId}/accept`, { method: 'POST', headers: { ...auth(ws.staffToken), 'content-type': 'application/json' } });
    const acceptDone = Date.now();
    if (acceptRes.status !== 201) throw new Error(`accept failed: ${acceptRes.status} ${await acceptRes.text()}`);

    // Real Redis PUBLISH, real envelope shape, addressed to this exact accept's own manager — the
    // same mechanism `offer.accepted` really uses once the outbox/worker leg has handed it off (see
    // header comment: that leg itself is not exercised in this run).
    const envelope = {
      version: REALTIME_ENVELOPE_SCHEMA_VERSION,
      eventId: randomUUID(),
      type: 'offer.accepted',
      organisationId: ws.manager.organisationId,
      workspaceId: ws.manager.workspaceId,
      targetUserId: ws.manager.userId,
      entityId: offerId,
      occurredAt: new Date().toISOString(),
    };
    const publishStart = Date.now();
    await redisProvider.client.publish(realtimeUserChannel(nodeEnv, ws.manager.userId), JSON.stringify(envelope));

    const evt = await conn.waitForEvent(5_000);
    const sseReceived = Date.now();
    const received = JSON.parse(evt.data) as { type: string; targetUserId: string; eventId: string };
    if (received.eventId !== envelope.eventId) throw new Error('received a different event than the one just published — dedup window contamination from a prior sample');
    if (received.targetUserId !== ws.manager.userId) throw new Error('event delivered to the wrong identity — isolation violated under load');

    const refetchStart = Date.now();
    const refetchRes = await fetch(`${baseUrl}/rest/v1/offers`, { headers: auth(ws.managerToken) });
    const refetchDone = Date.now();
    if (refetchRes.status !== 200) throw new Error(`refetch failed: ${refetchRes.status}`);

    conn.close();
    return {
      acceptMs: acceptDone - acceptStart,
      publishToSseMs: sseReceived - publishStart,
      refetchMs: refetchDone - refetchStart,
      totalMs: refetchDone - acceptStart,
    };
  }

  it('measures offer-accept HTTP, redis-publish -> sse delivery, and query-refetch HTTP under concurrent, multi-workspace load', async () => {
    const WORKSPACES = 5;
    const SAMPLES_PER_WORKSPACE = 4;
    const workspaces = await Promise.all(Array.from({ length: WORKSPACES }, (_, i) => seedWorkspace(`rtlat${i}-${randomUUID().slice(0, 6)}`)));

    const samples: Sample[] = [];
    const errors: string[] = [];
    const runStart = Date.now();

    for (let round = 0; round < SAMPLES_PER_WORKSPACE; round++) {
      // All workspaces fire their round concurrently — genuine cross-tenant concurrency, not a serial loop.
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled(workspaces.map((ws) => runOneSample(ws)));
      for (const r of results) {
        if (r.status === 'fulfilled') samples.push(r.value);
        else errors.push(String(r.reason));
      }
    }
    const runEnd = Date.now();

    const total = WORKSPACES * SAMPLES_PER_WORKSPACE;
    const report = {
      meta: {
        workspaces: WORKSPACES,
        samplesPerWorkspace: SAMPLES_PER_WORKSPACE,
        totalAttempted: total,
        succeeded: samples.length,
        failed: errors.length,
        errorRatePct: Math.round((errors.length / total) * 10000) / 100,
        wallClockMs: runEnd - runStart,
        throughputPerSec: Math.round((samples.length / ((runEnd - runStart) / 1000)) * 100) / 100,
        documentedNotMeasured_outboxPollIntervalMs: REAL_WORKER_POLL_INTERVAL_MS,
        note:
          'Same-machine dev benchmark (in-process API, real local Postgres+Redis). Not a production SLO. ' +
          'The outbox-insert -> worker-claim leg is NOT measured in this run (real rab-worker process ' +
          'refused to boot under this local environment\'s current restricted-role credential; an ' +
          'in-process bypass of that same boot guard was deliberately not attempted — see file header). ' +
          'publishToSseMs below is a direct Redis PUBLISH, not routed through the outbox/worker claim. ' +
          'React render/paint time after refetch is not measured — no browser automation tool exists in this repo.',
      },
      acceptHttpMs: summarize(samples.map((s) => s.acceptMs)),
      publishToSseMs: summarize(samples.map((s) => s.publishToSseMs)),
      refetchMs: summarize(samples.map((s) => s.refetchMs)),
      measuredPathTotalMs: summarize(samples.map((s) => s.totalMs)),
      errors: errors.slice(0, 20),
    };

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));

    expect(errors).toHaveLength(0);
    expect(samples.length).toBe(total);
  });
});
