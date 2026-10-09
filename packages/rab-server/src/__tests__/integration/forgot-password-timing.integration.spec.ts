import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Hyper Workspace Phase 3, Part 9. Measures whether POST /auth/forgot-password is distinguishable by timing for an existing
 * versus a nonexistent address. The response BODY and STATUS must be identical; this test also records the timing samples.
 * Measurements are printed for the report; the assertion checks only the response, never a wall-clock threshold, because
 * timing on a shared test machine is not a reliable pass/fail signal.
 */
const RUN = Boolean(process.env.DATABASE_URL);
(RUN ? describe : describe.skip)('forgot-password timing and response uniformity (integration)', () => {
  let app: INestApplication;
  let owner: DataSource;
  let existingEmail: string;
  const SAMPLES = 12;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    const factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'fpt' });
    existingEmail = managers[0]!.email;
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
  });

  async function time(email: string): Promise<{ ms: number; status: number; body: unknown }> {
    const started = process.hrtime.bigint();
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/forgot-password').send({ email });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { ms, status: res.status, body: res.body };
  }

  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };

  it('existing and nonexistent addresses receive an identical status and body', async () => {
    const existing = await time(existingEmail);
    const absent = await time(`absent-${randomUUID()}@example.test`);
    expect(existing.status).toBe(absent.status);
    expect(existing.body).toEqual(absent.body);
  });

  it('records timing samples for existing versus nonexistent addresses (reported, not thresholded)', async () => {
    const existingMs: number[] = [];
    const absentMs: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      existingMs.push((await time(existingEmail)).ms);
      absentMs.push((await time(`absent-${randomUUID()}@example.test`)).ms);
    }
    // eslint-disable-next-line no-console
    console.log('FORGOT_PASSWORD_TIMING', JSON.stringify({
      samples: SAMPLES,
      existingMedianMs: Math.round(median(existingMs)),
      absentMedianMs: Math.round(median(absentMs)),
      existingMs: existingMs.map((x) => Math.round(x)),
      absentMs: absentMs.map((x) => Math.round(x)),
    }));
    expect(existingMs).toHaveLength(SAMPLES);
    expect(absentMs).toHaveLength(SAMPLES);
  });
});
