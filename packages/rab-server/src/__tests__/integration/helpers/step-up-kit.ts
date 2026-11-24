import { INestApplication } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';

import { AuthCacheRedisClientProvider } from '../../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { StepUpReauthService } from '../../../engine/core-modules/auth/services/step-up-reauth.service';
import { codeAt, earlyInStep, secretFromOtpauth } from './mfa-test-kit';
import { TestSetupError } from './test-identities';

/**
 * Owner decision 5 (payroll approval needs a fresh second-factor proof bound to the approval action, single use).
 *
 * `enrolTotp`: the real enrolment API on THIS session (start with the password, confirm with a code). Other sessions of the
 * account end; this one stays. Returns the TOTP secret.
 *
 * `freshApprovalProof`: the real path — POST /auth/step-up with password, a current code AND the action. TOTP steps are
 * replay-protected, so a suite uses it once per secret and step; repeated approvals use `approvalGrant`.
 *
 * `approvalGrant`: fixture only — writes the single-use action-bound grant StepUpReauthService records after a verified
 * code (same key, same shape), for THIS session (the token's `sid`). One grant serves exactly one approval call.
 *
 * `serviceApprovalSession`: the same grant for a service-direct call with a hand-built AuthContext; returns the session id to
 * put on the context.
 */
export type ApprovalAction = 'payroll.record.approve' | 'payroll.run.finalise' | 'user.delete';

const sidOf = (token: string) => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
const actionKey = (sessionId: string, action: ApprovalAction) =>
  `crewflow:${process.env.NODE_ENV}:step-up:${createHash('sha256').update(sessionId).digest('hex')}:action:${action}`;

export async function enrolTotp(app: INestApplication, token: string, password: string): Promise<Buffer> {
  const http = () => request(app.getHttpServer());
  const started = await http().post('/rest/v1/auth/mfa/enrolment').set({ Authorization: `Bearer ${token}` }).send({ currentPassword: password });
  if (started.status !== 200) throw new TestSetupError(`MFA enrolment start returned ${started.status}`);
  const secret = secretFromOtpauth(started.body.otpauthUri);
  await earlyInStep(8);
  const confirmed = await http().post('/rest/v1/auth/mfa/enrolment/confirm').set({ Authorization: `Bearer ${token}` }).send({ code: codeAt(secret, -1) });
  if (confirmed.status !== 200) throw new TestSetupError(`MFA enrolment confirm returned ${confirmed.status}`);
  return secret;
}

export async function freshApprovalProof(app: INestApplication, token: string, password: string, code: string, action: ApprovalAction): Promise<request.Response> {
  return request(app.getHttpServer()).post('/rest/v1/auth/step-up').set({ Authorization: `Bearer ${token}` }).set('Origin', 'http://localhost:5173').send({ currentPassword: password, code, action });
}

export async function approvalGrant(redis: AuthCacheRedisClientProvider, token: string, userId: string, action: ApprovalAction = 'payroll.record.approve'): Promise<string> {
  await redis.client.set(actionKey(sidOf(token), action), JSON.stringify({ u: userId, mfa: true, at: Date.now(), via: 'password' }), 'PX', 120_000);
  return token;
}

export async function serviceApprovalSession(redis: AuthCacheRedisClientProvider, userId: string, action: ApprovalAction = 'payroll.record.approve', sessionId: string = randomUUID()): Promise<string> {
  await redis.client.set(actionKey(sessionId, action), JSON.stringify({ u: userId, mfa: true, at: Date.now(), via: 'password' }), 'PX', 120_000);
  return sessionId;
}

/** Fixture: removes this session's grant for `action` (what using or expiring it does). */
export async function dropApprovalGrant(redis: AuthCacheRedisClientProvider, token: string, action: ApprovalAction = 'payroll.record.approve'): Promise<void> {
  await redis.client.del(actionKey(sidOf(token), action));
}

/**
 * Owner decision 73 fixture, ONLY for suites whose subject is a deletion INVARIANT (who may delete whom, history,
 * workspaces, notifications), not the proof: lets `assertFreshSecondFactorForAction(ctx, 'user.delete')` pass while
 * `realProof()` is false, so those suites do not have to enrol every actor in TOTP (an enrolled actor's later sign-ins and
 * password re-entries need a code). Every other action, and 'user.delete' while `realProof()` is true, runs the real check.
 * The real gate and its denials (unenrolled, no proof, other action, expired, replay) are covered in
 * user-deletion-abuse-cases.integration.spec.ts with no bypass.
 */
export function bypassDeletionProof(app: INestApplication, realProof: () => boolean = () => false): jest.SpyInstance {
  const service = app.get(StepUpReauthService);
  const original = service.assertFreshSecondFactorForAction.bind(service);
  return jest.spyOn(service, 'assertFreshSecondFactorForAction').mockImplementation(async (ctx, action) => {
    if (action === 'user.delete' && !realProof()) return;
    return original(ctx, action);
  });
}
