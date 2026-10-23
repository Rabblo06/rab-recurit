import { api } from '../../shared/api';
import { continueOnWorkspaceHost, isSafeHandoffUrl } from './workspaceHandoff';

jest.mock('../../shared/api', () => ({ api: { post: jest.fn() } }));

const post = api.post as jest.Mock;
const token = `lho_${'c'.repeat(43)}`;
const host = { defaultUrl: 'http://localhost:5173', workspaceBaseDomain: 'localhost:5173' } as const;

describe('isSafeHandoffUrl (open-redirect guard, defence in depth)', () => {
  it('accepts exactly <scheme>://<label>.<base>/auth/handoff#t=<token>', () => {
    expect(isSafeHandoffUrl(`http://acme.localhost:5173/auth/handoff#t=${token}`, host)).toBe(true);
  });

  it.each([
    [`https://acme.localhost:5173/auth/handoff#t=${token}`, 'other scheme'],
    [`http://evil.example/auth/handoff#t=${token}`, 'foreign host'],
    [`http://acme.localhost:5173.evil.example/auth/handoff#t=${token}`, 'look-alike suffix'],
    [`http://acme.localhost:5174/auth/handoff#t=${token}`, 'other port'],
    [`http://a.b.localhost:5173/auth/handoff#t=${token}`, 'nested label'],
    [`http://api.localhost:5173/auth/handoff#t=${token}`, 'reserved label'],
    [`http://acme.localhost:5173/elsewhere#t=${token}`, 'other path'],
    [`http://acme.localhost:5173/auth/handoff?t=${token}`, 'token in the query string'],
    [`http://acme.localhost:5173/auth/handoff?x=1#t=${token}`, 'extra query'],
    ['http://acme.localhost:5173/auth/handoff#t=short', 'malformed token'],
    [`http://user:pw@acme.localhost:5173/auth/handoff#t=${token}`, 'userinfo'],
    [`javascript:alert(1)//acme.localhost:5173/auth/handoff#t=${token}`, 'javascript:'],
    ['//evil.example/auth/handoff', 'protocol-relative'],
  ])('refuses %s (%s)', (url) => {
    expect(isSafeHandoffUrl(url, host)).toBe(false);
  });
});

describe('continueOnWorkspaceHost', () => {
  const replace = jest.fn();
  const original = window.location;
  beforeAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, origin: 'http://localhost:5173', replace } });
  });
  afterAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });
  beforeEach(() => {
    post.mockReset();
    replace.mockReset();
  });

  it('stays on a workspace host or when routing is off (no request at all)', async () => {
    expect(await continueOnWorkspaceHost({ state: 'workspace', defaultUrl: host.defaultUrl, workspaceBaseDomain: host.workspaceBaseDomain, canonicalUrl: 'http://acme.localhost:5173', workspace: { subdomain: 'acme', displayName: null } })).toBe(false);
    expect(await continueOnWorkspaceHost({ state: 'default', defaultUrl: host.defaultUrl, workspaceBaseDomain: null })).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('follows a safe server answer with location.replace, ignores a null or unsafe one', async () => {
    post.mockResolvedValueOnce({ data: { redirectUrl: `http://acme.localhost:5173/auth/handoff#t=${token}` } });
    expect(await continueOnWorkspaceHost({ state: 'default', ...host })).toBe(true);
    expect(replace).toHaveBeenCalledWith(`http://acme.localhost:5173/auth/handoff#t=${token}`);

    post.mockResolvedValueOnce({ data: { redirectUrl: null } });
    expect(await continueOnWorkspaceHost({ state: 'default', ...host })).toBe(false);
    post.mockResolvedValueOnce({ data: { redirectUrl: `http://evil.example/auth/handoff#t=${token}` } });
    expect(await continueOnWorkspaceHost({ state: 'default', ...host })).toBe(false);
    post.mockRejectedValueOnce(new Error('network'));
    expect(await continueOnWorkspaceHost({ state: 'default', ...host })).toBe(false);
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
