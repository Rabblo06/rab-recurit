import { isOwnerPasswordMismatch, OWNER_PASSWORD_WAIT_MAX_MS, OWNER_PASSWORD_WAIT_MESSAGE, retryWhileOwnerPasswordStale } from './owner-password-wait';

/** DB-SETUP §4: the Worker waits, bounded, for the API to reset crewflow_owner's password after an APP_SECRET rotation. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), elapsed: () => t };
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

  it('retries a 28P01 with a fixed message and succeeds once the password matches', async () => {
    const c = clock();
    const lines: string[] = [];
    let calls = 0;
    const result = await retryWhileOwnerPasswordStale(
      async () => {
        calls += 1;
        if (calls < 3) throw mismatch();
        return 'connected';
      },
      { now: c.now, sleep: c.sleep, log: (l) => lines.push(l) },
    );
    expect(result).toBe('connected');
    expect(calls).toBe(3);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.startsWith(OWNER_PASSWORD_WAIT_MESSAGE))).toBe(true);
    expect(c.elapsed()).toBe(2_000 + 4_000);
  });

  it('DENIAL: gives up (rethrows the 28P01) once the next wait would pass 120 s', async () => {
    const c = clock();
    const err = mismatch();
    await expect(retryWhileOwnerPasswordStale(async () => { throw err; }, { now: c.now, sleep: c.sleep, log: () => undefined })).rejects.toBe(err);
    expect(c.elapsed()).toBeLessThanOrEqual(OWNER_PASSWORD_WAIT_MAX_MS);
    expect(c.elapsed()).toBeGreaterThan(OWNER_PASSWORD_WAIT_MAX_MS - 15_000 - 1);
  });

  it('DENIAL: any other error is rethrown at once, never retried', async () => {
    const c = clock();
    const other = Object.assign(new Error('identity mismatch'), { code: '42501' });
    let calls = 0;
    await expect(retryWhileOwnerPasswordStale(async () => { calls += 1; throw other; }, { now: c.now, sleep: c.sleep, log: () => undefined })).rejects.toBe(other);
    expect(calls).toBe(1);
    expect(c.elapsed()).toBe(0);
  });

  it('prints no value: the message is fixed text plus the timing', async () => {
    const c = clock();
    const lines: string[] = [];
    let calls = 0;
    await retryWhileOwnerPasswordStale(async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('postgres://crewflow_owner:secretvalue@db/x'), { code: '28P01' }); return 1; }, { now: c.now, sleep: c.sleep, log: (l) => lines.push(l) });
    expect(lines.join('\n')).not.toMatch(/secretvalue|postgres:\/\//);
  });
});
