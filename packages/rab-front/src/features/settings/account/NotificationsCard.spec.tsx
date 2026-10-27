import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../../shared/api';
import { TOAST_EVENT, type ToastDetail } from '../../../shared/lib/toast';
import NotificationsCard from './NotificationsCard';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), patch: jest.fn() } }));

/**
 * Feedback follow-up (FEEDBACK_REPORT §6, Account items 1-3): each toggle sends only the changed field, toggles on one
 * row are serialised (the server's update is a read-modify-write of both columns), the checkbox moves only on the
 * server's answer, and a failure is one red toast with the reason and "Try again".
 */
const get = api.get as jest.Mock;
const patch = api.patch as jest.Mock;
const httpError = (status: number, data: unknown = {}) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data } });

let rows: Array<{ notificationType: string; inAppEnabled: boolean; emailEnabled: boolean }>;
let toasts: ToastDetail[] = [];
const onToast = (e: Event) => toasts.push((e as CustomEvent<ToastDetail>).detail);

beforeEach(() => {
  toasts = [];
  document.addEventListener(TOAST_EVENT, onToast);
  rows = [
    { notificationType: 'offer_sent', inAppEnabled: true, emailEnabled: false },
    { notificationType: 'offer_expired', inAppEnabled: true, emailEnabled: true },
  ];
  get.mockReset().mockImplementation(async () => ({ data: rows.map((r) => ({ ...r })) }));
  patch.mockReset();
});
afterEach(() => document.removeEventListener(TOAST_EVENT, onToast));

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <NotificationsCard />
    </QueryClientProvider>,
  );
}
const box = (channel: 'In-app' | 'Email', row = 'An offer is sent to me') => screen.getByRole('checkbox', { name: `${channel}: ${row}` });

it('item 3: a toggle sends ONLY the changed field (never a stale copy of the whole row)', async () => {
  mount();
  patch.mockResolvedValueOnce({ data: { notificationType: 'offer_sent', inAppEnabled: true, emailEnabled: true } });
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Email: An offer is sent to me' }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(patch).toHaveBeenCalledWith('/profile/notification-preferences', { notificationType: 'offer_sent', emailEnabled: true });
});

it('item 2: while a PATCH runs the row is locked ("Saving…"), a quick second toggle on that row sends nothing; the box moves only on the server answer', async () => {
  mount();
  let answer: (v: unknown) => void = () => undefined;
  patch.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'In-app: An offer is sent to me' }));
  expect(await screen.findByText('Saving…')).toBeInTheDocument();
  expect(box('In-app')).toBeDisabled();
  expect(box('In-app')).toBeChecked(); // not moved yet: the server has not answered
  expect(box('Email')).toBeDisabled(); // the other channel of the SAME row waits (serialised)
  expect(box('In-app', 'An offer I sent expires unanswered')).toBeEnabled(); // other rows are independent
  fireEvent.click(box('Email'));
  expect(patch).toHaveBeenCalledTimes(1);
  expect(toasts).toEqual([]);
  rows[0] = { ...rows[0]!, inAppEnabled: false };
  answer({ data: { notificationType: 'offer_sent', inAppEnabled: false, emailEnabled: false } });
  await waitFor(() => expect(box('In-app')).not.toBeChecked());
  expect(box('In-app')).toBeEnabled();
  expect(box('Email')).toBeEnabled();
  expect(toasts).toEqual([expect.objectContaining({ variant: 'success', message: 'Notification preference saved.' })]);
});

it('item 1: a failure is one red toast with the server-aware reason and "Try again" (same field + value); the box stays as the server has it', async () => {
  mount();
  patch.mockRejectedValueOnce(httpError(503, { message: 'Internal server error' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Email: An offer is sent to me' }));
  await waitFor(() => expect(toasts).toHaveLength(1));
  expect(toasts[0]).toMatchObject({ variant: 'error', message: 'Could not save that preference. Please try again.' });
  expect(toasts[0]!.action?.label).toBe('Try again');
  expect(box('Email')).not.toBeChecked();
  expect(box('Email')).toBeEnabled();
  patch.mockResolvedValueOnce({ data: { notificationType: 'offer_sent', inAppEnabled: true, emailEnabled: true } });
  toasts[0]!.action!.onClick();
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch).toHaveBeenLastCalledWith('/profile/notification-preferences', { notificationType: 'offer_sent', emailEnabled: true });
});

it('item 1: a validation refusal shows the server’s safe text, never the hard-coded string', async () => {
  mount();
  patch.mockRejectedValueOnce(httpError(400, { message: 'This notification can’t be turned off for your role.' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'In-app: An offer is sent to me' }));
  await waitFor(() => expect(toasts).toHaveLength(1));
  expect(toasts[0]!.message).toBe('This notification can’t be turned off for your role.');
  expect(toasts[0]!.action).toBeUndefined(); // repeating can't help
});
