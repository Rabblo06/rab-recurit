import { useQuery } from '@tanstack/react-query';

import { aiApi, aiKeys, isAiBlocked } from './aiApi';
import { useAiChat } from './AiChatProvider';

/**
 * `GET /rest/v1/ai/availability` — the ONLY source for whether this user may see any AI chrome. It never 404s for
 * "unavailable" (that is what every other AI route does); it says why. Fail closed: while loading or after an error the
 * entry points stay hidden.
 *
 *  - `eligible`: show the AI chrome (Ask AI, the AI mode). True for `available: true` AND for the two states the server
 *    discloses only to an eligible caller of an enabled organisation — `not_configured` and `demo_data_only` — where the
 *    chat opens with its input disabled (PHASE1_TWENTY_PLAN C14). Every other reason hides the chrome.
 *  - `usable`: conversations can be listed, opened and asked (`available: true` only).
 *  - `blocked`: eligible but nothing can be sent (`not_configured` / `demo_data_only`).
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
  const usable = query.data?.available === true;
  const blocked = isAiBlocked(query.data);
  return { ...query, eligible: usable || blocked, usable, blocked };
}
