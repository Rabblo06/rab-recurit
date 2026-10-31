/**
 * Phase C1b — MEASUREMENT ONLY (opt-in: `RAB_REALTIME_MEASURE=1`; skipped otherwise, never part of CI).
 *
 * One disposable process: the real API (`AppModule`, real HTTP listener, real SSE gateway, real Redis) plus the
 * Worker's real publisher (`runRealtimeOutboxPublishCycle`, the production function) ticking every 2 s exactly like
 * `WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS=2`. REALTIME_ENABLED=true only inside this process.
 *
 * Prints, labelled MEASURED:
 *  - event-to-client latency (business commit → event frame on the recipient's SSE socket), p50/p95;
 *  - connect latency (request → `: connected` comment), p50/p95 — the server half of reconnect recovery;
 *  - publisher database load: statements per cycle (and per minute at 2 s) idle and with one event per cycle, over
 *    the FULL production scope walk (every organisation + workspace in this database).
 */
// Only when opted in: a skipped run never turns the flag on, not even in its own module scope.
if (process.env.RAB_REALTIME_MEASURE === '1') {
  process.env.REALTIME_ENABLED = 'true';
  process.env.REALTIME_HEARTBEAT_INTERVAL_MS = '30000';
}

import 'reflect-metadata';
import { EmploymentStatus } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import { DataSource } from 'typeorm';
import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthCacheRedisClientProvider } from '@rab/server/engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { storageScopes, MaintenanceScope } from '@rab/server/engine/worker-shared/maintenance-catalogue';
import { OfferService } from '@rab/server/modules/offer/services/offer.service';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { StaffProfile } from '@rab/server/modules/staff/entities/staff-profile.entity';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { runRealtimeOutboxPublishCycle } from './publish-outbox.job';
import { createAdminDataSource } from '../../__tests__/integration/helpers/admin-datasource';
import { createTestIdentityFactory } from '../../__tests__/integration/helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL) && process.env.RAB_REALTIME_MEASURE === '1';
const describeIfMeasure = RUN ? describe : describe.skip;
jest.setTimeout(15 * 60_000);

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

interface Stream {
  frames: Array<{ at: number; comment?: string; data?: string }>;
  opened: Promise<number>;
  close: () => void;
}

function openStream(baseUrl: string, token: string): Stream {
  const frames: Stream['frames'] = [];
  let resolveOpened!: (t: number) => void;
  const opened = new Promise<number>((r) => (resolveOpened = r));
  let buffer = '';
  const req = http.request(new URL('/rest/v1/realtime/stream', baseUrl), { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'X-Crewflow-Background': '1' } }, (res) => {
    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const at = performance.now();
        const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
        const commentLine = raw.split('\n').find((l) => l.startsWith(':'));
        if (dataLine) frames.push({ at, data: dataLine.slice(5).trim() });
        else if (commentLine) {
          frames.push({ at, comment: commentLine.slice(1).trim() });
          if (commentLine.includes('connected')) resolveOpened(at);
        }
      }
    });
  });
  req.on('error', () => undefined);
  req.end();
  return { frames, opened, close: () => req.destroy() };
}

