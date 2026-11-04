import { validate } from './env.validation';

/**
 * PDF renderer P1: PDF_RENDERER fails closed at boot. Unset or empty → chromium (the default); exactly "chromium" or
 * "native" otherwise; any other value — a different case, surrounding spaces, another word — refuses to boot.
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('PDF_RENDERER environment variable', () => {
  it('defaults to chromium', () => {
    expect(validate({ ...base }).PDF_RENDERER).toBe('chromium');
  });

  it('treats an empty value as unset (the runtime parser then uses chromium)', () => {
    expect(validate({ ...base, PDF_RENDERER: '' }).PDF_RENDERER ?? 'chromium').toBe('chromium');
  });

  it.each(['chromium', 'native'])('accepts %p', (value) => {
    expect(validate({ ...base, PDF_RENDERER: value }).PDF_RENDERER).toBe(value);
  });

  it.each(['Native', 'CHROMIUM', ' native', 'native ', ' ', 'chrome', 'pdfkit', 'true', '1'])('refuses to boot with PDF_RENDERER=%p', (value) => {
    expect(() => validate({ ...base, PDF_RENDERER: value })).toThrow(/PDF_RENDERER must be exactly chromium or native/);
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
});
