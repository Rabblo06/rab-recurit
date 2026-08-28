import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export interface CurrentProfile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  avatarKey: string | null;
}

/**
 * The one place `GET /profile` is called from — sidebar, onboarding, and
 * Settings → Profile all read the same `['profile']` query instead of each
 * keeping their own copy. Invalidate `['profile']` after any mutation that
 * changes name/jobTitle/avatar and every consumer updates together, with no
 * manual state-passing between them.
 */
export function useCurrentProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: async () => (await api.get<CurrentProfile>('/profile')).data,
  });
}
