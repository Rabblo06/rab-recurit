/**
 * Stage 3 — the authenticated real-time gateway (`GET /rest/v1/realtime/stream`, SSE). Real
 * Postgres, real Redis, RLS on, no mocks — a real booted app listening on a real ephemeral port,
 * because an SSE stream cannot be exercised through supertest's normal buffered-response assertions.
 *
 * `REALTIME_ENABLED` is set to `'true'` BEFORE ANY import — same convention as `core-entity-cache.
 * integration.spec.ts`/`user-session-redis-cache.integration.spec.ts`/etc. for their own feature
 * flags. This is load-bearing, not stylistic: `EnvironmentModule`'s `ConfigModule.forRoot()` reads
 * `process.env` at the point `@nestjs/config` is first required, which happens as a side effect of
 * this file's OWN `import { AppModule }` line — confirmed live, the hard way (an assignment placed
 * AFTER the imports was silently ignored; `EnvironmentService.get('REALTIME_ENABLED')` kept
 * resolving the class default `false` even though `process.env.REALTIME_ENABLED` was genuinely
 * `'true'` by the time `compile()` ran — because the config snapshot had already been taken
 * earlier, during the import phase, when the env var did not yet exist). Every import in this file
 * MUST stay below this block.
 */
process.env.REALTIME_ENABLED = 'true';
process.env.REALTIME_HEARTBEAT_INTERVAL_MS = '5000'; // the class's own @Min(5_000) floor — a real production safeguard, not loosened for test convenience
process.env.REALTIME_MAX_CONNECTIONS_PER_USER = '2';

import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { RefreshTokenService } from '../../engine/core-modules/auth/token/services/refresh-token.service';
import { AccessTokenService } from '../../engine/core-modules/auth/token/services/access-token.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { RealtimeConnectionRegistryService } from '../../engine/core-modules/realtime/realtime-connection-registry.service';
import { RealtimeSubscriber } from '../../engine/core-modules/realtime/realtime-subscriber';
import { realtimeUserChannel, REALTIME_ENVELOPE_SCHEMA_VERSION } from '../../engine/core-modules/realtime/realtime-envelope';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';
import { generateFixturePassword } from './helpers/fixture-password';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(30_000);

interface SseEvent {
  event?: string;
  id?: string;
  data: string;
}

interface SseConnection {
  events: SseEvent[];
  statusCode: () => number | undefined;
  isClosed: () => boolean;
  waitForEvent: (timeoutMs?: number) => Promise<SseEvent>;
  waitForClose: (timeoutMs?: number) => Promise<void>;
  close: () => void;
}

function connectSse(baseUrl: string, headers: Record<string, string>): SseConnection {
  const events: SseEvent[] = [];
  let statusCode: number | undefined;
  let closed = false;
  let pendingResolve: ((e: SseEvent) => void) | null = null;
  let pendingCloseResolve: (() => void) | null = null;
  let buffer = '';

  const url = new URL('/rest/v1/realtime/stream', baseUrl);
  const req = http.request(url, { method: 'GET', headers }, (res) => {
    statusCode = res.statusCode;
    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evt: SseEvent = { data: '' };
        for (const line of raw.split('\n')) {
          if (line.startsWith('data:')) evt.data += line.slice(5).trim();
          else if (line.startsWith('event:')) evt.event = line.slice(6).trim();
          else if (line.startsWith('id:')) evt.id = line.slice(3).trim();
        }
        events.push(evt);
        if (pendingResolve) {
          const r = pendingResolve;
          pendingResolve = null;
          r(evt);
        }
      }
    });
    res.on('end', () => {
      closed = true;
      if (pendingCloseResolve) {
        const r = pendingCloseResolve;
        pendingCloseResolve = null;
        r();
      }
    });
  });
  req.on('error', () => {
    closed = true;
  });
  req.end();

  return {
    events,
    statusCode: () => statusCode,
    isClosed: () => closed,
    waitForEvent: (timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        pendingResolve = resolve;
        setTimeout(() => {
          if (pendingResolve) {
            pendingResolve = null;
            reject(new Error('timed out waiting for an SSE event'));
          }
        }, timeoutMs);
      }),
    waitForClose: (timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        if (closed) return resolve();
        pendingCloseResolve = resolve;
        setTimeout(() => {
          if (pendingCloseResolve) {
            pendingCloseResolve = null;
            reject(new Error('timed out waiting for the connection to close'));
          }
        }, timeoutMs);
      }),
    close: () => {
      req.destroy();
      closed = true;
    },
  };
}

