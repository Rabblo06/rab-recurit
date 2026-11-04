import { validate } from '@rab/server/engine/core-modules/environment/env.validation';

import { pdfNativeConcurrency, pdfNativeMemoryPlan, pdfNativePrewarm } from './render-pool';

/**
 * The render pool reads PDF_NATIVE_CONCURRENCY / PDF_NATIVE_PREWARM from process.env at use, AFTER the Worker's boot
 * validation (env.validation.ts) has accepted the environment. The two must agree on every value: boot validation treats
 * an empty value (`KEY=` in a .env file) as unset for every variable, so the parsers must too, or a Worker that booted
 * cleanly would fail its first native render. For every non-empty value both stay strict (fail closed).
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

const accepts = (fn: () => unknown): boolean => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

const VALUES = ['', ' ', '0', '1', '2', '3', '4', '5', '02', '2.0', ' 2', '2 ', '-1', 'two'];

describe('native pool configuration agrees with boot validation', () => {
  // The process-wide pool is created from pdfNativeMemoryPlan (size AND the M-3 memory budget), so that is what must agree
  // with boot: "3" / "4" refuse in both under the default 768 MB budget, and are accepted by both with a budget that fits.
  it.each(VALUES)('PDF_NATIVE_CONCURRENCY=%p: boot and pool accept or refuse it alike', (value) => {
    const env = { ...base, PDF_NATIVE_CONCURRENCY: value };
    expect(accepts(() => pdfNativeMemoryPlan(env))).toBe(accepts(() => validate(env)));
    const roomy = { ...env, PDF_NATIVE_MEMORY_BUDGET_MB: '1536' };
    expect(accepts(() => pdfNativeMemoryPlan(roomy))).toBe(accepts(() => validate(roomy)));
    expect(accepts(() => pdfNativeConcurrency(env))).toBe(accepts(() => validate(roomy)));
  });

  it.each(['', ' ', '0', '383', '384', '767', '768', '1536', '16384', '16385', '0768', '768.0', ' 768', '-768', '1e3', 'big'])(
    'PDF_NATIVE_MEMORY_BUDGET_MB=%p (with the default pool of 2): boot and pool accept or refuse it alike',
    (value) => {
      const env = { ...base, PDF_NATIVE_MEMORY_BUDGET_MB: value };
      expect(accepts(() => pdfNativeMemoryPlan(env))).toBe(accepts(() => validate(env)));
    },
  );

  // PDF_NATIVE_CONCURRENCY unset → pool size 2; the pool additionally refuses a pre-warm larger than its size ("3", "4"),
  // which boot validation cannot see on its own: stricter at use, never looser.
  it.each(VALUES.filter((v) => v !== '3' && v !== '4'))('PDF_NATIVE_PREWARM=%p: boot and pool accept or refuse it alike', (value) => {
    const env = { ...base, PDF_NATIVE_PREWARM: value };
    expect(accepts(() => pdfNativePrewarm(env))).toBe(accepts(() => validate(env)));
  });

  it('empty means the default, not an error', () => {
    expect(pdfNativeConcurrency({ PDF_NATIVE_CONCURRENCY: '' })).toBe(2);
    expect(pdfNativePrewarm({ PDF_NATIVE_PREWARM: '', PDF_NATIVE_CONCURRENCY: '' })).toBe(2);
  });
});
