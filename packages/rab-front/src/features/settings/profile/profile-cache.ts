import type { QueryClient } from '@tanstack/react-query';
import type { CurrentProfile } from '../../../shared/hooks/useCurrentProfile';

/**
 * Applies the profile the server just CONFIRMED (PATCH /profile, POST/DELETE /profile/avatar all answer with it) to the
 * shared `['profile']` cache, then refetches in the background. The response is written only when it is the same user
 * the cache already holds: a late response from a previous identity (see ProfilePage.spec test 6) must never repaint
 * the current user's data. Anything else falls back to the refetch alone.
 */
export function applyConfirmedProfile(qc: QueryClient, profile: unknown): void {
  const cached = qc.getQueryData<CurrentProfile>(['profile']);
  const next = profile as Partial<CurrentProfile> | null | undefined;
  if (cached && next && typeof next === 'object' && typeof next.id === 'string' && next.id === cached.id) {
    qc.setQueryData<CurrentProfile>(['profile'], { ...cached, ...(next as CurrentProfile) });
  }
  void qc.invalidateQueries({ queryKey: ['profile'], exact: true });
  void qc.invalidateQueries({ queryKey: ['me'] });
}
