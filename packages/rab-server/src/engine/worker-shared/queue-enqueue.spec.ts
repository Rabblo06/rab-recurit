import Redis from 'ioredis';

import { EnvironmentService } from '../core-modules/environment/environment.service';
import { EmailQueueService } from '../core-modules/email/email-queue.service';
import { PushQueueService } from '../core-modules/push/push-queue.service';
import { AiTurnQueueService } from '../../modules/ai/services/ai-turn-queue.service';
import { enqueueRegisteredJob, QueueEnqueueRefusedError, registeredJob, scanJobTemplate } from './queue-enqueue';
import { QueuePublishUnavailableError } from './queue-producer-connection';
import { QueueName } from './queue-registry';

/**
 * Phase D-Q1: every enqueue declares a VALIDATED tenant scope, carries an ids-only payload and uses the registry's
 * options. The "byte-identical" tests compare each producer's `queue.add(name, data, opts)` against the pre-D-Q1 literal
 * (origin/main 1efaea43), so an old and a new process publish identical jobs (rolling deploy). The abuse cases are the
 * denials: each would have been ADDED by the pre-D-Q1 producers (which had no scope at all).
 */
const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';
const ID = '11111111-1111-4111-8111-111111111111';
const WS = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const CONV = '66666666-6666-4666-8666-666666666666';
const OUTBOX_OPTS = { attempts: 5, backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 }, removeOnComplete: { age: 604_800 }, removeOnFail: { age: 2_592_000 } };
const AI_OPTS = { attempts: 1, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 604_800, count: 5000 } };

type Added = [string, unknown, Record<string, unknown>];
const fakeQueue = (name: string) => {
  const added: Added[] = [];
  return { name, added, add: jest.fn(async (n: string, d: unknown, o: Record<string, unknown>) => void added.push([n, d, o])) };
};
const env = { get: (key: string) => (key === 'REDIS_URL' ? 'redis://127.0.0.1:1' : undefined) } as unknown as EnvironmentService;

/** Builds a producer service, closes its real (unreachable) connection, and swaps in a fake queue + a "ready" client. */
function withFakeQueue<T extends object>(service: T, queueName: string) {
  const s = service as unknown as { connection: Redis; queue: unknown };
  s.connection.disconnect();
  const queue = fakeQueue(queueName);
  s.queue = queue;
  s.connection = { status: 'ready' } as unknown as Redis;
  return queue;
}

