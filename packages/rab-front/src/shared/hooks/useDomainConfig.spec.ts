// The module under test also exports `useDomainConfig` (a React Query hook), which imports the
// real `api.ts` — that file uses `import.meta.env` (Vite-only syntax Jest's CJS transform can't
// parse). Mocked here purely to allow importing the two PURE functions these tests actually
// exercise; nothing in this file calls the mocked hook itself.
jest.mock('../api', () => ({ api: { get: jest.fn() } }));

import { buildWorkspacePreviewUrl, resolveWorkspaceDomainDisplay } from './useDomainConfig';

function loc(host: string, protocol: 'http:' | 'https:' = 'http:') {
  return { hostname: host.split(':')[0]!, host, protocol };
}

describe('resolveWorkspaceDomainDisplay', () => {
  it('localhost:5173 with matching backend config — uses the browser host directly', () => {
    const { currentAppAddress, effectiveDomain } = resolveWorkspaceDomainDisplay(
      loc('localhost:5173'),
      { scheme: 'http', workspaceBaseDomain: 'localhost:5173' },
    );
    expect(currentAppAddress).toBe('http://localhost:5173');
    expect(effectiveDomain?.workspaceBaseDomain).toBe('localhost:5173');
    expect(buildWorkspacePreviewUrl(effectiveDomain, 'issac')).toBe('http://issac.localhost:5173');
  });

  it('127.0.0.1:5173 — never builds issac.127.0.0.1; falls back to backend config for the preview', () => {
    const { currentAppAddress, effectiveDomain } = resolveWorkspaceDomainDisplay(
      loc('127.0.0.1:5173'),
      { scheme: 'http', workspaceBaseDomain: 'localhost:5173' },
    );
    expect(currentAppAddress).toBe('http://127.0.0.1:5173');
    expect(effectiveDomain?.workspaceBaseDomain).toBe('localhost:5173');
    const preview = buildWorkspacePreviewUrl(effectiveDomain, 'issac');
    expect(preview).toBe('http://issac.localhost:5173');
    expect(preview).not.toContain('127.0.0.1');
  });

  it('127.0.0.1 with NO backend config at all — no subdomain preview, honest current-address fallback only', () => {
    const { currentAppAddress, effectiveDomain } = resolveWorkspaceDomainDisplay(loc('127.0.0.1:5173'), undefined);
    expect(currentAppAddress).toBe('http://127.0.0.1:5173');
    expect(buildWorkspacePreviewUrl(effectiveDomain, 'issac')).toBeNull();
  });

  it('rab.com — a plain DNS hostname not yet known to backend config is trusted directly for display', () => {
    const { currentAppAddress, effectiveDomain } = resolveWorkspaceDomainDisplay(loc('rab.com', 'https:'), undefined);
    expect(currentAppAddress).toBe('https://rab.com');
    expect(effectiveDomain?.workspaceBaseDomain).toBe('rab.com');
    expect(buildWorkspacePreviewUrl(effectiveDomain, 'issac')).toBe('https://issac.rab.com');
  });

  it('crewflow.co.uk — same plain-hostname behaviour as rab.com, scheme-aware', () => {
    const { effectiveDomain } = resolveWorkspaceDomainDisplay(loc('crewflow.co.uk', 'https:'), undefined);
    expect(buildWorkspacePreviewUrl(effectiveDomain, 'issac')).toBe('https://issac.crewflow.co.uk');
  });

  it('app.rab.com with backend config base rab.com — does not double-subdomain; uses the configured base', () => {
    const { effectiveDomain } = resolveWorkspaceDomainDisplay(
      loc('app.rab.com', 'https:'),
      { scheme: 'https', workspaceBaseDomain: 'rab.com' },
    );
    expect(effectiveDomain?.workspaceBaseDomain).toBe('rab.com');
    const preview = buildWorkspacePreviewUrl(effectiveDomain, 'issac');
    expect(preview).toBe('https://issac.rab.com');
    expect(preview).not.toBe('https://issac.app.rab.com');
  });

  it('issac.rab.com (already on a workspace subdomain) with backend config base rab.com — still resolves to the base, not a double subdomain', () => {
    const { effectiveDomain } = resolveWorkspaceDomainDisplay(
      loc('issac.rab.com', 'https:'),
      { scheme: 'https', workspaceBaseDomain: 'rab.com' },
    );
    expect(buildWorkspacePreviewUrl(effectiveDomain, 'team2')).toBe('https://team2.rab.com');
  });

  it('scheme always reflects the browser, not a hardcoded default', () => {
    const httpResult = resolveWorkspaceDomainDisplay(loc('rab.com', 'http:'), undefined);
    expect(buildWorkspacePreviewUrl(httpResult.effectiveDomain, 'issac')).toBe('http://issac.rab.com');
  });
});
