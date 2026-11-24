import { validate } from './env.validation';

/**
 * The native PDF renderer's settings. PDF_RENDERER itself is deleted (Phase X X5.4, as owner decision D10 planned for the
 * release after P5): native is the only renderer, so the schema has nothing to validate for it; the Worker warns at boot
 * if it is still set (rab-worker render-pdf-switch.spec.ts).
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('native PDF renderer environment variables', () => {
  it('PDF_RENDERER is no longer a setting: no default is filled in, and a leftover value is not validated', () => {
    expect(validate({ ...base })).not.toHaveProperty('PDF_RENDERER');
    expect(() => validate({ ...base, PDF_RENDERER: 'native' })).not.toThrow();
    expect(() => validate({ ...base, PDF_RENDERER: 'chromium' })).not.toThrow();
  });

  describe('PDF_NATIVE_CONCURRENCY', () => {
    it('is optional (the render pool then uses 2); an empty value is unset, as for every variable (env.validation.ts)', () => {
      expect(validate({ ...base }).PDF_NATIVE_CONCURRENCY).toBeUndefined();
      expect(validate({ ...base, PDF_NATIVE_CONCURRENCY: '' }).PDF_NATIVE_CONCURRENCY).toBeUndefined();
    });

    it.each(['1', '2'])('accepts %p within the default memory budget', (value) => {
      expect(validate({ ...base, PDF_NATIVE_CONCURRENCY: value }).PDF_NATIVE_CONCURRENCY).toBe(value);
    });

    it.each(['3', '4'])('accepts %p only with a memory budget raised to fit it', (value) => {
      const budget = String(Number(value) * 384);
      expect(validate({ ...base, PDF_NATIVE_CONCURRENCY: value, PDF_NATIVE_MEMORY_BUDGET_MB: budget }).PDF_NATIVE_CONCURRENCY).toBe(value);
    });

    it.each([' ', '0', '5', '2.0', ' 2', 'two', '-1'])('refuses to boot with PDF_NATIVE_CONCURRENCY=%p', (value) => {
      expect(() => validate({ ...base, PDF_NATIVE_CONCURRENCY: value })).toThrow(/PDF_NATIVE_CONCURRENCY must be an integer from 1 to 4/);
    });
  });

  describe('PDF_NATIVE_PREWARM', () => {
    it('is optional; an empty value is unset', () => {
      expect(validate({ ...base }).PDF_NATIVE_PREWARM).toBeUndefined();
      expect(validate({ ...base, PDF_NATIVE_PREWARM: '' }).PDF_NATIVE_PREWARM).toBeUndefined();
    });

    it.each(['0', '1', '2', '3', '4'])('accepts %p', (value) => {
      expect(validate({ ...base, PDF_NATIVE_PREWARM: value }).PDF_NATIVE_PREWARM).toBe(value);
    });

    it.each([' ', '5', '-1', '1.0', 'two'])('refuses to boot with PDF_NATIVE_PREWARM=%p', (value) => {
      expect(() => validate({ ...base, PDF_NATIVE_PREWARM: value })).toThrow(/PDF_NATIVE_PREWARM must be an integer from 0 to 4/);
    });
  });

  // Review M-3: concurrency × the 384 MB per-thread heap cap must fit PDF_NATIVE_MEMORY_BUDGET_MB (default 768 = half of
  // the Worker's default 1536m mem_limit), so concurrent oversized renders kill their own thread, never the container.
  describe('PDF_NATIVE_MEMORY_BUDGET_MB (render memory bounded by the Worker container)', () => {
    it('is optional (768 MB); an empty value is unset; the default pool (2 × 384 MB) fits it exactly', () => {
      expect(validate({ ...base }).PDF_NATIVE_MEMORY_BUDGET_MB).toBeUndefined();
      expect(validate({ ...base, PDF_NATIVE_MEMORY_BUDGET_MB: '' }).PDF_NATIVE_MEMORY_BUDGET_MB).toBeUndefined();
      expect(() => validate({ ...base, PDF_NATIVE_CONCURRENCY: '2' })).not.toThrow();
      expect(() => validate({ ...base, PDF_NATIVE_CONCURRENCY: '2', PDF_NATIVE_MEMORY_BUDGET_MB: '768' })).not.toThrow();
    });

    it.each([
      ['3', undefined, 1152, 768],
      ['4', undefined, 1536, 768],
      ['2', '512', 768, 512],
      ['4', '1500', 1536, 1500],
      [undefined, '400', 768, 400],
    ])('refuses to boot: PDF_NATIVE_CONCURRENCY=%p with budget %p (%p MB needed > %p MB), naming the numbers and the remedy', (concurrency, budget, needed, limit) => {
      const env: Record<string, string> = { ...base };
      if (concurrency !== undefined) env.PDF_NATIVE_CONCURRENCY = concurrency;
      if (budget !== undefined) env.PDF_NATIVE_MEMORY_BUDGET_MB = budget;
      expect(() => validate(env)).toThrow(`= ${needed} MB exceeds PDF_NATIVE_MEMORY_BUDGET_MB=${limit}`);
      expect(() => validate(env)).toThrow(/CREWFLOW_WORKER_MEM_LIMIT/);
    });

    it('is checked with only the concurrency set (native is the only renderer on this tree)', () => {
      expect(() => validate({ ...base, PDF_NATIVE_CONCURRENCY: '4' })).toThrow(/exceeds PDF_NATIVE_MEMORY_BUDGET_MB=768/);
    });

    it.each(['384', '768', '1536', '16384'])('accepts budget %p', (value) => {
      expect(validate({ ...base, PDF_NATIVE_CONCURRENCY: '1', PDF_NATIVE_MEMORY_BUDGET_MB: value }).PDF_NATIVE_MEMORY_BUDGET_MB).toBe(value);
    });

    it.each([' ', '0', '383', '16385', '0768', '768.0', ' 768', '768 ', '-768', '1e3', '768MB', 'big'])('refuses to boot with PDF_NATIVE_MEMORY_BUDGET_MB=%p', (value) => {
      expect(() => validate({ ...base, PDF_NATIVE_CONCURRENCY: '1', PDF_NATIVE_MEMORY_BUDGET_MB: value })).toThrow(
        /PDF_NATIVE_MEMORY_BUDGET_MB must be an integer number of MB from 384 to 16384/,
      );
    });
  });
});
