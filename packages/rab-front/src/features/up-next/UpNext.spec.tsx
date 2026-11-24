import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import UpNext from './UpNext';
import { upcomingShifts, awaitingOffers, when, londonDate } from './upNextModel';
import { api } from '../../shared/api';
jest.mock('../../shared/api', () => ({ api: { get: jest.fn() } }));
let mockScope = 'account-a:workspace-a';
jest.mock('../ai/AiChatProvider', () => ({ useAiChat: () => ({ scope: mockScope }) }));
jest.mock('./UpNextComposer', () => () => <div>Existing assistant entry</div>);
jest.mock('../scheduling/ShiftTimelinePanel', () => ({
  __esModule: true,
  default: ({ shiftId }: { shiftId: string | null }) => (shiftId ? <div>Timeline {shiftId}</div> : null),
}));
const now = new Date('2026-11-08T12:00:00Z');
const shift = (id: string, status: string, startsAt: string, endsAt: string) => ({
  id,
  status,
  startsAt,
  endsAt,
  requiredCount: 4,
  filledCount: 2,
});
test('excludes ended, cancelled and draft shifts; preserves assignment times', () => {
  const result = upcomingShifts(
    [
      shift('later', 'open', '2026-11-09T09:00:00Z', '2026-11-09T17:00:00Z'),
      shift('past', 'open', '2026-11-07T09:00:00Z', '2026-11-07T17:00:00Z'),
      shift('draft', 'draft', '2026-11-09T09:00:00Z', '2026-11-09T17:00:00Z'),
      shift('cancelled', 'cancelled', '2026-11-09T09:00:00Z', '2026-11-09T17:00:00Z'),
      shift('current', 'in_progress', '2026-11-08T09:00:00Z', '2026-11-08T17:00:00Z'),
    ],
    now,
  );
  expect(result.map((s) => s.id)).toEqual(['current', 'later']);
  expect(result[0].startsAt).toBe('2026-11-08T09:00:00Z');
});
test('excludes withdrawn, expired and already confirmed offers using server fields', () => {
  const offer = { id: 'active', status: 'staff_accepted', expiresAt: '2026-11-08T13:00:00Z' };
  expect(
    awaitingOffers(
      [
        offer,
        { ...offer, id: 'expired', expiresAt: now.toISOString() },
        { ...offer, id: 'withdrawn', status: 'withdrawn' },
        { ...offer, id: 'confirmed', managerConfirmedAt: now.toISOString() },
        { ...offer, id: 'rejected', managerRejectedAt: now.toISOString() },
      ],
      now,
    ).map((o) => o.id),
  ).toEqual(['active']);
});
test('formats London dates across daylight saving', () => {
  expect(when('2026-07-01T23:30:00Z')).toContain('00:30');
  expect(londonDate(new Date('2026-07-01T23:30:00Z'))).toBe('2026-07-02');
  expect(when('2026-11-01T10:30:00Z')).toContain('10:30');
});
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const view = (q: QueryClient) => (
  <QueryClientProvider client={q}>
    <MemoryRouter>
      <UpNext />
    </MemoryRouter>
  </QueryClientProvider>
);
beforeEach(() => {
  jest.clearAllMocks();
  mockScope = 'account-a:workspace-a';
});
test('opens the exact shift timeline and links to existing confirmation workflow', async () => {
  const later = new Date(Date.now() + 86400000).toISOString();
  (api.get as jest.Mock).mockImplementation((path: string) =>
    Promise.resolve({
      data:
        path === '/auth/capabilities'
          ? { 'schedule.view': true, 'offer.confirm': true }
          : {
              data:
                path === '/shifts'
                  ? [{ ...shift('shift-1', 'open', later, later), venueName: 'Test venue' }]
                  : [
                      {
                        id: 'offer',
                        staffName: 'Test staff',
                        venueName: 'Test venue',
                        startsAt: later,
                        status: 'staff_accepted',
                      },
                    ],
              total: 1,
            },
    }),
  );
  render(view(client()));
  expect(await screen.findByText('Test staff')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Test staff/ })).toHaveAttribute(
    'href',
    '/offers?status=staff_accepted',
  );
  fireEvent.click(screen.getAllByRole('button', { name: /Test venue/ })[0]);
  expect(screen.getByText('Timeline shift-1')).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});
test('does not fetch restricted queues and clears previous workspace rows on scope change', async () => {
  const later = new Date(Date.now() + 86400000).toISOString();
  (api.get as jest.Mock).mockImplementation((path: string) =>
    Promise.resolve({
      data:
        path === '/auth/capabilities'
          ? mockScope.endsWith('a')
            ? { 'schedule.view': true }
            : {}
          : { data: [{ ...shift('shift', 'open', later, later), venueName: 'Private venue' }], total: 1 },
    }),
  );
  const q = client();
  const { rerender } = render(view(q));
  await screen.findAllByText('Private venue');
  (api.get as jest.Mock).mockClear();
  mockScope = 'account-b:workspace-b';
  rerender(view(q));
  await screen.findByText(/No staffing queues/);
  expect(screen.queryByText('Private venue')).not.toBeInTheDocument();
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(api.get).toHaveBeenCalledWith('/auth/capabilities');
});
test('failed reads show retry instead of claiming an empty schedule', async () => {
  (api.get as jest.Mock).mockImplementation((path: string) =>
    path === '/auth/capabilities'
      ? Promise.resolve({ data: { 'schedule.view': true } })
      : Promise.reject({ response: { status: 403 }, message: 'Unavailable' }),
  );
  render(view(client()));
  await waitFor(() => expect(screen.getAllByText(/retry/i).length).toBeGreaterThan(0));
  expect(screen.queryByText(/No upcoming shifts to show/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Nothing needs immediate/)).not.toBeInTheDocument();
});
