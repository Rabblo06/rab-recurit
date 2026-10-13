import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api';

interface Me {
  roles: string[];
}

/**
 * UX-only guard, same convention as `PlatformAdminRoute.tsx` — redirects a non-CEO away from
 * `/settings/workspace/team` so the page never even mounts for them. The real enforcement is the
 * backend's own `PermissionGuard(MANAGER_MANAGE)` plus `OrganisationOnboardingService
 * .assertActorCanManageOrganisation` (platform admin or this organisation's own CEO); this only
 * prevents a confusing flash of a page whose requests would otherwise 403/404.
 */
export default function CeoRoute({ children }: { children: ReactNode }) {
  const { data: me, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get<Me>('/auth/me')).data,
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) return null;
  if (!me?.roles.includes('ceo')) return <Navigate to="/settings/profile" replace />;
  return <>{children}</>;
}
