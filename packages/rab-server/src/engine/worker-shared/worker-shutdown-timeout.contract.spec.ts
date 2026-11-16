import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  parseWorkerShutdownTimeoutMs,
  WORKER_SHUTDOWN_HARD_EXIT_MARGIN_MS,
  WORKER_SHUTDOWN_TIMEOUT_MS_DEFAULT,
  WORKER_SHUTDOWN_TIMEOUT_MS_MAX,
  WORKER_SHUTDOWN_TIMEOUT_MS_MIN,
  WORKER_STOP_GRACE_PERIOD_MS,
  WorkerShutdownTimeoutError,
} from './worker-shutdown-timeout.contract';

/**
 * XR-10: WORKER_SHUTDOWN_TIMEOUT_MS is validated (it used to be `Number(process.env…)` at shutdown: garbage → NaN → the
 * hard-exit timer fired at once and the Worker skipped its drain; > 35 000 → SIGKILLed mid-drain by the 45 s grace).
 */
describe('WORKER_SHUTDOWN_TIMEOUT_MS (XR-10)', () => {
  it('keeps the default unchanged: unset or empty → 30 000 ms', () => {
    expect(WORKER_SHUTDOWN_TIMEOUT_MS_DEFAULT).toBe(30_000);
    expect(parseWorkerShutdownTimeoutMs(undefined)).toBe(30_000);
    expect(parseWorkerShutdownTimeoutMs('')).toBe(30_000);
  });

  it('accepts a plain integer from 1 000 to 34 000 ms, both bounds included', () => {
    expect([WORKER_SHUTDOWN_TIMEOUT_MS_MIN, WORKER_SHUTDOWN_TIMEOUT_MS_MAX]).toEqual([1_000, 34_000]);
    for (const [raw, ms] of [['1000', 1_000], ['15000', 15_000], ['30000', 30_000], ['34000', 34_000]] as const) {
      expect(parseWorkerShutdownTimeoutMs(raw)).toBe(ms);
    }
  });

  it.each(['0', '1', '999', '34001', '35000', '45000', '600000', '9999999'])('refuses the out-of-range value %s', (raw) => {
    expect(() => parseWorkerShutdownTimeoutMs(raw)).toThrow(WorkerShutdownTimeoutError);
    expect(() => parseWorkerShutdownTimeoutMs(raw)).toThrow(/from 1000 to 34000/);
  });

  it.each(['abc', 'NaN', '30s', ' 30000', '30000 ', '3e4', '-1000', '+30000', '030000', '30000.0', '30_000', '0x7530'])(
    'refuses the malformed value %p (never NaN, never a silent default)',
    (raw) => {
      expect(() => parseWorkerShutdownTimeoutMs(raw)).toThrow(WorkerShutdownTimeoutError);
    },
  );

  it('never echoes the raw value in the refusal', () => {
    expect(() => parseWorkerShutdownTimeoutMs('secret-looking-value')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-looking-value') }),
    );
  });

  it('the largest drain plus the hard-exit margin ends before the 45 s stop grace period', () => {
    expect(WORKER_SHUTDOWN_TIMEOUT_MS_MAX + WORKER_SHUTDOWN_HARD_EXIT_MARGIN_MS).toBeLessThan(WORKER_STOP_GRACE_PERIOD_MS);
  });

  it('every committed Worker service keeps a stop_grace_period of at least that 45 s', () => {
    const dockerDir = resolve(__dirname, '../../../../rab-docker');
    const files: Array<[string, string]> = [
      ['docker-compose.production.yml', 'rab-worker'],
      ['docker-compose.image.yml', 'rab-worker'],
      ['docker-compose.local-build.yml', 'rab-worker'],
      ['docker-compose.yml', 'worker'],
      ['docker-compose.qa.yml', 'worker'],
    ];
    for (const [file, service] of files) {
      const lines = readFileSync(join(dockerDir, file), 'utf8').split(/\r?\n/);
      const start = lines.findIndex((line) => line === `  ${service}:`);
      expect({ file, service, found: start >= 0 }).toEqual({ file, service, found: true });
      const end = lines.findIndex((line, i) => i > start && /^ {0,2}\S/.test(line));
      const block = lines.slice(start + 1, end < 0 ? undefined : end);
      const grace = block.map((line) => /^\s+stop_grace_period:\s*(\d+)s\s*$/.exec(line)).find(Boolean);
      expect({ file, service, graceMs: grace ? Number(grace[1]) * 1000 : null }).toEqual({
        file,
        service,
        graceMs: expect.any(Number),
      });
      expect(Number(grace![1]) * 1000).toBeGreaterThanOrEqual(WORKER_STOP_GRACE_PERIOD_MS);
    }
  });
});
