import axios from 'axios';
import { getAccessToken, markAuthenticated, markUnauthenticated } from './lib/auth-session';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000/rest/v1',
  // The refresh cookie is HttpOnly and Path-scoped to /rest/v1/auth (see
  // rab-server's refresh-cookie.constants.ts) — this only controls whether
  // the browser is ALLOWED to attach/accept it on cross-origin calls to the
  // API's own origin; it doesn't widen what the cookie is sent to.
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

function clearSessionAndRedirect(): void {
  markUnauthenticated();
  // Reassigning location.href to the page we're already on still reloads
  // it in most browsers — harmless on its own, but a page that fires an
  // unauthenticated request on boot (there was one; see theme.ts) would
  // loop forever doing it. Guard here too, since this is the one choke
  // point every such 401 ultimately funnels through.
  if (window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
}

// Single-flight refresh: concurrent 401s from several in-flight requests
// share one /auth/refresh call instead of each racing to rotate the same
// refresh token (the second rotation would be reuse-detected and revoke the
// whole session — see rab-workforce-architecture.md §8.1). No body is sent —
// the browser attaches the HttpOnly rab_rt cookie automatically; the server
// never returns the rotated refresh token back to this JS at all anymore,
// only a fresh access token, which is all this function stores.
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  try {
    const { data } = await axios.post(
      `${api.defaults.baseURL}/auth/refresh`,
      undefined,
      { withCredentials: true },
    );
    markAuthenticated(data.accessToken);
    return data.accessToken as string;
  } catch {
    return null;
  }
}

/**
 * Runs once on app boot (see `App.tsx`) — with no access token in memory yet
 * (a hard reload always starts empty), this is what silently restores a
 * session from the refresh cookie instead of forcing a fresh login every
 * time the tab is closed and reopened. Deliberately reuses the same
 * single-flight guard as the 401-triggered path below, so a page that
 * happens to fire several requests immediately on mount doesn't race
 * multiple bootstrap refreshes against the same cookie.
 */
export async function bootstrapSession(): Promise<boolean> {
  refreshInFlight ??= refreshAccessToken().finally(() => {
    refreshInFlight = null;
  });
  return (await refreshInFlight) !== null;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && original && !original._retried && !original.url?.includes('/auth/')) {
      original._retried = true;
      refreshInFlight ??= refreshAccessToken().finally(() => {
        refreshInFlight = null;
      });
      const newAccessToken = await refreshInFlight;
      if (newAccessToken) {
        original.headers.Authorization = `Bearer ${newAccessToken}`;
        return api(original);
      }
      clearSessionAndRedirect();
    } else if (error.response?.status === 401) {
      clearSessionAndRedirect();
    }
    return Promise.reject(error);
  },
);
