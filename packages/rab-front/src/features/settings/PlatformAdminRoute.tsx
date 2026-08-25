import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api';

interface Me {
  isPlatformAdmin: boolean;
}

/**
 * UX-only guard — redirects a non-owner away from /settings/admin so the
 * page never even mounts for them. The real enforcement is the backend's
 * `PlatformAdminGuard` on every /admin/* route; this only prevents a
 * confusing flash of a page whose requests would all 403 anyway.
 */
export default function PlatformAdminRoute({ children }: { children: ReactNode }) {
  const { data: me, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await api.get<Me>('/auth/me');
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) return null;
  if (!me?.isPlatformAdmin) return <Navigate to="/settings/profile" replace />;
  return <>{children}</>;
}
