import { queryOptions } from '@tanstack/react-query';
import { api } from '../../../shared/api';

/** One active session as `GET /profile/sessions` returns it. */
export interface Session {
  familyId: string;
  deviceId: string | null;
  userAgent: string | null;
  ip: string | null;
  /** `private`: a loopback/private address (e.g. the local Docker gateway) — the real client IP could not be verified. */
  ipScope: 'public' | 'private' | null;
  createdAt: string;
  lastActiveAt: string;
  isCurrentDevice: boolean;
}

/**
 * `GET /profile/sessions` (Settings > Profile > Devices). Its own tiny module so the shell's Settings hover prefetch can
 * import it without pulling the Devices page into the first-load bundle. One definition, one cache key.
 */
export const sessionsQuery = queryOptions({
  queryKey: ['profile', 'sessions'],
  queryFn: async () => (await api.get<Session[]>('/profile/sessions')).data,
});
