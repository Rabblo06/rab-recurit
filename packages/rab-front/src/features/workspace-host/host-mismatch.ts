import type { AxiosInstance } from 'axios';

/** Server error code (rab-server `WORKSPACE_HOST_MISMATCH`): a session used from a workspace host that is not its own. */
export const WORKSPACE_HOST_MISMATCH = 'WORKSPACE_HOST_MISMATCH';

export interface HostMismatch {
  /** The signed-in account's OWN workspace address (or the default app URL), as the server built it. Unvalidated here. */
  canonicalUrl: string | null;
}

type Listener = (mismatch: HostMismatch) => void;
const listeners = new Set<Listener>();
let installedOn: AxiosInstance | null = null;

/** True for the server's wrong-host 404 — and only that one (a plain 404 is an ordinary not-found). */
export function isHostMismatchError(error: unknown): HostMismatch | null {
  const response = (error as { response?: { status?: number; data?: { code?: unknown; canonicalUrl?: unknown } } } | null)?.response;
  if (response?.status !== 404 || response.data?.code !== WORKSPACE_HOST_MISMATCH) return null;
  return { canonicalUrl: typeof response.data.canonicalUrl === 'string' ? response.data.canonicalUrl : null };
}

/**
 * Watches every API response for the wrong-host 404 and tells subscribers (the gate), which then replaces the whole app
 * with the wrong-host screen — no data from that response or any later one is rendered. The error is still rejected to
 * the original caller unchanged. Installed once per client.
 */
export function installHostMismatchWatcher(client: AxiosInstance): void {
  if (installedOn === client || !client?.interceptors?.response) return;
  installedOn = client;
  client.interceptors.response.use(undefined, (error: unknown) => {
    const mismatch = isHostMismatchError(error);
    if (mismatch) for (const listener of listeners) listener(mismatch);
    return Promise.reject(error);
  });
}

/** Tells subscribers about a wrong-host 404 seen outside the watched client (the raw identity read in shared/api). */
export function notifyIfHostMismatch(error: unknown): void {
  const mismatch = isHostMismatchError(error);
  if (mismatch) for (const listener of listeners) listener(mismatch);
}

export function onHostMismatch(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
