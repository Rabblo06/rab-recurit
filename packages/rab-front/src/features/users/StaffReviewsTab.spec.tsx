import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../shared/api';
import StaffReviewsTab, { StaffReviewSummary } from './StaffReviewsTab';

jest.mock('../../shared/api', () => ({ api: { get: jest.fn() } }));
const get = (api as unknown as { get: jest.Mock }).get;

const base: StaffReviewSummary = {
  staff: { id: 'staff-1', name: 'Issac Nepolean', roleName: 'Waiter' },
  reviewers: [
    { userId: 'sarah', name: 'Sarah Mitchell', venues: ['The Savoy'], reviews: 6 },
    { userId: 'james', name: 'James Wilson', venues: ["Claridge's"], reviews: 4 },
    { userId: 'alex', name: 'Alex Morgan', venues: ['The Dorchester'], reviews: 0 },
  ],
  total: 10,
  reviewerCount: 2,
  average: 4.5,
  distribution: [
    { stars: 5, count: 6, percent: 60 },
    { stars: 4, count: 3, percent: 30 },
    { stars: 3, count: 1, percent: 10 },
    { stars: 2, count: 0, percent: 0 },
    { stars: 1, count: 0, percent: 0 },
  ],
  categories: { grooming: 4.6, attitude: 4.5, skills: 4.4, attendance: 4.8, timeKeeping: 4.2 },
  history: [
    {
      id: 'review-1', reviewerUserId: 'sarah', reviewerName: 'Sarah Mitchell', venueName: 'The Savoy', roleName: 'Waiter',
      startsAt: '2026-10-17T18:00:00Z', endsAt: '2026-10-17T23:30:00Z', score: 4.6,
      feedback: 'Professional and helpful with the team.', submittedAt: '2026-10-17T23:10:00Z',
    },
  ],
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <StaffReviewsTab staffId="staff-1" staffName="Issac Nepolean" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string, config?: { params?: Record<string, string> }) => {
    if (url === '/staff/staff-1/reviews/review-1') {
      return {
        data: {
          id: 'review-1', staff: { name: 'Issac Nepolean' }, venueName: 'The Savoy', roleName: 'Waiter',
          startsAt: '2026-10-17T18:00:00Z', endsAt: '2026-10-17T23:30:00Z',
          reviewer: { name: 'Sarah Mitchell', role: 'Venue manager' }, submittedAt: '2026-10-17T23:10:00Z', score: 4.6,
          ratings: { grooming: 5, attitude: 5, skills: 4, attendance: 5, timeKeeping: 4 },
          feedback: 'Professional and helpful with the team.',
        },
      };
    }
    if (config?.params?.reviewer === 'sarah') {
      return { data: { ...base, total: 6, reviewerCount: 1, average: 4.7, categories: { ...base.categories, grooming: 4.8 } } };
    }
    return { data: base };
  });
});

