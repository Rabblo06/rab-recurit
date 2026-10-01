import { api } from '../api';
import { initTheme, applyTheme } from './theme';
import { markAuthenticated, markUnauthenticated } from './auth-session';

jest.mock('../api', () => ({
  api: { get: jest.fn(), patch: jest.fn() },
}));

const mockApi = api as unknown as { get: jest.Mock; patch: jest.Mock };

// Flushes the mocked-promise -> .then() microtask chain (jest's
// mockResolvedValue wraps the value in its own promise, adding a hop beyond
// a single `await Promise.resolve()`).
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

/**
 * PHASE 12 / UI-03 — `theme.ts` used to gate its server-sync fetch on
 * `localStorage.getItem('accessToken')`, a check that Phase 10 made
 * permanently dead (the access token lives only in memory now, in
 * `auth-session.ts` — see that module's own doc comment). These tests
 * replace the obsolete localStorage-based ones and instead drive the real
 * session store directly, proving the fetch now actually fires once a
 * session is confirmed authenticated, and only then.
 */
describe('theme — server sync', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockApi.get.mockReset();
    mockApi.patch.mockReset();
    // Default to a never-resolving promise so any test that calls
    // markAuthenticated() without its own mockResolvedValue still gets a
    // real thenable back from the sync call, rather than `undefined`.
    mockApi.get.mockReturnValue(new Promise(() => {}));
    markUnauthenticated();
    // jsdom doesn't implement matchMedia; applyTheme's 'system' resolution needs it.
    window.matchMedia = jest.fn().mockReturnValue({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    });
  });

  it('does not call the API when there is no session — avoids a doomed 401 on the login screen', () => {
    initTheme();
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  it('never reads or writes an access-token-shaped key in localStorage — the theme preference itself is the only thing this module persists', async () => {
    const getSpy = jest.spyOn(Storage.prototype, 'getItem');
    const setSpy = jest.spyOn(Storage.prototype, 'setItem');
    mockApi.get.mockResolvedValue({ data: { theme: 'dark' } });
    initTheme();
    markAuthenticated('access-token-1');
    await flushMicrotasks();

    expect(getSpy).not.toHaveBeenCalledWith('accessToken');
    expect(setSpy).not.toHaveBeenCalledWith('accessToken', expect.anything());
    getSpy.mockRestore();
    setSpy.mockRestore();
  });

  it('fetches server-side preferences once the session becomes authenticated', async () => {
    mockApi.get.mockResolvedValue({ data: { theme: 'dark' } });
    initTheme();
    expect(mockApi.get).not.toHaveBeenCalled(); // not yet — still unauthenticated at this point

    markAuthenticated('access-token-1');
    await Promise.resolve();

    expect(mockApi.get).toHaveBeenCalledWith('/profile/preferences');
  });

  it('applies the server default theme when the device has no local preference yet', async () => {
    mockApi.get.mockResolvedValue({ data: { theme: 'dark' } });
    initTheme();
    markAuthenticated('access-token-1');
    await flushMicrotasks();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('theme')).toBe('dark');
  });

  it('does not override a theme the user already chose on this device, even if the server returns a different default', async () => {
    applyTheme('light', { persist: false });
    mockApi.get.mockResolvedValue({ data: { theme: 'dark' } });

    initTheme();
    markAuthenticated('access-token-1');
    await flushMicrotasks();

    expect(window.localStorage.getItem('theme')).toBe('light');
  });

  it('syncing the server default down never writes it back to the server (no feedback loop)', async () => {
    mockApi.get.mockResolvedValue({ data: { theme: 'dark' } });
    initTheme();
    markAuthenticated('access-token-1');
    await flushMicrotasks();

    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('fetches only once per continuous authenticated session — a background token refresh does not re-fetch preferences', async () => {
    mockApi.get.mockResolvedValue({ data: { theme: 'dark' } });
    initTheme();
    markAuthenticated('access-token-1');
    await flushMicrotasks();
    expect(mockApi.get).toHaveBeenCalledTimes(1);

    // A background revalidation (tab-visibility, cross-tab broadcast) calls
    // markAuthenticated again with a fresh token for the SAME session.
    markAuthenticated('access-token-2');
    await flushMicrotasks();

    expect(mockApi.get).toHaveBeenCalledTimes(1);
  });

  it('fetches again after a genuine logout/login cycle in the same tab', async () => {
    mockApi.get.mockResolvedValue({ data: { theme: 'dark' } });
    initTheme();
    markAuthenticated('access-token-1');
    await flushMicrotasks();
    expect(mockApi.get).toHaveBeenCalledTimes(1);

    markUnauthenticated();
    markAuthenticated('access-token-2');
    await flushMicrotasks();

    expect(mockApi.get).toHaveBeenCalledTimes(2);
  });

  it('applies the immediate local/system theme synchronously (zero-flicker), without waiting on the network', () => {
    window.localStorage.setItem('theme', 'dark');
    mockApi.get.mockReturnValue(new Promise(() => {})); // never resolves

    initTheme();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('a failed preferences request does not throw and leaves the local theme standing', async () => {
    applyTheme('light', { persist: false });
    mockApi.get.mockRejectedValue(new Error('network error'));

    initTheme();
    markAuthenticated('access-token-1');
    await flushMicrotasks();

    expect(window.localStorage.getItem('theme')).toBe('light');
  });
});
