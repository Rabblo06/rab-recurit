import { HttpException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { argon2Parameters } from '../../../../__tests__/helpers/argon2-parameters';
import { AuthService } from './auth.service';
import { LoginAttemptLimiterService } from './login-attempt-limiter.service';
import { PasswordHashingService } from './password-hashing.service';

/**
 * XA-10 (Phase X2, X6.3b): the timing-uniformity rule in CLAUDE.md. "Login responses are timing- and message-uniform for
 * wrong-email vs wrong-password: run the hash even when the account doesn't exist." These tests drive the REAL
 * AuthService.login with the REAL PasswordHashingService and assert:
 *   - an unknown address still runs exactly one argon2 verify, against a dummy hash that is itself argon2id at the
 *     CLAUDE.md floor (m >= 19456, t >= 2, p = 1), so it costs what a real account's verify costs;
 *   - login() WAITS for that verify: every verify is gated behind a deferred the test controls, and the refusal must not
 *     settle while the gate is open (a fire-and-forget `void verify(...)` would answer before the hash work finishes,
 *     which is exactly the timing signal the rule forbids);
 *   - a known address with a wrong password runs exactly one verify too, and both answers are byte-identical;
 *   - a pending (INVITED, no password) candidate also pays one awaited dummy verify;
 *   - the dummy hash is computed once per process and reused (no per-request hash() on the unknown-address path).
 * Once the gate opens the real argon2 verify runs. Every collaborator other than the database query, the limiter and the
 * hashing service is an empty mock: none of them is reached on these refusal paths, and a call into one fails the test.
 */
const PASSWORD = 'dummy hash spec passphrase';
const META = { ip: '203.0.113.7', userAgent: 'jest' };

type Row = Record<string, unknown>;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

async function harness(candidatesFor: (email: string) => Row[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('core.auth_find_users_by_email')) return candidatesFor(String(params[0]));
      return [];
    }),
  };
  const limiter = { admit: jest.fn(async () => undefined), recordSuccess: jest.fn(async () => undefined) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      PasswordHashingService,
      { provide: DataSource, useValue: dataSource },
      { provide: LoginAttemptLimiterService, useValue: limiter },
    ],
  })
    .useMocker(() => ({}))
    .compile();
  const auth = moduleRef.get(AuthService);
  const hashing = moduleRef.get(PasswordHashingService);
  const realVerify = hashing.verify.bind(hashing);
  // hash() calls through: the dummy hash is a real argon2id hash.
  const hash = jest.spyOn(hashing, 'hash');
  // verify() is held behind a gate the test opens; once open, the real argon2 verify runs.
  let open: () => void = () => undefined;
  let gate = new Promise<void>((resolve) => (open = resolve));
  const verify = jest
    .spyOn(hashing, 'verify')
    .mockImplementation((encoded: string, password: string) => gate.then(() => realVerify(encoded, password)));
  const regate = () => {
    gate = new Promise<void>((resolve) => (open = resolve));
  };
  return { auth, hash, verify, queries, limiter, release: () => open(), regate };
}

type H = Awaited<ReturnType<typeof harness>>;

/**
 * Starts a login, proves it is still pending while its verify is held (so the verify is awaited, not fired and
 * forgotten), then opens the gate and returns the refusal.
 */
async function refusalAfterVerify(h: H, run: () => Promise<unknown>): Promise<HttpException> {
  const verifiesBefore = h.verify.mock.calls.length;
  let settled = false;
  const pending = run();
  const tracked = pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  // Wait (bounded) until this login reaches its verify; the real dummy hash() may run first.
  for (let i = 0; i < 2000 && h.verify.mock.calls.length === verifiesBefore && !settled; i += 1) await tick();
  expect(h.verify).toHaveBeenCalledTimes(verifiesBefore + 1);
  // Gate still closed: give anything that does not wait for the verify every chance to finish first.
  for (let i = 0; i < 20; i += 1) await tick();
  expect(settled).toBe(false);
  h.release();
  await tracked;
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(UnauthorizedException);
    return error as HttpException;
  }
  throw new Error('login unexpectedly succeeded');
}

function expectAtFloor(encoded: string) {
  const params = argon2Parameters(encoded);
  expect(params.variant).toBe('argon2id');
  expect(params.memoryKiB).toBeGreaterThanOrEqual(19456);
  expect(params.iterations).toBeGreaterThanOrEqual(2);
  expect(params.parallelism).toBe(1);
}

