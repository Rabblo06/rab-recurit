import { queryOptions } from '@tanstack/react-query';
import { api } from '../../shared/api';
import { fetchAllPages } from '../../shared/table-toolbar/pagination';

/** Shared by Shifts, Calendar and the shell's nav-hover prefetch (one definition, one cache key). */

/** Every venue including archived ones: name resolution for historical shifts. */
export function venuesWithArchivedQuery<T = { id: string; name: string }>() {
  return queryOptions({
    queryKey: ['venues', 'with-archived'],
    queryFn: () => fetchAllPages<T>('/venues', { includeArchived: true }),
  });
}

/** The caller's roles (`GET /auth/me`), presentation only. */
export const authMeQuery = queryOptions({
  queryKey: ['auth-me'],
  queryFn: async () => (await api.get<{ roles: string[] }>('/auth/me')).data,
  staleTime: 5 * 60 * 1000,
});
