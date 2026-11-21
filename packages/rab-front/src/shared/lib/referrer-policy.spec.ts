import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * X6.2b: the Referrer-Policy of the static front holds at the final edge, whatever serves it. Two layers: the page's own
 * <meta name="referrer"> (every host, including a same-origin proxy) and public/_headers (Cloudflare static assets /
 * Pages). The value must never become no-referrer or same-origin: both make a browser send `Origin: null` on a non-CORS
 * POST (the invitation SSO form POST, a same-origin /rest proxy), which the API's Origin-only CSRF check refuses.
 */
const FRONT_ROOT = join(__dirname, '..', '..', '..');
const POLICY = 'strict-origin-when-cross-origin';

describe('Referrer-Policy at the final edge (X6.2b)', () => {
  it('index.html sets the policy itself, exactly once, before any script or stylesheet', () => {
    const html = readFileSync(join(FRONT_ROOT, 'index.html'), 'utf8');
    const metas = html.match(/<meta\s+name="referrer"[^>]*>/g) ?? [];
    expect(metas).toEqual([`<meta name="referrer" content="${POLICY}" />`]);
    const at = html.indexOf(metas[0]!);
    expect(at).toBeLessThan(
      html.indexOf('<link href="https://fonts.googleapis.com'),
    );
    expect(at).toBeLessThan(html.indexOf('<script'));
  });

  it('public/_headers sends the same policy for every path', () => {
    const lines = readFileSync(join(FRONT_ROOT, 'public', '_headers'), 'utf8')
      .split('\n')
      .filter(
        (line) => line.trim() !== '' && !line.trimStart().startsWith('#'),
      );
    expect(lines[0]).toBe('/*');
    expect(lines.filter((line) => /^\s+Referrer-Policy:/i.test(line))).toEqual([
      `  Referrer-Policy: ${POLICY}`,
    ]);
  });

  it.each([
    'no-referrer',
    'same-origin',
    'unsafe-url',
    'no-referrer-when-downgrade',
  ])(
    'never uses %s (Origin: null on a non-CORS POST, or a full-URL leak)',
    (bad) => {
      const html = readFileSync(join(FRONT_ROOT, 'index.html'), 'utf8');
      const headers = readFileSync(
        join(FRONT_ROOT, 'public', '_headers'),
        'utf8',
      )
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .join('\n');
      expect(html).not.toContain(`content="${bad}"`);
      expect(headers).not.toMatch(
        new RegExp(`Referrer-Policy:\s*${bad}\s*$`, 'im'),
      );
    },
  );
});
