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
});
