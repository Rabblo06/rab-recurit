import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CONFIRMATION_DEADLINE_MESSAGES } from '@rab/shared';
import { api } from '../../shared/api';
import StaffSelectionPage from './StaffSelectionPage';

/** A send the server refuses because the shift starts in under 30 minutes shows the server's reason, not the generic 409 text. */
jest.mock('../../shared/api', () => ({ api: { get: jest.fn(), put: jest.fn(), post: jest.fn() } }));
const mock = api as unknown as Record<'get' | 'put' | 'post', jest.Mock>;
const row = { id: 'alpha', firstName: 'Alpha', lastName: 'Staff', staffRef: 'A1', email: 'a@example.test', phone: null, defaultPayRatePence: null, accountStatus: 'active', employmentStatus: 'active', createdAt: '2026-09-01T00:00:00Z', available: true };

beforeEach(() => {
  Object.values(mock).forEach((m) => m.mockReset());
  mock.get.mockResolvedValue({ data: { data: [row], total: 1 } });
});

async function sendReplacement() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <StaffSelectionPage mode="replacement" shiftId="shift-1" requiredCount={1} initialStaff={[]} onCancel={() => {}} onConfirmed={async () => {}} />
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Alpha Staff' }));
  await userEvent.click(screen.getByRole('button', { name: 'Send offers' }));
  await waitFor(() => expect(mock.post).toHaveBeenCalledWith('/shifts/shift-1/pipeline/replacements', expect.anything()));
}

it('409 CONFIRMATION_DEADLINE_PASSED on a send shows the server SEND refusal', async () => {
  mock.post.mockRejectedValue({ response: { status: 409, data: { statusCode: 409, code: 'CONFIRMATION_DEADLINE_PASSED', message: CONFIRMATION_DEADLINE_MESSAGES.SEND } } });
  await sendReplacement();
  expect(await screen.findByRole('alert')).toHaveTextContent(CONFIRMATION_DEADLINE_MESSAGES.SEND);
  expect(screen.queryByText(/Someone else changed this selection/)).toBeNull();
});

it('any other 409 keeps the existing "someone else changed this selection" text', async () => {
  mock.post.mockRejectedValue({ response: { status: 409, data: { statusCode: 409, message: 'Stale selection.' } } });
  await sendReplacement();
  expect(await screen.findByRole('alert')).toHaveTextContent(/Someone else changed this selection/);
});
