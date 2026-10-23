import {
  classifyRequestHost,
  classifyRequestOrigin,
  HostClassificationConfig,
  platformAuthoritiesFrom,
  requestHostHeader,
  requestOriginHeader,
} from './request-host.util';

const TRUSTED_PROXY = ['10.0.0.5/32'];
const config: HostClassificationConfig = {
  baseDomain: 'workspaces.example.com',
  platformAuthorities: platformAuthoritiesFrom(['https://app.example.com', 'https://accounts.workspaces.example.com', 'https://console.example.com']),
};

describe('requestHostHeader — validated sources only', () => {
  it('uses Host when the peer is not a trusted proxy, ignoring a spoofed X-Forwarded-Host', () => {
    const req = { headers: { host: 'api.example.com', 'x-forwarded-host': 'victim.workspaces.example.com' }, socket: { remoteAddress: '203.0.113.9' } };
    expect(requestHostHeader(req, TRUSTED_PROXY)).toBe('api.example.com');
  });

  it('ignores X-Forwarded-Host entirely when no proxy is configured', () => {
    const req = { headers: { host: 'api.example.com', 'x-forwarded-host': 'victim.workspaces.example.com' }, socket: { remoteAddress: '10.0.0.5' } };
    expect(requestHostHeader(req, [])).toBe('api.example.com');
  });

  it('uses X-Forwarded-Host only from a trusted proxy peer (IPv4-mapped IPv6 included)', () => {
    const req = { headers: { host: 'internal:3000', 'x-forwarded-host': 'acme.workspaces.example.com' }, socket: { remoteAddress: '::ffff:10.0.0.5' } };
    expect(requestHostHeader(req, TRUSTED_PROXY)).toBe('acme.workspaces.example.com');
  });

  it('refuses an appended / repeated X-Forwarded-Host (null), never "first wins"', () => {
    const appended = { headers: { host: 'internal', 'x-forwarded-host': 'acme.workspaces.example.com, evil.workspaces.example.com' }, socket: { remoteAddress: '10.0.0.5' } };
    expect(requestHostHeader(appended, TRUSTED_PROXY)).toBeNull();
    const repeated = { headers: { host: 'internal', 'x-forwarded-host': ['acme.workspaces.example.com', 'evil.workspaces.example.com'] }, socket: { remoteAddress: '10.0.0.5' } };
    expect(requestHostHeader(repeated, TRUSTED_PROXY)).toBeNull();
  });

  it('falls back to Host when a trusted proxy sends no X-Forwarded-Host', () => {
    expect(requestHostHeader({ headers: { host: 'acme.workspaces.example.com' }, socket: { remoteAddress: '10.0.0.5' } }, TRUSTED_PROXY)).toBe('acme.workspaces.example.com');
  });
});

describe('requestOriginHeader', () => {
  it('treats an absent or opaque ("null") Origin as absent', () => {
    expect(requestOriginHeader({ headers: {} })).toBeUndefined();
    expect(requestOriginHeader({ headers: { origin: 'null' } })).toBeUndefined();
    expect(requestOriginHeader({ headers: { origin: 'https://acme.workspaces.example.com' } })).toBe('https://acme.workspaces.example.com');
  });
});

describe('classifyRequestHost', () => {
  it.each([
    ['acme.workspaces.example.com', { kind: 'label', label: 'acme' }],
    ['ACME.workspaces.example.com', { kind: 'label', label: 'acme' }],
    ['api.workspaces.example.com', { kind: 'none' }], // reserved on the HOST side = a platform host (maybe this API)
    ['accounts.workspaces.example.com', { kind: 'none' }], // configured platform host
    ['workspaces.example.com', { kind: 'none' }], // apex
    ['api.example.com', { kind: 'none' }], // outside the base
    ['127.0.0.1:3000', { kind: 'none' }],
    ['[::1]:3000', { kind: 'none' }],
    ['a.acme.workspaces.example.com', { kind: 'invalid', label: null }],
    ['acme.workspaces.example.com:8443', { kind: 'invalid', label: null }],
    ['acme.workspaces.example.com.', { kind: 'invalid', label: null }],
    ['acme..workspaces.example.com', { kind: 'invalid', label: null }],
    ['ab.workspaces.example.com', { kind: 'invalid', label: null }],
    ['acme.workspaces.example.com:99999', { kind: 'invalid', label: null }],
    ['acme.workspaces.example.com@evil.test', { kind: 'invalid', label: null }],
  ])('%s → %j', (raw, expected) => {
    expect(classifyRequestHost(raw, config)).toEqual(expected);
  });

  it('absent host → none; ambiguous host → invalid', () => {
    expect(classifyRequestHost(undefined, config)).toEqual({ kind: 'none' });
    expect(classifyRequestHost(null, config)).toEqual({ kind: 'invalid', label: null });
  });
});

describe('classifyRequestOrigin', () => {
  it.each([
    ['https://acme.workspaces.example.com', { kind: 'label', label: 'acme' }],
    ['https://app.example.com', { kind: 'none' }],
    ['https://evil.test', { kind: 'none' }],
    ['https://admin.workspaces.example.com', { kind: 'invalid', label: 'admin' }], // reserved Origin: no Crewflow page lives there
    ['https://xn--pple-43d.workspaces.example.com', { kind: 'invalid', label: 'xn--pple-43d' }],
    ['https://acme.workspaces.example.com/', { kind: 'invalid', label: null }],
    ['https://ACME.workspaces.example.com', { kind: 'invalid', label: null }],
    ['https://user@acme.workspaces.example.com', { kind: 'invalid', label: null }],
    ['ftp://acme.workspaces.example.com', { kind: 'invalid', label: null }],
    ['not a url', { kind: 'invalid', label: null }],
  ])('%s → %j', (raw, expected) => {
    expect(classifyRequestOrigin(raw, config)).toEqual(expected);
  });
});
