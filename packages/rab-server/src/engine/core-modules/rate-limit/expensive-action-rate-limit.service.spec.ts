import { HttpException, ServiceUnavailableException } from '@nestjs/common';

import { EXPENSIVE_LIMIT, ExpensiveActionRateLimitService } from './expensive-action-rate-limit.service';

function make(evalImpl: (...args: unknown[]) => Promise<unknown>) {
  const evalMock = jest.fn(evalImpl);
  const service = new ExpensiveActionRateLimitService({ client: { eval: evalMock } } as never, { get: () => 'test' } as never);
  return { service, evalMock };
}
const actor = { userId: 'user-1', organisationId: 'org-1' };

describe('ExpensiveActionRateLimitService (§5.5 EXPENSIVE: 10/min per user, 30/min per organisation)', () => {
  const previous = process.env.RAB_DISABLE_RATE_LIMIT;
  beforeEach(() => { process.env.RAB_DISABLE_RATE_LIMIT = 'false'; });
  afterAll(() => {
    if (previous === undefined) delete process.env.RAB_DISABLE_RATE_LIMIT;
    else process.env.RAB_DISABLE_RATE_LIMIT = previous;
  });

  it('debits the user and the organisation bucket together, with the §5.5 capacities, under hashed per-action keys', async () => {
    const { service, evalMock } = make(async () => [1, 0, 0]);
    await expect(service.admit('bulk-scheduling', actor)).resolves.toBeUndefined();
    const [, keyCount, userKey, orgKey, specs] = evalMock.mock.calls[0]!;
    expect(keyCount).toBe(2);
    expect(userKey).toMatch(/^crewflow:test:expensive-rate:bulk-scheduling:user:[0-9a-f]{64}$/);
    expect(orgKey).toMatch(/^crewflow:test:expensive-rate:bulk-scheduling:organisation:[0-9a-f]{64}$/);
    expect(`${userKey}${orgKey}`).not.toContain('user-1');
    expect(JSON.parse(specs as string)).toEqual([
      { capacity: EXPENSIVE_LIMIT.perUser, windowMs: 60_000, cost: 1 },
      { capacity: EXPENSIVE_LIMIT.perOrganisation, windowMs: 60_000, cost: 1 },
    ]);
    expect([EXPENSIVE_LIMIT.perUser, EXPENSIVE_LIMIT.perOrganisation]).toEqual([10, 30]);
  });

  it('a short bucket is a 429 with a retry hint', async () => {
    const { service } = make(async () => [0, 1, 4200]);
    const error = await service.admit('bulk-scheduling', actor).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).getResponse()).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 5 });
  });

  it('fails closed: a Redis error or an unexpected reply is a 503, never allowed', async () => {
    await expect(make(async () => { throw new Error('ECONNREFUSED'); }).service.admit('x', actor)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(make(async () => 'OK').service.admit('x', actor)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('the one rate-limit switch skips it (never in production: isRateLimitBypassEnabled)', async () => {
    process.env.RAB_DISABLE_RATE_LIMIT = 'true';
    const { service, evalMock } = make(async () => [0, 1, 1000]);
    await expect(service.admit('x', actor)).resolves.toBeUndefined();
    expect(evalMock).not.toHaveBeenCalled();
  });
});
