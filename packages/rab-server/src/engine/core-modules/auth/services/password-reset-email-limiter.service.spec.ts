import { HttpException } from '@nestjs/common';

import { TOKEN_BUCKET_SCRIPT } from '../../rate-limit/token-bucket';
import { AuthService } from './auth.service';
import { PASSWORD_RESET_EMAIL_LIMIT, PasswordResetEmailLimiterService } from './password-reset-email-limiter.service';

/**
 * X1.4 forgot-password limit per address: the limiter's decisions (unit level; the real Lua atomicity and the
 * end-to-end counts are in forgot-password-email-limit.integration.spec.ts), and that AuthService checks it BEFORE any
 * account lookup.
 */
describe('PasswordResetEmailLimiterService (X1.4)', () => {
  const ORIGINAL_FLAG = process.env.RAB_DISABLE_RATE_LIMIT;
  beforeAll(() => {
    // jest-setup.ts disables every limiter for the suite; this file exercises the real decision logic.
    process.env.RAB_DISABLE_RATE_LIMIT = 'false';
  });
  afterAll(() => {
    process.env.RAB_DISABLE_RATE_LIMIT = ORIGINAL_FLAG;
  });

  const env = { get: (key: string) => (key === 'NODE_ENV' ? 'test' : undefined) };
  const make = (evalImpl: (...args: unknown[]) => Promise<unknown>) => {
    const client = { eval: jest.fn(evalImpl) };
    return { limiter: new PasswordResetEmailLimiterService({ client } as never, env as never), client };
  };
  const outcome = async (p: Promise<unknown>) => {
    try {
      await p;
      return { status: 204, body: undefined as unknown };
    } catch (error) {
      if (error instanceof HttpException) return { status: error.getStatus(), body: error.getResponse() };
      throw error;
    }
  };

  it('keys on the lower-cased, trimmed address, hashed: no email address appears in the Redis key', () => {
    const { limiter } = make(async () => [1, 0, 0]);
    const key = limiter.keyFor('  Person@Example.TEST ');
    expect(key).toBe(limiter.keyFor('person@example.test'));
    expect(key).toMatch(/^crewflow:test:password-reset-email:[0-9a-f]{64}$/);
    expect(key).not.toContain('@');
    expect(limiter.keyFor('other@example.test')).not.toBe(key);
  });

  it('debits one token from a 3-per-15-minute bucket with the shared atomic token-bucket script', async () => {
    const { limiter, client } = make(async () => [1, 0, 0]);
    await expect(limiter.admit('person@example.test')).resolves.toBeUndefined();
    expect(PASSWORD_RESET_EMAIL_LIMIT).toEqual({ capacity: 3, windowMs: 900_000 });
    expect(client.eval).toHaveBeenCalledWith(
      TOKEN_BUCKET_SCRIPT,
      1,
      limiter.keyFor('person@example.test'),
      JSON.stringify([{ capacity: 3, windowMs: 900_000, cost: 1 }]),
    );
  });

  it('an exhausted bucket refuses with 429 and one constant body (no retry time, nothing about the account)', async () => {
    const { limiter } = make(async () => [0, 1, 299_000]);
    const a = await outcome(limiter.admit('known@example.test'));
    const { limiter: other } = make(async () => [0, 1, 1_000]);
    const b = await outcome(other.admit('unknown@example.test'));
    expect(a.status).toBe(429);
    expect(a).toEqual(b);
    expect(a.body).toEqual({
      statusCode: 429,
      code: 'PASSWORD_RESET_RATE_LIMITED',
      message: 'Too many password reset requests for this address. Please wait a few minutes, then try again.',
    });
  });

  it.each([
    ['a Redis error', async () => Promise.reject(new Error('Command timed out'))],
    ['an unexpected reply', async () => 'OK'],
  ])('fails closed on %s: 503 RATE_LIMIT_UNAVAILABLE, never "send anyway"', async (_name, impl) => {
    const { limiter } = make(impl);
    const res = await outcome(limiter.admit('person@example.test'));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
  });

  it('is skipped under Jest unless RAB_DISABLE_RATE_LIMIT is "false" (the same switch as the login limiter)', async () => {
    const { limiter, client } = make(async () => [0, 1, 1_000]);
    process.env.RAB_DISABLE_RATE_LIMIT = 'true';
    try {
      await expect(limiter.admit('person@example.test')).resolves.toBeUndefined();
      expect(client.eval).not.toHaveBeenCalled();
    } finally {
      process.env.RAB_DISABLE_RATE_LIMIT = 'false';
    }
  });

  it('AuthService.forgotPassword checks the limit BEFORE any account lookup; a refusal looks up, issues and sends nothing, and is still padded to the floor', async () => {
    const dataSource = { query: jest.fn(async () => []) };
    const limiter = { admit: jest.fn(async () => Promise.reject(new HttpException({ code: 'PASSWORD_RESET_RATE_LIMITED' }, 429))) };
    const args: unknown[] = new Array(20).fill(undefined);
    args[0] = dataSource;
    const auth = new (AuthService as unknown as new (...a: unknown[]) => AuthService)(...args, limiter);
    const started = Date.now();
    const res = await outcome(auth.forgotPassword({ email: ' Person@Example.test ' }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(res.status).toBe(429);
    expect(limiter.admit).toHaveBeenCalledWith(' Person@Example.test ');
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('AuthService.forgotPassword: an admitted request goes on to the account lookup (unknown address: nothing sent, same 204)', async () => {
    const dataSource = { query: jest.fn(async () => []) };
    const limiter = { admit: jest.fn(async () => undefined) };
    const args: unknown[] = new Array(20).fill(undefined);
    args[0] = dataSource;
    const auth = new (AuthService as unknown as new (...a: unknown[]) => AuthService)(...args, limiter);
    await expect(auth.forgotPassword({ email: 'nobody@example.test' })).resolves.toBeUndefined();
    expect(limiter.admit.mock.invocationCallOrder[0]).toBeLessThan(dataSource.query.mock.invocationCallOrder[0]!);
  });
});
