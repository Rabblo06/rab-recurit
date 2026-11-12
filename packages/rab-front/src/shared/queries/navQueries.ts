import { queryOptions } from '@tanstack/react-query';
import { api } from '../api';

/**
 * Query definitions shared by several features AND by the shell's nav-hover prefetch (fast first navigation, 2026-11-11).
 * A page and the prefetch use the SAME definition, so the prefetched data lands under the exact key the page reads and
 * the two can never drift apart. Same endpoints, same cookies: nothing here changes what the server enforces.
 */

/** `GET /job-roles` (Users, Shifts, Calendar). Callers pass their own row type. */
export function jobRolesQuery<T = { id: string; name: string }>() {
  return queryOptions({
    queryKey: ['job-roles'],
    queryFn: async () => (await api.get<T[]>('/job-roles')).data,
  });
}

/** `GET /auth/capabilities` (Payroll and others). Presentation only; every action is enforced server-side. */
export const capabilitiesQuery = queryOptions({
  queryKey: ['auth', 'capabilities'],
  queryFn: async () => (await api.get<Record<string, boolean>>('/auth/capabilities')).data,
  staleTime: 300_000,
});
