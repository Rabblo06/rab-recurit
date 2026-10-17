import { useQuery } from '@tanstack/react-query';
import { api } from '../../../shared/api';

/** Server-derived leadership capabilities (`GET /leadership/capabilities`). Presentation only — never a replacement for
 * endpoint authorization. Organisation isolation (2026-10-15): Initial Manager Add is the caller's OWN organisation or nothing;
 * there is no organisation-selection scope, and any other value (including the retired 'select') fails closed to none.
 */
export interface LeadershipCapabilities {
  canCreateOrganisation: boolean;
  initialManagerScope: 'none' | 'own';
}

const NONE: LeadershipCapabilities = { canCreateOrganisation: false, initialManagerScope: 'none' };

export function useLeadershipCapabilities(enabled: boolean) {
  const query = useQuery({
    queryKey: ['leadership', 'capabilities'],
    queryFn: async () => (await api.get<unknown>('/leadership/capabilities')).data,
    enabled,
  });
  const capabilities = readLeadershipCapabilities(enabled && !query.isError ? query.data : null);
  return { capabilities, canAdd: capabilities.canCreateOrganisation || capabilities.initialManagerScope !== 'none', isLoading: enabled && query.isLoading };
}

export function readLeadershipCapabilities(response: unknown): LeadershipCapabilities {
  if (!response || typeof response !== 'object' || !('leadership' in response)) return NONE;
  const value = response.leadership;
  if (!value || typeof value !== 'object' || !('canCreateOrganisation' in value) ||
      !('initialManagerScope' in value) || typeof value.canCreateOrganisation !== 'boolean' ||
      typeof value.initialManagerScope !== 'string' || !['none', 'own'].includes(value.initialManagerScope)) return NONE;
  return {
    canCreateOrganisation: value.canCreateOrganisation,
    initialManagerScope: value.initialManagerScope as LeadershipCapabilities['initialManagerScope'],
  };
}
