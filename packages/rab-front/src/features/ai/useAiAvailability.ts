import { useQuery } from '@tanstack/react-query';

import { aiApi, aiKeys } from './aiApi';
import { useAiChat } from './AiChatProvider';

/**
 * `GET /rest/v1/ai/availability` — the ONLY source for whether this user may see any AI chrome. It never 404s for
 * "unavailable" (that is what every other AI route does); it says why. Fail closed: while loading or after an error the
 * entry points stay hidden (`eligible` is true only for a confirmed `available: true`).
 */
export function useAiAvailability(enabled = true) {
  const { scope } = useAiChat();
  const query = useQuery({
    queryKey: aiKeys.availability(scope),
    queryFn: aiApi.availability,
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
    meta: { silent: true },
  });
  return { ...query, eligible: query.data?.available === true };
}
