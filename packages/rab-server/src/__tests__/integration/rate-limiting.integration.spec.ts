import 'reflect-metadata';

// Must be set before AppModule compiles — jest-setup.ts sets this 'true' for
// every spec file (the integration suite shares one IP across many spec
// files that each hit /auth/login repeatedly within the same 60s window,
// none of which is the abuse RabThrottlerModule exists to catch). This is
// the one file that deliberately flips it back, to exercise the real 5
// req/min/IP auth-endpoint limit end-to-end. Restored in afterAll — Jest
// runs spec files in a worker sequentially, not each in its own process, so
// a later file's own AppModule boot must see 'true' again, not this file's
// leftover override.
const ORIGINAL_FLAG = process.env.RAB_DISABLE_RATE_LIMIT;
process.env.RAB_DISABLE_RATE_LIMIT = 'false';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../../app.module';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { clearThrottleState } from './helpers/throttle-state';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('rate limiting (integration)', () => {
  let app: INestApplication;
  let redis: ThrottlerRedisClientProvider;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    redis = moduleRef.get(ThrottlerRedisClientProvider);
    // Buckets left by an earlier suite in the same minute (e.g. attendance's throttle test) would make the first
    // login attempts below already count against this IP.
    await clearThrottleState(redis);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    // Mirrors main.ts's bootstrap() — Test.createTestingModule never runs
    // that function, so this app-level Express setting has to be duplicated
    // here the same way ValidationPipe already is above, or the tracker
    // tests below would exercise Express's default (trust nothing) instead
    // of the real production setting.
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    // Test-only introspection route, registered directly on the raw Express
    // instance this Jest-created app never exposes outside this process —
    // it lets the tests below assert on the exact `req.ip`/`req.ips` value
    // Express computes for a given X-Forwarded-For chain, which is what the
    // rate limiter's tracker actually keys on. Never present in the app
    // built by main.ts's real bootstrap().
    app.getHttpAdapter().getInstance().get('/__test-req-ip', (req: any, res: any) => {
      res.json({ ip: req.ip, ips: req.ips });
    });
    await app.init();
  });

  afterAll(async () => {
    await clearThrottleState(redis);
    await app.close();
    process.env.RAB_DISABLE_RATE_LIMIT = ORIGINAL_FLAG;
  });

  it('throttles repeated /auth/login attempts from the same IP — 5 pass, the 6th gets 429', async () => {
    // A fresh, never-reused email per run — this hits real Postgres (not
    // reset between test runs), and AuthService's own per-account lockout
    // (10 failures/15min) would otherwise eventually trip on a hardcoded
    // email shared with auth-abuse-cases.integration.spec.ts's own
    // unknown-email test, masking the 429 this test is actually checking for.
    const email = `ratelimit-${randomUUID()}@example.test`;
    const attempt = () => request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password: 'wrong' });

    for (let i = 0; i < 5; i++) {
      const res = await attempt();
      expect(res.status).toBe(401);
    }

    const sixth = await attempt();
    expect(sixth.status).toBe(429);
  });

  it('throttles repeated /auth/forgot-password attempts the same way', async () => {
    const email = `ratelimit-${randomUUID()}@example.test`;
    const attempt = () => request(app.getHttpServer()).post('/rest/v1/auth/forgot-password').send({ email });

    for (let i = 0; i < 5; i++) {
      const res = await attempt();
      expect(res.status).toBe(204);
    }

    const sixth = await attempt();
    expect(sixth.status).toBe(429);
  });

  it('does not throttle a normal authenticated GET route at the same volume', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await request(app.getHttpServer()).get('/healthz');
      expect(res.status).toBe(200);
    }
  });

  describe('trust proxy (SEC-03)', () => {
    // Deliberately no assertion pinned to a specific literal IP anywhere
    // below — supertest's direct connection resolves to whatever loopback
    // address Node picks (v4 vs v6 depends on the environment), so every
    // check here compares relative behavior (does the untrusted-hop value
    // survive into req.ip, or get discarded) rather than an exact string.

    it('a direct request with no X-Forwarded-For resolves req.ip to the real socket peer, not a proxy header', async () => {
      const res = await request(app.getHttpServer()).get('/__test-req-ip');
      expect(res.status).toBe(200);
      // No forwarded chain at all — req.ips must be empty (Express only
      // populates it from a trusted X-Forwarded-For), and req.ip must be a
      // real address, not undefined/empty.
      expect(res.body.ips).toEqual([]);
      expect(typeof res.body.ip).toBe('string');
      expect(res.body.ip.length).toBeGreaterThan(0);
    });

    it('one legitimate proxy hop (Render-like): the single forwarded value is trusted as the client IP', async () => {
      const claimedClientIp = '203.0.113.42'; // TEST-NET-3, RFC 5737 — never a routable real address
      const res = await request(app.getHttpServer())
        .get('/__test-req-ip')
        .set('X-Forwarded-For', claimedClientIp);
      expect(res.status).toBe(200);
      // trust proxy = 1 means: trust exactly the nearest hop as a proxy, and
      // take the client address from the entry immediately before it — with
      // a single-entry header, that entry IS the resolved req.ip.
      expect(res.body.ip).toBe(claimedClientIp);
    });

    it('a spoofed multi-hop X-Forwarded-For does not let a client inject an arbitrary "real" IP', async () => {
      // An attacker prepending their own fake hop in front of whatever
      // Render's edge itself appends. If trust proxy were misconfigured as
      // `true` (trust every hop), Express would take the LEFTMOST entry —
      // attacker-controlled — as req.ip. With trust proxy = 1 (exactly one
      // trusted hop), only the entry nearest to this server is trusted;
      // this test simulates "Render's edge" as the nearest hop and asserts
      // the attacker's own prepended, further-away entry is never selected.
      const attackerClaimed = '10.0.0.1';
      const rendersRealAppend = '198.51.100.7'; // TEST-NET-2, RFC 5737
      const res = await request(app.getHttpServer())
        .get('/__test-req-ip')
        .set('X-Forwarded-For', `${attackerClaimed}, ${rendersRealAppend}`);
      expect(res.status).toBe(200);
      expect(res.body.ip).toBe(rendersRealAppend);
      expect(res.body.ip).not.toBe(attackerClaimed);
    });

    it('CF-Connecting-IP (Cloudflare-set, un-spoofable at the edge) takes priority over any X-Forwarded-For value when both are present', async () => {
      // Production is verified Cloudflare-fronted (live response headers:
      // Server: cloudflare, CF-RAY) — Cloudflare sets this header itself
      // from the real TCP connection, overwriting rather than appending, so
      // it stays trustworthy across however many additional hops sit
      // between Cloudflare and this process. A client-forged
      // X-Forwarded-For alongside it must not win.
      const realCfIp = '198.51.100.55';
      const forgedXff = '10.0.0.1';
      const attempt = () =>
        request(app.getHttpServer())
          .post('/rest/v1/auth/forgot-password')
          .set('CF-Connecting-IP', realCfIp)
          .set('X-Forwarded-For', forgedXff)
          .send({ email: `ratelimit-cf-${randomUUID()}@example.test` });

      for (let i = 0; i < 5; i++) {
        const res = await attempt();
        expect(res.status).toBe(204);
      }
      const sixth = await attempt();
      expect(sixth.status).toBe(429);

      // A different CF-Connecting-IP behind the SAME forged X-Forwarded-For
      // must NOT share that bucket — proving the tracker actually reads
      // CF-Connecting-IP, not silently falling back to the XFF value both
      // requests share.
      const otherCfRes = await request(app.getHttpServer())
        .post('/rest/v1/auth/forgot-password')
        .set('CF-Connecting-IP', '198.51.100.56')
        .set('X-Forwarded-For', forgedXff)
        .send({ email: `ratelimit-cf-${randomUUID()}@example.test` });
      expect(otherCfRes.status).toBe(204);
    });

    it('the throttler keys on the trusted client IP, not the raw header — two spoofed "first hops" behind the same real proxy still share one bucket', async () => {
      // Same real-proxy-appended IP, different attacker-supplied leftmost
      // entries. If the tracker were reading the untrusted leftmost value,
      // these would land in different buckets and never trip the limit
      // together; because trust proxy = 1 always resolves to the trusted
      // rightmost-of-the-trusted-boundary entry, they must share one bucket.
      const realProxyIp = '198.51.100.99';
      const attempt = (fakeLeftHop: string) =>
        request(app.getHttpServer())
          .post('/rest/v1/auth/forgot-password')
          .set('X-Forwarded-For', `${fakeLeftHop}, ${realProxyIp}`)
          .send({ email: `ratelimit-xff-${randomUUID()}@example.test` });

      for (let i = 0; i < 5; i++) {
        const res = await attempt(`10.0.0.${i}`);
        expect(res.status).toBe(204);
      }
      const sixth = await attempt('10.0.0.99');
      expect(sixth.status).toBe(429);
    });
  });
});