it('renders real aggregates: average, counts, distribution legend with counts and percents, category averages, history', async () => {
  mount();
  expect(await screen.findByText('10 reviews · 2 managers')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Average 4.5 out of 5 from 10 reviews' })).toBeInTheDocument();
  const legend = screen.getByRole('table');
  expect(within(legend).getByRole('row', { name: /5 stars/ })).toHaveTextContent('6 · 60%');
  expect(within(legend).getByRole('row', { name: /2 stars/ })).toHaveTextContent('0');
  const categories = screen.getByRole('region', { name: 'Average scores' });
  expect(within(categories).getByText('Average by category')).toBeInTheDocument();
  expect(within(categories).getByText('Grooming').parentElement).toHaveTextContent('Grooming4.6 / 5');
  expect(screen.getByText('Review history')).toBeInTheDocument();
  expect(screen.getByText(/Professional and helpful/)).toBeInTheDocument();
  // Only segments with reviews are drawn.
  expect(document.querySelectorAll('.sr-arc')).toHaveLength(3);
});

it('the Venue Manager filter re-queries the server and the figures change (not just the labels)', async () => {
  mount();
  await screen.findByText('10 reviews · 2 managers');
  await userEvent.click(screen.getByRole('button', { name: /Venue manager: All venue managers/ }));
  const list = screen.getByRole('listbox', { name: 'Venue managers' });
  expect(within(list).getByRole('option', { name: /Alex Morgan/ })).toHaveTextContent('The Dorchester · No reviews'); // real zero
  await userEvent.type(screen.getByRole('textbox', { name: 'Search venue manager' }), 'sar');
  await userEvent.click(within(list).getByRole('option', { name: /Sarah Mitchell/ }));
  await waitFor(() =>
    expect(get).toHaveBeenLastCalledWith('/staff/staff-1/reviews', { params: { reviewer: 'sarah' } }),
  );
  expect(await screen.findByText('6 reviews · 1 manager')).toBeInTheDocument();
  expect(screen.getByText("Sarah's average scores")).toBeInTheDocument();
  expect(screen.getByText('Reviews from Sarah')).toBeInTheDocument();
});

it('the date range is sent to the server', async () => {
  mount();
  await screen.findByText('10 reviews · 2 managers');
  const range = screen.getByRole('combobox', { name: 'Date range' });
  expect(range).toHaveTextContent('All time');
  await userEvent.click(range);
  const menu = screen.getByRole('listbox', { name: 'Date range' });
  expect(within(menu).getByRole('option', { name: 'All time' })).toHaveAttribute('aria-selected', 'true');
  await userEvent.click(within(menu).getByRole('option', { name: 'Last month' }));
  // The menu plays its exit (fade/rise) before unmounting.
  await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Date range' })).toBeNull());
  expect(range).toHaveTextContent('Last month');
  await waitFor(() => expect(get).toHaveBeenLastCalledWith('/staff/staff-1/reviews', { params: { range: 'last_month' } }));
  // Keyboard: ArrowDown moves from the selected row, Enter chooses.
  range.focus();
  await userEvent.keyboard('{ArrowDown}');
  await userEvent.keyboard('{ArrowDown}');
  await userEvent.keyboard('{Enter}');
  expect(range).toHaveTextContent('Custom range');
  await userEvent.type(screen.getByLabelText('From'), '2026-10-01');
  await waitFor(() =>
    expect(get).toHaveBeenLastCalledWith('/staff/staff-1/reviews', { params: { range: 'custom', from: '2026-10-01' } }),
  );
});

it('opens the individual shift review and goes back', async () => {
  mount();
  await userEvent.click(await screen.findByRole('button', { name: /View review by Sarah Mitchell/ }));
  expect(await screen.findByRole('heading', { name: 'Shift review' })).toBeInTheDocument();
  expect(screen.getByText('Reviewed by Sarah Mitchell')).toBeInTheDocument();
  expect(screen.getByText(/1 Poor · 2 Needs improvement/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Back to reviews/ }));
  expect(await screen.findByText('Review history')).toBeInTheDocument();
});

it('no reviews: clear empty state, no invented numbers', async () => {
  get.mockResolvedValue({
    data: { ...base, reviewers: [], total: 0, reviewerCount: 0, average: null, history: [],
      distribution: base.distribution.map((d) => ({ ...d, count: 0, percent: 0 })),
      categories: { grooming: null, attitude: null, skills: null, attendance: null, timeKeeping: null } },
  });
  mount();
  expect(await screen.findByText(/No reviews yet\. Reviews appear here/)).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'No reviews yet' })).toBeInTheDocument();
  expect(document.querySelectorAll('.sr-arc')).toHaveLength(0);
  expect(screen.getAllByText('— / 5')).toHaveLength(5);
});

it('an authorization failure shows an error, never a fake empty chart', async () => {
  get.mockRejectedValue(Object.assign(new Error('Not found'), { response: { status: 404 } }));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Staff reviews could not be loaded.');
  expect(screen.queryByRole('img')).toBeNull();
});