function extractCookie(setCookieHeaders: string | string[] | undefined, name: string): string {
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : setCookieHeaders ? [setCookieHeaders] : [];
  const header = list.find((h) => h.startsWith(`${name}=`));
  if (!header) throw new Error(`${name} cookie not found in Set-Cookie headers`);
  return header.split(';')[0]!;
}

describeIfDb('realtime gateway — authenticated SSE stream (integration)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let redisProvider: AuthCacheRedisClientProvider;
  let refreshTokenService: RefreshTokenService;
  let accessTokenService: AccessTokenService;
  let registry: RealtimeConnectionRegistryService;
  let factory: TestIdentityFactory;
  let nodeEnv: string;
  const password = generateFixturePassword();
  const openConnections: SseConnection[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0); // a real bound port — required for a raw http client to read a streaming response
    baseUrl = await app.getUrl();

    dataSource = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    redisProvider = app.get(AuthCacheRedisClientProvider);
    refreshTokenService = app.get(RefreshTokenService);
    accessTokenService = app.get(AccessTokenService);
    registry = app.get(RealtimeConnectionRegistryService);
    nodeEnv = app.get(EnvironmentService).get('NODE_ENV');
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
  });

  afterAll(async () => {
    for (const conn of openConnections) conn.close();
    if (app) await app.close();
    if (adminDataSource?.isInitialized) await adminDataSource.destroy();
  });

  afterEach(() => {
    while (openConnections.length) openConnections.pop()!.close();
  });

  async function publishRaw(channel: string, message: string): Promise<void> {
    await redisProvider.client.publish(channel, message);
  }

  function validEnvelope(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      version: REALTIME_ENVELOPE_SCHEMA_VERSION,
      eventId: randomUUID(),
      type: 'offer.sent',
      organisationId: randomUUID(),
      workspaceId: randomUUID(),
      targetUserId: randomUUID(),
      entityId: randomUUID(),
      occurredAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('1. a valid cookie connection receives an event addressed to that exact user', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'rtg1' });
    const loginRes = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
    const cookie = extractCookie(loginRes.headers['set-cookie'], 'crewflow_session');

    const conn = connectSse(baseUrl, { Cookie: cookie });
    openConnections.push(conn);
    await new Promise((r) => setTimeout(r, 150)); // let the async connect/subscribe setup land

    const envelope = validEnvelope({ organisationId: manager.organisationId, workspaceId: manager.workspaceId, targetUserId: manager.userId });
    await publishRaw(realtimeUserChannel(nodeEnv, manager.userId), JSON.stringify(envelope));

    const received = await conn.waitForEvent();
    expect(JSON.parse(received.data).eventId).toBe(envelope.eventId);
    expect(received.event).toBe('offer.sent');
  });

  it('2. a valid mobile Bearer (JWT) connection receives its own event', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'rtg2' });
    const staff = await factory.createStaff(org, { owner: manager, label: 'rtg2-staff' });
    const token = await factory.login(staff);

    const conn = connectSse(baseUrl, { Authorization: `Bearer ${token}` });
    openConnections.push(conn);
    await new Promise((r) => setTimeout(r, 150));

    const envelope = validEnvelope({ organisationId: staff.organisationId, workspaceId: staff.workspaceId, targetUserId: staff.userId });
    await publishRaw(realtimeUserChannel(nodeEnv, staff.userId), JSON.stringify(envelope));

    const received = await conn.waitForEvent();
    expect(JSON.parse(received.data).eventId).toBe(envelope.eventId);
  });

  it('3. no credential at all is rejected — the stream never opens', async () => {
    const conn = connectSse(baseUrl, {});
    openConnections.push(conn);
    await conn.waitForClose();
    expect(conn.statusCode()).toBe(401);
  });

  it('4. an invalid/garbage Bearer token is rejected', async () => {
    const conn = connectSse(baseUrl, { Authorization: 'Bearer not-a-real-token' });
    openConnections.push(conn);
    await conn.waitForClose();
    expect(conn.statusCode()).toBe(401);
  });

  it('5. user B never receives an event addressed to user A, even on their own live connection', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'rtg5' });
    const staffA = await factory.createStaff(org, { owner: manager, label: 'rtg5-a' });
    const staffB = await factory.createStaff(org, { owner: manager, label: 'rtg5-b' });
    const tokenB = await factory.login(staffB);

    const connB = connectSse(baseUrl, { Authorization: `Bearer ${tokenB}` });
    openConnections.push(connB);
    await new Promise((r) => setTimeout(r, 150));

    const envelopeForA = validEnvelope({ organisationId: manager.organisationId, workspaceId: manager.workspaceId, targetUserId: staffA.userId });
    await publishRaw(realtimeUserChannel(nodeEnv, staffA.userId), JSON.stringify(envelopeForA));
    await new Promise((r) => setTimeout(r, 200));

    expect(connB.events).toHaveLength(0);
  });

  it('6. cross-organisation isolation: a forged org id in the envelope is dropped even if the channel somehow matched', async () => {
    const orgA = await factory.createOrganisation();
    const managerA = await factory.createInternalManager(orgA, { label: 'rtg6' });
    const tokenA = await factory.login(managerA);

    const conn = connectSse(baseUrl, { Authorization: `Bearer ${tokenA}` });
    openConnections.push(conn);
    await new Promise((r) => setTimeout(r, 150));

    // Published on A's own channel (userId matches), but the envelope's organisationId is forged —
    // defense in depth (requirement 3.7/3.6): the channel name is never trusted as proof alone.
    const forged = validEnvelope({ organisationId: randomUUID(), workspaceId: managerA.workspaceId, targetUserId: managerA.userId });
    await publishRaw(realtimeUserChannel(nodeEnv, managerA.userId), JSON.stringify(forged));
    await new Promise((r) => setTimeout(r, 200));
    expect(conn.events).toHaveLength(0);

    // A legitimate, correctly-scoped event on the same connection still gets through afterward.
    const real = validEnvelope({ organisationId: managerA.organisationId, workspaceId: managerA.workspaceId, targetUserId: managerA.userId });
    await publishRaw(realtimeUserChannel(nodeEnv, managerA.userId), JSON.stringify(real));
    const received = await conn.waitForEvent();
    expect(JSON.parse(received.data).eventId).toBe(real.eventId);
  });

  it('7. REALTIME_MAX_CONNECTIONS_PER_USER is enforced — a connection beyond the bound is refused, not queued', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'rtg7' });
    const token = await factory.login(manager);

    const conn1 = connectSse(baseUrl, { Authorization: `Bearer ${token}` });
    const conn2 = connectSse(baseUrl, { Authorization: `Bearer ${token}` });
    openConnections.push(conn1, conn2);
    await new Promise((r) => setTimeout(r, 150));

    // REALTIME_MAX_CONNECTIONS_PER_USER=2 for this suite — the third must be refused.
    const conn3 = connectSse(baseUrl, { Authorization: `Bearer ${token}` });
    openConnections.push(conn3);
    await conn3.waitForClose();
    expect(conn3.events).toHaveLength(0);
  });

  it('8. an exact duplicate event (same eventId) is delivered to one connection only once', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'rtg8' });
    const token = await factory.login(manager);
    const conn = connectSse(baseUrl, { Authorization: `Bearer ${token}` });
    openConnections.push(conn);
    await new Promise((r) => setTimeout(r, 150));

    const envelope = validEnvelope({ organisationId: manager.organisationId, workspaceId: manager.workspaceId, targetUserId: manager.userId });
    await publishRaw(realtimeUserChannel(nodeEnv, manager.userId), JSON.stringify(envelope));
    await conn.waitForEvent();
    // Publish the EXACT same envelope again (at-least-once semantics, Stage 2's own documented contract).
    await publishRaw(realtimeUserChannel(nodeEnv, manager.userId), JSON.stringify(envelope));
    await new Promise((r) => setTimeout(r, 200));

    expect(conn.events.filter((e) => JSON.parse(e.data).eventId === envelope.eventId)).toHaveLength(1);
  });

  it('9. a malformed Redis message is dropped silently — the connection stays alive and still receives a later valid event', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'rtg9' });
    const token = await factory.login(manager);
    const conn = connectSse(baseUrl, { Authorization: `Bearer ${token}` });
    openConnections.push(conn);
    await new Promise((r) => setTimeout(r, 150));

    await publishRaw(realtimeUserChannel(nodeEnv, manager.userId), 'not even json');
    await publishRaw(realtimeUserChannel(nodeEnv, manager.userId), JSON.stringify({ version: 1 })); // valid JSON, missing required fields
    await new Promise((r) => setTimeout(r, 200));
    expect(conn.events).toHaveLength(0);
    expect(conn.isClosed()).toBe(false);

    const real = validEnvelope({ organisationId: manager.organisationId, workspaceId: manager.workspaceId, targetUserId: manager.userId });
    await publishRaw(realtimeUserChannel(nodeEnv, manager.userId), JSON.stringify(real));
    const received = await conn.waitForEvent();
    expect(JSON.parse(received.data).eventId).toBe(real.eventId);
  });

  it('10. connection/resource cleanup: closing the client removes the registry entry', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'rtg10' });
    const token = await factory.login(manager);
    const before = registry.countForUser(manager.userId);
    const conn = connectSse(baseUrl, { Authorization: `Bearer ${token}` });
    await new Promise((r) => setTimeout(r, 150));
    expect(registry.countForUser(manager.userId)).toBe(before + 1);

    conn.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(registry.countForUser(manager.userId)).toBe(before);
  });

  it('11. a session revoked mid-connection stops receiving events within one heartbeat interval', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'rtg11' });
    const token = await factory.login(manager);
    const conn = connectSse(baseUrl, { Authorization: `Bearer ${token}` });
    openConnections.push(conn);
    await new Promise((r) => setTimeout(r, 150));

    // A real revocation path (RefreshTokenService.revokeAllForUser), not a synthetic flag flip —
    // bumps core.user_session.security_version, exactly what SecurityVersionService.readVector()
    // compares on every heartbeat (REALTIME_HEARTBEAT_INTERVAL_MS=5000, the class's own @Min floor,
    // for this suite — the wait below is generous enough to span at least one real heartbeat tick).
    await tenantContext.runInTenantContext({ organisationId: manager.organisationId, workspaceId: manager.workspaceId, userId: manager.userId, role: '' }, (m) =>
      refreshTokenService.revokeAllForUser(m, manager.userId, 'test_revocation'),
    );

    await conn.waitForClose(8000);
    expect(conn.isClosed()).toBe(true);
  }, 15_000);

  it('12. no privileged database credential is required — this entire suite already runs the gateway against the ordinary restricted runtime connection', async () => {
    // `dataSource`/`tenantContext` above are the SAME connection every other route in this app
    // uses (DATABASE_URL, never DATABASE_URL_UNPOOLED) — every test in this file already proves
    // the gateway works under it. This test exists only to state that fact as its own assertion,
    // mirroring Stage 1/2's own such tests, rather than leaving it merely implied.
    const [row] = await dataSource.query<Array<{ current_user: string }>>('SELECT current_user');
    expect(row!.current_user).not.toBe('rab');
    expect(row!.current_user).not.toBe('rab_owner');
    expect(row!.current_user).not.toBe('rab_secure_owner');
  });

  it('13. two independent subscriber instances (simulating two API replicas sharing one Redis) both receive the same published event', async () => {
    // Each `RealtimeSubscriber` here stands in for one API replica's own `RealtimeGatewaySubscriberProvider`
    // singleton — this proves the actual mechanism multiple replicas depend on (Redis fans a single
    // PUBLISH out to every current SUBSCRIBE-r, not just whichever instance happens to hold a
    // particular HTTP connection), without the cost of booting two full Nest applications.
    const userId = randomUUID();
    const channel = realtimeUserChannel(nodeEnv, userId);
    const replicaA = new RealtimeSubscriber(redisProvider.client);
    const replicaB = new RealtimeSubscriber(redisProvider.client);
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    await replicaA.subscribe(channel, (envelope) => receivedA.push(envelope));
    await replicaB.subscribe(channel, (envelope) => receivedB.push(envelope));

    const envelope = validEnvelope({ targetUserId: userId });
    await publishRaw(channel, JSON.stringify(envelope));
    await new Promise((r) => setTimeout(r, 200));

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
    await replicaA.close();
    await replicaB.close();
  });

  // ---------------------------------------------------------------- time-based expiry (added after
  // an explicit review question: does the heartbeat's security-version check alone catch SILENT,
  // time-based expiry? It does not — a session that merely goes idle, or passes its absolute
  // deadline, never bumps security_version. Tests 14-16 use a controlled test clock: rather than
  // waiting out a real 30-minute idle window or a real 15-minute JWT TTL, they directly set the
  // authoritative expiry column (`idle_expires_at`) or mint a short-lived token via
  // `AccessTokenService.sign()`'s own `clampToMs` parameter — the same "advance the clock" idiom
  // this session has used throughout for lease/retry expiry (e.g. Stage 1/2's claim tests).

  it('14. a manager session that goes idle mid-connection is disconnected — a version check alone would never catch this', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'rtg14' });
    const token = await factory.login(manager);
    const conn = connectSse(baseUrl, { Authorization: `Bearer ${token}` });
    openConnections.push(conn);
    await new Promise((r) => setTimeout(r, 150));

    const { sid } = accessTokenService.verify(token);
    // Controlled clock: backdate idle_expires_at directly rather than waiting out the real 30-minute
    // manager_web idle policy. This column is the SAME one `SessionValidityService.assertActive`
    // reads on every ordinary HTTP request — setting it into the past is exactly equivalent to time
    // having genuinely passed.
    await adminDataSource.manager.query(`UPDATE core.user_session SET idle_expires_at = now() - interval '1 minute' WHERE id = $1`, [sid]);

    await conn.waitForClose(8000);
    expect(conn.isClosed()).toBe(true);

    // The heartbeat's own read-only check must not have slid the window back out — the row stays idle-expired.
    const [row] = await adminDataSource.manager.query<Array<{ idle_expires_at: Date }>>(`SELECT idle_expires_at FROM core.user_session WHERE id = $1`, [sid]);
    expect(row!.idle_expires_at.getTime()).toBeLessThan(Date.now());
  }, 15_000);

  it('15. a platform-admin session that goes idle mid-connection is disconnected the same way — no role-specific carve-out', async () => {
    const org = await factory.createOrganisation();
    const admin = await factory.createInternalManager(org, { label: 'rtg15', platformAdmin: true });
    const token = await factory.login(admin);
    const conn = connectSse(baseUrl, { Authorization: `Bearer ${token}` });
    openConnections.push(conn);
    await new Promise((r) => setTimeout(r, 150));

    const { sid } = accessTokenService.verify(token);
    await adminDataSource.manager.query(`UPDATE core.user_session SET idle_expires_at = now() - interval '1 minute' WHERE id = $1`, [sid]);

    await conn.waitForClose(8000);
    expect(conn.isClosed()).toBe(true);
  }, 15_000);

  it('16. a mobile connection whose access token expires mid-stream is disconnected, independent of the session row staying alive', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'rtg16' });
    const staff = await factory.createStaff(org, { owner: manager, label: 'rtg16-staff' });
    // A real login first, to get a genuinely live refresh-token family (sid) and real roles —
    // then a SEPARATE, deliberately short-lived access token minted directly against that same
    // family via `clampToMs`, standing in for "this specific JWT is about to expire" without
    // waiting out the real 15-minute ACCESS_TOKEN_TTL_MS.
    const realToken = await factory.login(staff);
    const { sid, sub, org: tokenOrg, roles, applicationTarget } = accessTokenService.verify(realToken) as unknown as {
      sid: string;
      sub: string;
      org: string;
      roles: string[];
      applicationTarget: 'staff_app';
    };
    const shortLivedToken = accessTokenService.sign({ sub, org: tokenOrg, roles, sid, applicationTarget }, 1_500);

    const conn = connectSse(baseUrl, { Authorization: `Bearer ${shortLivedToken}` });
    openConnections.push(conn);
    await new Promise((r) => setTimeout(r, 150));
    expect(conn.isClosed()).toBe(false); // still within the short token's own 1.5s life, well inside the 5s heartbeat tick

    // The underlying session/refresh family is still genuinely live — only THIS token has expired —
    // proving the two conditions are independent, not one implying the other.
    await conn.waitForClose(8000);
    expect(conn.isClosed()).toBe(true);
    const [row] = await adminDataSource.manager.query<Array<{ revoked_at: Date | null }>>(`SELECT revoked_at FROM core.user_session WHERE id = $1`, [sid]);
    expect(row!.revoked_at).toBeNull();
  }, 15_000);

  // ------------------------------------------------------------------ Stage 4 exit gate: "session
  // revocation AND permission changes stop further private event delivery" — test 11 only ever
  // proved the FIRST half (sessionVersion). `vectorsEqual` compares every field of the vector, but
  // that is a claim about the comparison function, not evidence the SOURCE for each field is
  // actually wired to a real mutation path. Tests 17/18 close that gap for the two fields test 11
  // never touches: rolePermissionVersion and workspaceMembershipVersion.

  it('17. a role permission change mid-connection (not a session revocation) also disconnects the stream', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'rtg17' });
    const token = await factory.login(manager);
    const conn = connectSse(baseUrl, { Authorization: `Bearer ${token}` });
    openConnections.push(conn);
    await new Promise((r) => setTimeout(r, 150));
    expect(conn.isClosed()).toBe(false);

    // The session row itself is untouched — only the ROLE this manager holds changes. If this test
    // failed, the ONLY reason test 11 passes would be sessionVersion specifically, leaving a real
    // permission edit (e.g. a flag revoked mid-shift) silently undetected by the heartbeat.
    await adminDataSource.manager.query(
      `UPDATE core.role SET permission_version = permission_version + 1
        WHERE id = (SELECT role_id FROM core.user_role WHERE user_id = $1 LIMIT 1)`,
      [manager.userId],
    );

    await conn.waitForClose(8000);
    expect(conn.isClosed()).toBe(true);
  }, 15_000);

  it('18. a workspace-membership security-version change mid-connection disconnects the stream — the only "workspace switch" signal this product has (there is no live in-session workspace switcher; a real rebind requires a fresh login/session, which is a fresh connection by construction)', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'rtg18' });
    const token = await factory.login(manager);
    const conn = connectSse(baseUrl, { Authorization: `Bearer ${token}` });
    openConnections.push(conn);
    await new Promise((r) => setTimeout(r, 150));
    expect(conn.isClosed()).toBe(false);

    const [membership] = await adminDataSource.manager.query<Array<{ exists: boolean }>>(
      `SELECT EXISTS(SELECT 1 FROM core.workspace_membership WHERE user_id = $1 AND workspace_id = $2) AS exists`,
      [manager.userId, manager.workspaceId],
    );
    expect(membership!.exists).toBe(true); // sanity: this manager really does have a membership row to bump

    await adminDataSource.manager.query(
      `UPDATE core.workspace_membership SET security_version = security_version + 1 WHERE user_id = $1 AND workspace_id = $2`,
      [manager.userId, manager.workspaceId],
    );

    await conn.waitForClose(8000);
    expect(conn.isClosed()).toBe(true);
  }, 15_000);
});
