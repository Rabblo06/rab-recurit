import { validate } from './env.validation';

/**
 * PDF renderer P5 (D10): PDF_RENDERER is kept for one release and accepts only "native" (unset or empty = native).
 * "chromium" refuses to boot: the Worker has no browser, so it can never be a silent choice.
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('PDF_RENDERER environment variable', () => {
  it('defaults to native', () => {
    expect(validate({ ...base }).PDF_RENDERER).toBe('native');
  });

  it('treats an empty value as unset (native)', () => {
    expect(validate({ ...base, PDF_RENDERER: '' }).PDF_RENDERER ?? 'native').toBe('native');
  });

  it('accepts exactly native', () => {
    expect(validate({ ...base, PDF_RENDERER: 'native' }).PDF_RENDERER).toBe('native');
  });

  it.each(['chromium', 'CHROMIUM', 'Native', ' native', 'native ', ' ', 'chrome', 'pdfkit', 'true', '1'])('refuses to boot with PDF_RENDERER=%p', (value) => {
    expect(() => validate({ ...base, PDF_RENDERER: value })).toThrow(/PDF_RENDERER must be exactly native/);
  });

  describe('PDF_NATIVE_CONCURRENCY', () => {
    it('is optional (the render pool then uses 2); an empty value is unset, as for every variable (env.validation.ts)', () => {
      expect(validate({ ...base }).PDF_NATIVE_CONCURRENCY).toBeUndefined();
      expect(validate({ ...base, PDF_NATIVE_CONCURRENCY: '' }).PDF_NATIVE_CONCURRENCY).toBeUndefined();
    });

    it.each(['1', '2', '3', '4'])('accepts %p', (value) => {
      expect(validate({ ...base, PDF_NATIVE_CONCURRENCY: value }).PDF_NATIVE_CONCURRENCY).toBe(value);
    });

    it.each([' ', '0', '5', '2.0', ' 2', 'two', '-1'])('refuses to boot with PDF_NATIVE_CONCURRENCY=%p', (value) => {
      expect(() => validate({ ...base, PDF_NATIVE_CONCURRENCY: value })).toThrow(/PDF_NATIVE_CONCURRENCY must be an integer from 1 to 4/);
    });
  });
});
