import { buildWorkspaceOrigin, classifyWorkspaceHost, isReservedSubdomainLabel, parseHostAuthority } from './hostname';

describe('parseHostAuthority (strict)', () => {
  it.each([
    ['acme.example.com', { hostname: 'acme.example.com', port: null }],
    ['ACME.Example.COM', { hostname: 'acme.example.com', port: null }],
    ['acme.localhost:5173', { hostname: 'acme.localhost', port: '5173' }],
    ['localhost', { hostname: 'localhost', port: null }],
  ])('accepts %s', (raw, expected) => {
    expect(parseHostAuthority(raw)).toEqual(expected);
  });

  it.each([
    '',
    ' ',
    'acme.example.com.',
    'acme..example.com',
    '.example.com',
    'acme.example.com:',
    'acme.example.com:0',
    'acme.example.com:080',
    'acme.example.com:65536',
    'acme.example.com:443:443',
    '[::1]:3000',
    'user@acme.example.com',
    'acme.example.com/path',
    'acme.example.com, evil.example',
    'acme.example.com evil',
    'ácme.example.com',
    'acme%2eexample.com',
    '-acme.example.com',
    'acme-.example.com',
    `${'a'.repeat(64)}.example.com`,
  ])('rejects %p', (raw) => {
    expect(parseHostAuthority(raw)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseHostAuthority(undefined)).toBeNull();
    expect(parseHostAuthority(null)).toBeNull();
  });
});

describe('isReservedSubdomainLabel', () => {
  it('reserves the fixed list and the punycode / api- / www- prefixes', () => {
    for (const label of ['api', 'admin', 'www', 'accounts', 'mail', 'xn--pple-43d', 'ab--cd', 'api-eu', 'www-old', 'crewflow-support']) {
      expect(isReservedSubdomainLabel(label)).toBe(true);
    }
    for (const label of ['acme', 'manager-a', 'apix', 'my-api']) {
      expect(isReservedSubdomainLabel(label)).toBe(false);
    }
  });
});

describe('classifyWorkspaceHost', () => {
  const base = 'workspaces.example.com';
  const parse = (raw: string) => parseHostAuthority(raw)!;

  it('classifies a single label under the base', () => {
    expect(classifyWorkspaceHost(parse('acme.workspaces.example.com'), base)).toEqual({ kind: 'label', label: 'acme', reserved: false });
    expect(classifyWorkspaceHost(parse('api.workspaces.example.com'), base)).toEqual({ kind: 'label', label: 'api', reserved: true });
  });

  it('treats the apex, nested labels, bad shapes and other ports correctly', () => {
    expect(classifyWorkspaceHost(parse('workspaces.example.com'), base)).toEqual({ kind: 'apex' });
    expect(classifyWorkspaceHost(parse('a.acme.workspaces.example.com'), base)).toEqual({ kind: 'invalid' });
    expect(classifyWorkspaceHost(parse('ab.workspaces.example.com'), base)).toEqual({ kind: 'invalid' });
    expect(classifyWorkspaceHost(parse('acme.workspaces.example.com:8443'), base)).toEqual({ kind: 'invalid' });
    // The base hostname on another port is another service (e.g. the API next to the dev front), not a workspace attempt.
    expect(classifyWorkspaceHost(parse('workspaces.example.com:8443'), base)).toEqual({ kind: 'outside' });
    expect(classifyWorkspaceHost(parse('localhost:3000'), 'localhost:5173')).toEqual({ kind: 'outside' });
  });

  it('does not match look-alike suffixes or foreign hosts', () => {
    expect(classifyWorkspaceHost(parse('acme.workspaces.example.com.evil.test'), base)).toEqual({ kind: 'outside' });
    expect(classifyWorkspaceHost(parse('acmeworkspaces.example.com'), base)).toEqual({ kind: 'outside' });
    expect(classifyWorkspaceHost(parse('api.example.com'), base)).toEqual({ kind: 'outside' });
  });

  it('requires the exact port of a dev base domain', () => {
    expect(classifyWorkspaceHost(parse('acme.localhost:5173'), 'localhost:5173')).toEqual({ kind: 'label', label: 'acme', reserved: false });
    expect(classifyWorkspaceHost(parse('acme.localhost'), 'localhost:5173')).toEqual({ kind: 'invalid' });
    expect(classifyWorkspaceHost(parse('acme.localhost:5174'), 'localhost:5173')).toEqual({ kind: 'invalid' });
  });

  it('fails closed when the base domain is unset or malformed', () => {
    expect(classifyWorkspaceHost(parse('acme.example.com'), undefined)).toEqual({ kind: 'outside' });
    expect(classifyWorkspaceHost(parse('acme.example.com'), 'https://example.com')).toEqual({ kind: 'outside' });
  });
});

describe('buildWorkspaceOrigin', () => {
  it('builds the canonical origin and refuses reserved or malformed input', () => {
    expect(buildWorkspaceOrigin('https', 'acme', 'workspaces.example.com')).toBe('https://acme.workspaces.example.com');
    expect(buildWorkspaceOrigin('http', 'acme', 'localhost:5173')).toBe('http://acme.localhost:5173');
    expect(buildWorkspaceOrigin('https', 'api', 'workspaces.example.com')).toBeNull();
    expect(buildWorkspaceOrigin('https', 'evil.com/x', 'workspaces.example.com')).toBeNull();
    expect(buildWorkspaceOrigin('https', 'acme', undefined)).toBeNull();
  });
});