describe('queue-enqueue (Phase D-Q1)', () => {
  describe('producers publish byte-identical jobs (same name, payload, jobId format and options as before D-Q1)', () => {
    it('rab-email: publish (attempt.0) and republish (attempt.<gen>)', async () => {
      const service = new EmailQueueService(env);
      const queue = withFakeQueue(service, 'rab-email');
      await service.publish(ID, ORG);
      await service.republish(ID, ORG, 3);
      expect(queue.added).toEqual([
        ['send-email', { emailOutboxId: ID, organisationId: ORG }, { jobId: `email-outbox.${ID}.attempt.0`, ...OUTBOX_OPTS }],
        ['send-email', { emailOutboxId: ID, organisationId: ORG }, { jobId: `email-outbox.${ID}.attempt.3`, ...OUTBOX_OPTS }],
      ]);
    });

    it('rab-push: publish (attempt.0) and republish (attempt.<gen>)', async () => {
      const service = new PushQueueService(env);
      const queue = withFakeQueue(service, 'rab-push');
      await service.publish(ID, ORG);
      await service.republish(ID, ORG, 2);
      expect(queue.added).toEqual([
        ['send-push', { pushDeliveryId: ID, organisationId: ORG }, { jobId: `push-delivery.${ID}.attempt.0`, ...OUTBOX_OPTS }],
        ['send-push', { pushDeliveryId: ID, organisationId: ORG }, { jobId: `push-delivery.${ID}.attempt.2`, ...OUTBOX_OPTS }],
      ]);
    });

    it('rab-ai: turn, deferred claim (delay), promotion, resume and title', async () => {
      const service = new AiTurnQueueService(env);
      const queue = withFakeQueue(service, 'rab-ai');
      const ids = { turnId: ID, conversationId: CONV, organisationId: ORG, workspaceId: WS, userId: USER };
      const base = { turnId: ID, conversationId: CONV, organisationId: ORG, workspaceId: WS, userId: USER };
      await service.enqueue(ids);
      await service.enqueueTurn(ids, { jobId: `ai-turn.${ID}.w12`, delayMs: 1500.7 });
      await service.enqueueTurn(ids, { jobId: `ai-turn.${ID}.next`, delayMs: 0 });
      await service.enqueueResume(ids, { pausedTurnId: USER, cause: 'proposal_decided' as never, refId: WS });
      await service.enqueueTitle(ids);
      expect(queue.added).toEqual([
        ['ai-turn', { v: 2, kind: 'turn', ...base }, { jobId: `ai-turn.${ID}`, ...AI_OPTS }],
        ['ai-turn', { v: 2, kind: 'turn', ...base }, { jobId: `ai-turn.${ID}.w12`, delay: 1500, ...AI_OPTS }],
        ['ai-turn', { v: 2, kind: 'turn', ...base }, { jobId: `ai-turn.${ID}.next`, ...AI_OPTS }],
        ['ai-turn', { v: 2, kind: 'resume', ...base, pausedTurnId: USER, cause: 'proposal_decided', refId: WS }, { jobId: `ai-turn.${ID}`, ...AI_OPTS }],
        ['ai-title', { v: 2, kind: 'title', ...base }, { jobId: `ai-title.${CONV}`, ...AI_OPTS }],
      ]);
    });

    it('scan job scheduler template: system scope, `{ v: 1 }`, one attempt, 1 h / 1000 and 7 d retention', () => {
      expect(scanJobTemplate('crewflow-scan-offers', 'offer-expiry', { kind: 'system' }, { v: 1 })).toEqual({
        name: 'offer-expiry',
        data: { v: 1 },
        opts: { attempts: 1, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 604_800 } },
      });
    });
  });

  describe('abuse cases: an enqueue without a valid tenant scope is refused before Redis (fail closed)', () => {
    const data = { emailOutboxId: ID, organisationId: ORG };
    const job = (scope: unknown, payload: object = data, name = 'send-email', queue: QueueName = 'rab-email') =>
      registeredJob(queue, name as never, scope as never, payload, { jobId: `email-outbox.${ID}.attempt.0` });

    it.each<[string, unknown]>([
      ['no scope', undefined],
      ['a null scope', null],
      ['a string scope', ORG],
      ['an empty scope object', {}],
      ['an organisation scope without organisationId', { kind: 'organisation' }],
      ['an organisation scope with a non-UUID id', { kind: 'organisation', organisationId: 'org-1' }],
      ['an organisation scope with an injected id', { kind: 'organisation', organisationId: `${ORG}' OR 1=1` }],
      ['an organisation scope with extra fields', { kind: 'organisation', organisationId: ORG, workspaceId: WS }],
      ['an unknown scope kind', { kind: 'platform' }],
      ['a system scope on an organisation queue', { kind: 'system' }],
    ])('refuses %s', (_what, scope) => {
      expect(() => job(scope)).toThrow(QueueEnqueueRefusedError);
    });

    it('refuses a scope that names a different organisation than the payload (cross-tenant)', () => {
      expect(() => job({ kind: 'organisation', organisationId: OTHER_ORG })).toThrow(/does not match the declared tenant scope/);
    });

    it('refuses an organisation scope on a scan queue, and a scan payload that names an organisation', () => {
      expect(() => scanJobTemplate('crewflow-scan-email', 'email-dispatch', { kind: 'organisation', organisationId: ORG } as never, { v: 1 })).toThrow(/requires a system scope/);
      expect(() => scanJobTemplate('crewflow-scan-email', 'email-dispatch', { kind: 'system' }, { v: 1, organisationId: ORG } as never)).toThrow(QueueEnqueueRefusedError);
      expect(() => scanJobTemplate('crewflow-scan-email', 'offer-expiry' as never, { kind: 'system' }, { v: 1 })).toThrow(/unknown job name/);
      expect(() => scanJobTemplate('rab-email' as never, 'send-email' as never, { kind: 'system' } as never, { v: 1 })).toThrow(/not a scan queue/);
    });

    it.each<[string, object]>([
      ['an unknown payload key (content)', { ...data, subject: 'Hello' }],
      ['a nested object', { emailOutboxId: { $ne: null }, organisationId: ORG }],
      ['an array value', { emailOutboxId: [ID], organisationId: ORG }],
      ['a boolean value', { emailOutboxId: true, organisationId: ORG }],
      ['an over-long string (not an identifier)', { emailOutboxId: 'x'.repeat(129), organisationId: ORG }],
      ['a non-finite number', { emailOutboxId: Number.NaN, organisationId: ORG }],
      ['a payload without organisationId', { emailOutboxId: ID }],
    ])('refuses a payload with %s (ids only)', (_what, payload) => {
      expect(() => job({ kind: 'organisation', organisationId: ORG }, payload)).toThrow(QueueEnqueueRefusedError);
    });

    it('refuses an unknown job name, an unknown queue and a missing jobId', () => {
      expect(() => job({ kind: 'organisation', organisationId: ORG }, data, 'send-push')).toThrow(/unknown job name/);
      expect(() => job({ kind: 'organisation', organisationId: ORG }, data, 'send-email', 'rab-mail' as QueueName)).toThrow(/not in the queue registry/);
      expect(() => registeredJob('rab-email', 'send-email', { kind: 'organisation', organisationId: ORG }, data, { jobId: '' })).toThrow(/jobId/);
    });

    it('refuses to add a job to a queue object of another name (and never calls add)', () => {
      const queue = fakeQueue('rab-push');
      const ok = registeredJob('rab-email', 'send-email', { kind: 'organisation', organisationId: ORG }, data, { jobId: 'x' });
      expect(() => enqueueRegisteredJob(queue as never, ok)).toThrow(QueueEnqueueRefusedError);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('a refused publish is a QueueEnqueueRefusedError (never disguised as a Redis outage) and nothing is added', async () => {
      // Pre-D-Q1, EmailQueueService.publish added this job: no scope existed and the org id was never checked.
      const service = new EmailQueueService(env);
      const queue = withFakeQueue(service, 'rab-email');
      const error = await service.publish(ID, 'not-a-uuid').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(QueueEnqueueRefusedError);
      expect(error).not.toBeInstanceOf(QueuePublishUnavailableError);
      expect(queue.add).not.toHaveBeenCalled();
      const push = new PushQueueService(env);
      const pushQueue = withFakeQueue(push, 'rab-push');
      await expect(push.republish(ID, '', 1)).rejects.toBeInstanceOf(QueueEnqueueRefusedError);
      expect(pushQueue.add).not.toHaveBeenCalled();
      const ai = new AiTurnQueueService(env);
      const aiQueue = withFakeQueue(ai, 'rab-ai');
      await expect(ai.enqueue({ turnId: ID, conversationId: CONV, organisationId: 'org', workspaceId: WS, userId: USER })).rejects.toBeInstanceOf(QueueEnqueueRefusedError);
      expect(aiQueue.add).not.toHaveBeenCalled();
    });
  });
});
