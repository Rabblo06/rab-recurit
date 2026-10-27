import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AI_STATE_MESSAGE } from '@rab/shared';

import { api } from '../../shared/api';
import NavigationModes from '../../shell/NavigationModes';
import AiChatNavigation from './AiChatNavigation';
import { AiChatProvider } from './AiChatProvider';
import { useAiAvailability } from './useAiAvailability';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn(), delete: jest.fn() } }));
const get = api.get as jest.Mock;
const LIMITS = { maxInputChars: 4000, userRatePerMinute: 6, orgDailyTokenBudget: 200000 };

/** The shell's own rule (Layout.tsx): the AI mode / Ask AI show exactly when the hook says `eligible`. */
function Chrome() {
  const { eligible, usable, blocked, isError, isFetched } = useAiAvailability();
  return (
    <>
      <p data-testid="flags">{`eligible=${eligible} usable=${usable} blocked=${blocked} fetched=${isFetched}`}</p>
      {isError && <p>unreachable</p>}
      <NavigationModes mode="home" expanded onSelect={() => undefined} showAi={eligible} />
      <AiChatNavigation />
    </>
  );
}

function renderWith(availability: unknown) {
  get.mockImplementation((url: string) => (url === '/ai/availability' ? Promise.resolve({ data: availability }) : Promise.resolve({ data: { data: [], nextCursor: null } })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiChatProvider workspaceId="ws-a">
        <Chrome />
      </AiChatProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => get.mockReset());

describe('AI chrome follows the server reason (PHASE1_TWENTY_PLAN C14)', () => {
  it.each([
    ['available', { available: true, reason: null, limits: LIMITS, usage: { day: '2026-10-25', tokensUsedOrReserved: 0 } }, 'eligible=true usable=true blocked=false'],
    ['not_configured', { available: false, reason: 'not_configured', setup: 'provider', message: AI_STATE_MESSAGE.NOT_CONFIGURED_PROVIDER, limits: LIMITS, usage: null }, 'eligible=true usable=false blocked=true'],
    ['demo_data_only', { available: false, reason: 'demo_data_only', message: AI_STATE_MESSAGE.DEMO_DATA_ONLY, limits: LIMITS, usage: null }, 'eligible=true usable=false blocked=true'],
  ])('%s shows the AI mode', async (_label, availability, flags) => {
    renderWith(availability);
    await waitFor(() => expect(screen.getByTestId('flags')).toHaveTextContent(`${flags} fetched=true`));
    expect(screen.getByRole('button', { name: /AI/ })).toBeInTheDocument();
  });

  it.each(['platform_disabled', 'organisation_disabled', 'not_permitted', 'no_workspace'])('%s hides every AI entry point (NavigationModes has no AI mode)', async (reason) => {
    renderWith({ available: false, reason, limits: LIMITS, usage: null });
    await waitFor(() => expect(screen.getByTestId('flags')).toHaveTextContent('eligible=false usable=false blocked=false fetched=true'));
    expect(screen.queryByRole('button', { name: /AI/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument();
  });

  it('an unreachable availability endpoint fails closed: no AI chrome', async () => {
    get.mockRejectedValue({ isAxiosError: true, code: 'ERR_NETWORK' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AiChatProvider workspaceId="ws-a">
          <Chrome />
        </AiChatProvider>
      </QueryClientProvider>,
    );
    // Fail closed while loading AND after the (one) retry failed.
    expect(screen.getByTestId('flags')).toHaveTextContent('eligible=false');
    expect(await screen.findByText('unreachable', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByTestId('flags')).toHaveTextContent('eligible=false');
    expect(screen.queryByRole('button', { name: /AI/ })).not.toBeInTheDocument();
  }, 15_000);

  it('blocked: no conversation history is requested and there is no "New chat" (nothing can be asked)', async () => {
    renderWith({ available: false, reason: 'not_configured', setup: 'model', message: AI_STATE_MESSAGE.NOT_CONFIGURED_MODEL, limits: LIMITS, usage: null });
    await waitFor(() => expect(screen.getByTestId('flags')).toHaveTextContent('blocked=true fetched=true'));
    expect(screen.queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument();
    expect(get.mock.calls.map(([url]) => url)).toEqual(['/ai/availability']);
  });
});
