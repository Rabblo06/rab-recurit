import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * X6.2b: the Referrer-Policy of the static front. Two layers with the same value: the page's own
 * <meta name="referrer"> (holds on every host; the effective control today) and public/_headers (read by a Cloudflare
 * static-assets / Pages edge, when one serves the build). The value must never become no-referrer: under it a browser
 * sends `Origin: null` on a cross-origin form POST, e.g. the step-up re-authentication form (StepUpHost.tsx →
 * POST /auth/<provider>/reauthenticate), whose server-side Origin check refuses `null`.
 */
const FRONT_ROOT = join(__dirname, '..', '..', '..');
const POLICY = 'strict-origin-when-cross-origin';
const FORBIDDEN = ['no-referrer', 'same-origin', 'unsafe-url', 'no-referrer-when-downgrade'];

/** Every policy a <meta name="referrer"> in the HTML sets, in order. */
function metaPolicies(html: string): string[] {
  return [...html.matchAll(/<meta\s+name="referrer"\s+content="([^"]*)"\s*\/?>/gi)].map((m) => m[1]!.trim().toLowerCase());
}

/** Every Referrer-Policy value in a Cloudflare `_headers` file (comments ignored), with the path block it belongs to. */
function headerPolicies(text: string): Array<{ path: string; policy: string }> {
  const out: Array<{ path: string; policy: string }> = [];
  let path = '';
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      path = line.trim();
      continue;
    }
    const m = /^\s+Referrer-Policy:\s*(.+?)\s*$/i.exec(line);
    if (m) out.push({ path, policy: m[1]!.toLowerCase() });
  }
  return out;
}

const html = readFileSync(join(FRONT_ROOT, 'index.html'), 'utf8');
const headers = readFileSync(join(FRONT_ROOT, 'public', '_headers'), 'utf8');

describe('Referrer-Policy at the final edge (X6.2b)', () => {
  it('index.html sets the policy itself, exactly once, before any stylesheet or script', () => {
    expect(metaPolicies(html)).toEqual([POLICY]);
    const at = html.search(/<meta\s+name="referrer"/i);
    expect(at).toBeLessThan(html.indexOf('<link href="https://fonts.googleapis.com'));
    expect(at).toBeLessThan(html.indexOf('<script'));
  });

  it('public/_headers sends exactly that policy, for every path', () => {
    expect(headerPolicies(headers)).toEqual([{ path: '/*', policy: POLICY }]);
  });

  it.each(FORBIDDEN)('neither file uses %s', (bad) => {
    expect(metaPolicies(html)).not.toContain(bad);
    expect(headerPolicies(headers).map((h) => h.policy)).not.toContain(bad);
  });

  // The checks above must be able to fail: the parsers read a forbidden value when one is present.
  it.each(FORBIDDEN)('the parsers detect %s in a fixture (the negative checks are live)', (bad) => {
    expect(metaPolicies(`<head><meta name="referrer" content="${bad}" /></head>`)).toEqual([bad]);
    expect(headerPolicies(`# comment\n/*\n  Referrer-Policy: ${bad}\n`)).toEqual([{ path: '/*', policy: bad }]);
    expect(headerPolicies(`/*\n  Referrer-Policy:   ${bad}   \n`).map((h) => h.policy)).toContain(bad);
    expect(headerPolicies(`# Referrer-Policy: ${bad}\n/*\n  Referrer-Policy: ${POLICY}\n`)).toEqual([{ path: '/*', policy: POLICY }]);
  });
});