describe('AuthService.login: the dummy hash runs for an unknown account (XA-10, CLAUDE.md timing uniformity)', () => {
  it('an unknown address waits for exactly one argon2 verify, against a dummy argon2id hash at the CLAUDE.md floor', async () => {
    const h = await harness(() => []);
    const error = await refusalAfterVerify(h, () => h.auth.login({ email: 'nobody@example.test', password: PASSWORD }, META));

    expect(error.message).toBe('Invalid email or password.');
    expect(h.verify).toHaveBeenCalledTimes(1);
    const [dummyHash, submitted] = h.verify.mock.calls[0];
    expect(submitted).toBe(PASSWORD);
    expectAtFloor(dummyHash);
    // The real verify ran once the gate opened and, against a random secret, said no.
    await expect(h.verify.mock.results[0].value).resolves.toBe(false);
    // The dummy is a hash of a random secret, never of anything the caller sent.
    expect(h.hash).toHaveBeenCalledTimes(1);
    expect(h.hash.mock.calls[0][0]).not.toBe(PASSWORD);
    expect(h.hash.mock.calls[0][0]).toMatch(/^[0-9a-f]{64}$/);
    // The limiter ran first and the failure was recorded, exactly as for a real address.
    expect(h.limiter.admit).toHaveBeenCalledWith('nobody@example.test', META.ip);
    expect(h.queries.some((q) => q.sql.includes('INSERT INTO core.login_history'))).toBe(true);
  });

  it('the dummy hash is computed once and reused: later unknown-address logins run verify only, no hash()', async () => {
    const h = await harness(() => []);
    await refusalAfterVerify(h, () => h.auth.login({ email: 'nobody-1@example.test', password: PASSWORD }, META));
    h.regate();
    await refusalAfterVerify(h, () => h.auth.login({ email: 'nobody-2@example.test', password: 'another passphrase' }, META));
    expect(h.hash).toHaveBeenCalledTimes(1);
    expect(h.verify).toHaveBeenCalledTimes(2);
    expect(h.verify.mock.calls[0][0]).toBe(h.verify.mock.calls[1][0]);
  });

  it('a wrong email and a wrong password give the same work (one awaited verify at the same cost) and an identical answer', async () => {
    const realHash = await new PasswordHashingService().hash('the real password of this account');
    const known = (email: string): Row[] =>
      email === 'ada@example.test'
        ? [{ id: 'u-1', organisationId: 'org-1', email, passwordHash: realHash, status: 'ACTIVE', mustResetPassword: false, firstName: 'Ada' }]
        : [];

    const unknown = await harness(known);
    const unknownError = await refusalAfterVerify(unknown, () => unknown.auth.login({ email: 'nobody@example.test', password: PASSWORD }, META));
    const wrong = await harness(known);
    const wrongError = await refusalAfterVerify(wrong, () => wrong.auth.login({ email: 'ada@example.test', password: PASSWORD }, META));

    expect(unknown.verify).toHaveBeenCalledTimes(1);
    expect(wrong.verify).toHaveBeenCalledTimes(1);
    expect(wrong.verify.mock.calls[0][0]).toBe(realHash);
    // Same algorithm and the same cost parameters on both paths: the dummy verify is not cheaper than the real one.
    const dummy = argon2Parameters(unknown.verify.mock.calls[0][0]);
    const real = argon2Parameters(realHash);
    expect({ v: dummy.variant, m: dummy.memoryKiB, t: dummy.iterations, p: dummy.parallelism }).toEqual({
      v: real.variant,
      m: real.memoryKiB,
      t: real.iterations,
      p: real.parallelism,
    });
    expect(unknownError.getStatus()).toBe(wrongError.getStatus());
    expect(unknownError.getResponse()).toEqual(wrongError.getResponse());
  });

  it('a pending (INVITED, no password yet) candidate also waits for one dummy verify and gets the same answer', async () => {
    const h = await harness((email) => [
      { id: 'u-2', organisationId: 'org-1', email, passwordHash: null, status: 'INVITED', mustResetPassword: false, firstName: 'Pat' },
    ]);
    const error = await refusalAfterVerify(h, () => h.auth.login({ email: 'pat@example.test', password: PASSWORD }, META));
    expect(error.message).toBe('Invalid email or password.');
    expect(h.verify).toHaveBeenCalledTimes(1);
    expectAtFloor(h.verify.mock.calls[0][0]);
  });
});