describeIfMeasure('C1b realtime — MEASURED latency, reconnect, publisher load', () => {
  let app: INestApplication;
  let baseUrl: string;

  afterAll(async () => {
    await app?.close();
  });

  it('measures', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();
    const dataSource = app.get(DataSource);
    const tenantContext = app.get(TenantContextService);
    const redis = app.get(AuthCacheRedisClientProvider).client;
    const nodeEnv = app.get(EnvironmentService).get('NODE_ENV');
    const admin = createAdminDataSource();
    await admin.initialize();
    const factory = createTestIdentityFactory({ app, dataSource, adminDataSource: admin, tenantContext, passwordHashing: app.get(PasswordHashingService) });

    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'c1e-measure' });
    const owner = seeded.managers[0]!;
    const staff = await factory.createStaff(seeded.organisation, { owner, label: 'c1e-measure-staff' });
    const ownerCtx = { organisationId: owner.organisationId, workspaceId: owner.workspaceId, userId: owner.userId, role: '' };
    const N = 30;
    const shiftIds = await tenantContext.runInTenantContext(ownerCtx, async (m) => {
      await m.update(StaffProfile, { id: staff.profileId! }, { employmentStatus: EmploymentStatus.ACTIVE });
      const venue = await m.save(Venue, { organisationId: owner.organisationId, name: `Measure ${randomUUID().slice(0, 6)}`, createdBy: owner.userId, workspaceId: owner.workspaceId! });
      const role = await m.save(JobRole, { organisationId: owner.organisationId, name: `Measure ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: owner.userId, workspaceId: owner.workspaceId! });
      const out: string[] = [];
      for (let i = 0; i < N + 12; i++) {
        const startsAt = new Date(Date.now() + (3 + i) * 24 * 3600 * 1000);
        const endsAt = new Date(startsAt.getTime() + 4 * 3600 * 1000);
        const s = await m.save(Shift, { organisationId: owner.organisationId, venueId: venue.id, jobRoleId: role.id, startsAt, endsAt, defaultStartsAt: startsAt, defaultEndsAt: endsAt, breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: 'open', createdBy: owner.userId, workspaceId: owner.workspaceId! } as Partial<Shift>);
        out.push(s.id);
      }
      return out;
    });
    const offers = app.get(OfferService);
    const publish = (channel: string, message: string) => redis.publish(channel, message);

    // Count every statement the publisher issues (it shares the process with the API, so only cycles are counted).
    let counting = false;
    let statements = 0;
    const originalQuery = PostgresQueryRunner.prototype.query;
    PostgresQueryRunner.prototype.query = function (this: PostgresQueryRunner, ...args: Parameters<typeof originalQuery>) {
      if (counting) statements++;
      return originalQuery.apply(this, args);
    } as typeof originalQuery;

    const allScopes: MaintenanceScope[] = [];
    for await (const scope of storageScopes(dataSource)) allScopes.push(scope);
    const ownScopes: MaintenanceScope[] = [{ organisationId: owner.organisationId, workspaceId: null }, { organisationId: owner.organisationId, workspaceId: owner.workspaceId }];

    async function measuredCycle(scopes?: MaintenanceScope[]): Promise<{ statements: number; ms: number }> {
      statements = 0;
      counting = true;
      const t0 = performance.now();
      await runRealtimeOutboxPublishCycle(dataSource, tenantContext, publish, nodeEnv, scopes ? { scopes } : {});
      const ms = performance.now() - t0;
      counting = false;
      return { statements, ms };
    }

    // ---- publisher load: idle, full production scope walk
    const idle: Array<{ statements: number; ms: number }> = [];
    for (let i = 0; i < 5; i++) idle.push(await measuredCycle());

    // ---- latency: publisher loop on this tenant's scopes every 2 s (the production interval), staff stream open
    const staffToken = await factory.login(staff);
    const stream = openStream(baseUrl, staffToken);
    await stream.opened;
    let looping = true;
    const loop = (async () => {
      while (looping) {
        await runRealtimeOutboxPublishCycle(dataSource, tenantContext, publish, nodeEnv, { scopes: ownScopes });
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    const latencies: number[] = [];
    for (let i = 0; i < N; i++) {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 1700)); // de-phase from the publisher tick
      const t0 = performance.now();
      const offer = await offers.send(ownerCtx, shiftIds[i]!, { staffProfileId: staff.profileId! });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const hit = stream.frames.find((f) => f.data && JSON.parse(f.data).entityId === offer.id);
        if (hit) {
          latencies.push(hit.at - t0);
          break;
        }
        if (Date.now() > deadline) throw new Error('event not delivered within 10 s');
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    looping = false;
    await loop;
    stream.close();

    // ---- publisher load with one event per cycle (full scope walk)
    const busy: Array<{ statements: number; ms: number }> = [];
    for (let i = 0; i < 5; i++) {
      await offers.send(ownerCtx, shiftIds[N + i]!, { staffProfileId: staff.profileId! });
      busy.push(await measuredCycle());
    }

    // ---- connect latency (server half of reconnect recovery)
    const connects: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const s = openStream(baseUrl, staffToken);
      connects.push((await s.opened) - t0);
      s.close();
      await new Promise((r) => setTimeout(r, 100));
    }
    PostgresQueryRunner.prototype.query = originalQuery;

    const avg = (xs: Array<{ statements: number; ms: number }>, k: 'statements' | 'ms') => xs.reduce((a, x) => a + x[k], 0) / xs.length;
    const report = {
      label: 'MEASURED',
      scopesInDatabase: allScopes.length,
      eventToClientMs: { n: latencies.length, p50: Math.round(pct(latencies, 50)), p95: Math.round(pct(latencies, 95)), max: Math.round(Math.max(...latencies)) },
      connectToFirstByteMs: { n: connects.length, p50: Math.round(pct(connects, 50)), p95: Math.round(pct(connects, 95)) },
      publisherIdle: { statementsPerCycle: Math.round(avg(idle, 'statements')), statementsPerMinuteAt2s: Math.round(avg(idle, 'statements') * 30), cycleMs: Math.round(avg(idle, 'ms')) },
      publisherOneEventPerCycle: { statementsPerCycle: Math.round(avg(busy, 'statements')), statementsPerMinuteAt2s: Math.round(avg(busy, 'statements') * 30), cycleMs: Math.round(avg(busy, 'ms')) },
    };
    // eslint-disable-next-line no-console
    console.log(`C1B_MEASURE ${JSON.stringify(report)}`);
    expect(latencies.length).toBe(N);
    await admin.destroy();
  });
});
