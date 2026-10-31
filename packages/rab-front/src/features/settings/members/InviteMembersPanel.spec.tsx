import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '../../../shared/api';
import InviteMembersPanel from './InviteMembersPanel';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
const get = api.get as jest.Mock;

const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
const invitation = (status: string) => ({
  id: 'inv-1', email: 'a@example.test', role: { id: 'role-1', name: 'Supervisor' }, status, sendCount: 1, maxSends: 3,
  expiresAt: future, lastSentAt: future, createdAt: future, invitedByName: null,
});

let status = 'queued';
let listFailure: number | null = null;
beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0.5); // jitter factor exactly 1
  status = 'queued';
  listFailure = null;
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url === '/member-invitations/assignable-roles') return { data: [{ id: 'role-1', name: 'Supervisor', permissionKeys: [] }] };
    if (listFailure) throw Object.assign(new Error(String(listFailure)), { response: { status: listFailure, headers: {} } });
    return { data: { data: [invitation(status)], total: 1, page: 1, limit: 10 } };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const tick = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
const listCalls = () => get.mock.calls.filter(([u]: [string]) => u.startsWith('/member-invitations?')).length;
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><InviteMembersPanel /></QueryClientProvider>);
  return qc;
}

it('Phase C1: a queued invitation is re-read on the settling backoff (2 → 4 → 8 → 15 s), not every 5 s', async () => {
  const qc = mount();
  await tick(20);
  expect(listCalls()).toBe(1);
  await tick(2_100);
  expect(listCalls()).toBe(2);
  await tick(3_000); // ≈ 5.1 s: the old 5 s poll would have run here
  expect(listCalls()).toBe(2);
  await tick(1_100); // ≈ 6.2 s
  expect(listCalls()).toBe(3);
  await tick(8_000); // ≈ 14.2 s
  expect(listCalls()).toBe(4);
  qc.clear();
});

it('stops when every invitation settles, and after 3 minutes even if one never does', async () => {
  const qc = mount();
  await tick(20);
  await tick(2_100);
  status = 'sent';
  await tick(4_100); // the 6 s read sees "sent"
  const settled = listCalls();
  await tick(120_000);
  expect(listCalls()).toBe(settled);
  qc.clear();
});

it('never polls past the 3-minute window', async () => {
  const qc = mount();
  await tick(20);
  await tick(200_000);
  const atWindowEnd = listCalls();
  expect(atWindowEnd).toBeLessThanOrEqual(16);
  await tick(600_000);
  expect(listCalls()).toBe(atWindowEnd);
  qc.clear();
});

it('a failed refresh keeps the invitations on screen; a permanent refusal (403) replaces them with the error', async () => {
  const qc = mount();
  await tick(20);
  expect(screen.getByText('a@example.test')).toBeInTheDocument();
  listFailure = 503;
  await tick(2_100);
  expect(listCalls()).toBe(2);
  expect(screen.getByText('a@example.test')).toBeInTheDocument();
  expect(screen.queryByText(/Invitations could not be loaded/)).not.toBeInTheDocument();
  listFailure = 403;
  await tick(10_000); // the 4 s settling step, doubled by the failure
  expect(listCalls()).toBe(3);
  expect(screen.getByText(/Invitations could not be loaded/)).toBeInTheDocument();
  expect(screen.queryByText('a@example.test')).not.toBeInTheDocument();
  qc.clear();
});
