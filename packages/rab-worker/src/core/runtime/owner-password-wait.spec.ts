import {
  isOwnerPasswordMismatch,
  OWNER_PASSWORD_WAIT_EXPIRED_MESSAGE,
  OWNER_PASSWORD_WAIT_MAX_MS,
  OWNER_PASSWORD_WAIT_MESSAGE,
  retryWhileOwnerPasswordStale,
} from './owner-password-wait';

/** DB-SETUP §4: the Worker waits, bounded, for the API to reset crewflow_owner's password after an APP_SECRET rotation. */
class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

/** A fake clock, a fake process.exit (throws, like the real one never returns) and captured log lines. */
function harness() {
  let t = 0;
  const warn: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  return {
    deps: {
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
      log: (l: string) => void warn.push(l),
      logError: (l: string) => void errors.push(l),
      exit: (code: number): never => {
        exits.push(code);
        throw new ExitCalled(code);
      },
    },
    elapsed: () => t,
    warn,
    errors,
    exits,
  };
}
const mismatch = () => Object.assign(new Error('Cannot reach the primary database (driver code 28P01). Refusing to start.'), { driverCode: '28P01' });

describe('worker owner-password wait (28P01 after an APP_SECRET rotation)', () => {
  it('recognises 28P01 from the driver (code) and from the runtime guard (driverCode), nothing else', () => {
    expect(isOwnerPasswordMismatch(Object.assign(new Error('x'), { code: '28P01' }))).toBe(true);
    expect(isOwnerPasswordMismatch(mismatch())).toBe(true);
    for (const code of ['28000', '57P03', 'ECONNREFUSED', '3D000', undefined]) {
      expect(isOwnerPasswordMismatch(Object.assign(new Error('x'), { code, driverCode: code }))).toBe(false);
    }
    expect(isOwnerPasswordMismatch(null)).toBe(false);
  });

  it('a fake connector refusing 28P01 twice and then succeeding: the Worker continues, one fixed line per retry', async () => {
    const h = harness();
    let calls = 0;
    const result = await retryWhileOwnerPasswordStale(async () => {
      calls += 1;
      if (calls <= 2) throw mismatch();
      return 'connected';
    }, h.deps);
    expect(result).toBe('connected');
    expect(calls).toBe(3);
    expect(h.warn).toEqual([OWNER_PASSWORD_WAIT_MESSAGE, OWNER_PASSWORD_WAIT_MESSAGE]);
    expect(OWNER_PASSWORD_WAIT_MESSAGE).toBe(
      'crewflow_owner login refused (password not yet reset by the API after an APP_SECRET change?); retrying',
    );
    expect(h.exits).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(h.elapsed()).toBe(2_000 + 4_000);
  });

  it('DENIAL: 28P01 for longer than 120 s exits non-zero with the fixed message, after the whole budget and never later', async () => {
    const h = harness();
    let calls = 0;
    await expect(
      retryWhileOwnerPasswordStale(async () => {
        calls += 1;
        throw mismatch();
      }, h.deps),
    ).rejects.toBeInstanceOf(ExitCalled);
    expect(h.exits).toEqual([1]);
    expect(h.errors).toEqual([OWNER_PASSWORD_WAIT_EXPIRED_MESSAGE]);
    expect(OWNER_PASSWORD_WAIT_EXPIRED_MESSAGE).toMatch(/after 120 s/);
    expect(h.elapsed()).toBe(OWNER_PASSWORD_WAIT_MAX_MS);
    expect(calls).toBeGreaterThan(2);
    expect(h.warn.every((l) => l === OWNER_PASSWORD_WAIT_MESSAGE)).toBe(true);
  });

  it('DENIAL: any other error is rethrown at once, never retried, never exits from here', async () => {
    for (const other of [
      Object.assign(new Error('identity mismatch'), { code: '42501' }),
      Object.assign(new Error('no route'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('auth'), { driverCode: '28000' }),
    ]) {
      const h = harness();
      let calls = 0;
      await expect(
        retryWhileOwnerPasswordStale(async () => {
          calls += 1;
          throw other;
        }, h.deps),
      ).rejects.toBe(other);
      expect(calls).toBe(1);
      expect(h.elapsed()).toBe(0);
      expect(h.warn).toEqual([]);
      expect(h.exits).toEqual([]);
    }
  });

  it('a non-28P01 error after a 28P01 retry stops the wait at once (boot gates keep their own refusal)', async () => {
    const h = harness();
    const other = Object.assign(new Error('identity mismatch'), { code: '42501' });
    let calls = 0;
    await expect(
      retryWhileOwnerPasswordStale(async () => {
        calls += 1;
        throw calls === 1 ? mismatch() : other;
      }, h.deps),
    ).rejects.toBe(other);
    expect(calls).toBe(2);
    expect(h.exits).toEqual([]);
  });

  it('prints no value: neither the retry line nor the exit line carries the error text, URL or password', async () => {
    const h = harness();
    const leaky = Object.assign(new Error('postgres://crewflow_owner:secretvalue@db/x'), { code: '28P01' });
    await expect(
      retryWhileOwnerPasswordStale(async () => {
        throw leaky;
      }, h.deps),
    ).rejects.toBeInstanceOf(ExitCalled);
    expect([...h.warn, ...h.errors].join('\n')).not.toMatch(/secretvalue|postgres:\/\//);
  });
});
