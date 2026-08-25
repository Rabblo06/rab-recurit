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

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('rate limiting (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
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
});
