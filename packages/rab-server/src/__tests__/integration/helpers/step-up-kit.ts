import { INestApplication } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';

import { AuthCacheRedisClientProvider } from '../../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { TestSetupError } from './test-identities';

/**
 * Owner decision 5 (payroll approval needs a fresh step-up): helpers for suites that approve payroll.
 *
 * `freshStepUp` is the real path: POST /auth/step-up with the identity's password on THIS session (the grant lasts
 * AUTH_STEP_UP_WINDOW_SECONDS). Call it right before an approval, so a long suite never depends on how long ago it signed in.
 *
 * `serviceStepUpSession` is for suites that call PayrollService / PayrollRunService DIRECTLY with a hand-built AuthContext
 * (no HTTP session): it writes the same Redis grant a password step-up writes, for a new random session id, and returns that
 * id to put on the context (`{ ...ctx, sessionId }`). Fixture only; the production grant is written only by StepUpReauthService.
 */
export async function freshStepUp(app: INestApplication, token: string, password: string): Promise<void> {
  const res = await request(app.getHttpServer()).post('/rest/v1/auth/step-up').set({ Authorization: `Bearer ${token}` }).set('Origin', 'http://localhost:5173').send({ currentPassword: password });
  if (res.status !== 200) throw new TestSetupError(`POST /auth/step-up returned ${res.status} ${JSON.stringify(res.body?.code ?? res.body?.message ?? res.body)}`);
}

export async function serviceStepUpSession(redis: AuthCacheRedisClientProvider, userId: string, sessionId: string = randomUUID()): Promise<string> {
  const key = `crewflow:${process.env.NODE_ENV}:step-up:${createHash('sha256').update(sessionId).digest('hex')}`;
  await redis.client.set(key, JSON.stringify({ u: userId, mfa: false, at: Date.now(), via: 'password' }), 'PX', 120_000);
  return sessionId;
}
