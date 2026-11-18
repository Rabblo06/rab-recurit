import { alertOnMajorMismatch } from './workspace-provisioning.loops';

/**
 * Security review I4 (PR #227): a PostgreSQL major mismatch in the drift / provisioning loop is an explicit ALERT error line
 * and still a failed cycle (rethrown, so the runtime counts it in the loop's failures stat). Any other error is rethrown
 * unchanged, with no ALERT line (the runtime's own "cycle failed" log covers it).
 */
const mismatch = () => Object.assign(new Error('PostgreSQL 19 is not supported; use 16-18 (PostgreSQL 16, 17 or 18).'), { name: 'UnsupportedPostgresVersionError' });

describe('alertOnMajorMismatch (workspace drift / provisioning loops)', () => {
  it('a major mismatch logs one ALERT error naming the cause, then rethrows the same error (the cycle counts as failed)', async () => {
    const lines: string[] = [];
    const err = mismatch();
    await expect(alertOnMajorMismatch({ error: (l) => lines.push(l) }, 'workspace schema drift', async () => Promise.reject(err))).rejects.toBe(err);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ALERT workspace schema drift: PostgreSQL version mismatch — PostgreSQL 19 is not supported; use 16-18/);
    expect(lines[0]).toMatch(/Nothing was checked or built this cycle/);
  });

  it('any other error is rethrown with no ALERT line; a success passes its result through', async () => {
    const lines: string[] = [];
    const other = new Error('connection reset');
    await expect(alertOnMajorMismatch({ error: (l) => lines.push(l) }, 'workspace provisioning', async () => Promise.reject(other))).rejects.toBe(other);
    expect(lines).toEqual([]);
    await expect(alertOnMajorMismatch({ error: (l) => lines.push(l) }, 'workspace provisioning', async () => 42)).resolves.toBe(42);
    expect(lines).toEqual([]);
  });
});
