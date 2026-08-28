import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export interface MyWorkspace {
  id: string;
  name: string;
  subdomain: string;
  logoKey: string | null;
  status: string;
  onboardingCompletedAt: string | null;
  createdAt: string;
}

/**
 * `GET /manager-workspaces/me` — a 404 is a valid, expected state (this
 * Manager hasn't created a workspace yet), not a query error. Callers that
 * need to distinguish "no workspace" from "still loading" use `isLoading`;
 * `data` is `null` (not undefined-forever) once resolved either way.
 */
export function useMyWorkspace() {
  return useQuery({
    queryKey: ['manager-workspace'],
    queryFn: async () => {
      try {
        const { data } = await api.get<MyWorkspace>('/manager-workspaces/me');
        return data;
      } catch (err: any) {
        if (err?.response?.status === 404) return null;
        throw err;
      }
    },
  });
}
