import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { api } from '../../../shared/api';
import { renderWithQuery, routeGet } from './adminPanelTestKit';
import HealthTab, { HEALTH_REFETCH_MS } from './HealthTab';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

const queues = {
  mode: 'interval',
  metrics: { available: false, reason: 'WORKER_METRICS_DISABLED' },
  worker: { heartbeatAgeSeconds: 4, stale: false, scheduler: null },
  cycles: [{ source: 'worker', loop: 'offer-expiry', runs: 3, p50Ms: 9, p95Ms: 85, maxMs: 85, lastMs: 8, succeeded: 3, idle: 0, failed: 0, skipped: 0, measuredAt: '2026-10-24T09:00:00Z' }],
  lastRuns: [],
  queues: [
    { name: 'rab-email', kind: 'consumer', counts: { failed: 2, active: 0, waiting: 0, delayed: 0, completed: 5 }, actions: { retry: ['failed'], delete: [], lockedReason: null } },
    { name: 'rab-push', kind: 'consumer', counts: { failed: 0 }, actions: { retry: ['failed'], delete: [], lockedReason: null } },
    { name: 'rab-shift-statements', kind: 'consumer', counts: { failed: 1 }, actions: { retry: [], delete: [], lockedReason: 'Payroll statements cannot be retried or deleted from here.' } },
  ],
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  routeGet(get, {
    '/admin/health/report': {
      checkedAt: new Date().toISOString(),
      attention: 1,
      cards: [
        { key: 'database', status: 'healthy', detail: 'PostgreSQL · 18 ms · pool 4 of 10 in use', latencyMs: 18 },
        { key: 'redis', status: 'warning', detail: 'Reachable · 1 ms · no password set', latencyMs: 1 },
      ],
    },
    '/admin/queues': queues,
    '/admin/queues/rab-email/jobs': { total: 1, items: [{ id: 'email-outbox.e1.attempt.0', name: 'send', state: 'failed', createdAt: null, processedAt: null, finishedAt: '2026-10-24T09:14:00Z', attemptsMade: 5, maxAttempts: 5, errorClass: 'PROVIDER_429', organisationId: null, entityId: null, scheduler: false }] },
    '/admin/outbox/failed': [
      { kind: 'email', id: 'e1', organisationId: 'o1', workspaceId: null, type: 'NOTIFICATION', attempts: 5, lastErrorCode: 'PROVIDER_429', failedAt: '2026-10-24T09:14:00Z', createdAt: '2026-10-24T09:00:00Z', replayable: true },
      { kind: 'push', id: 'p1', organisationId: 'o1', workspaceId: null, type: 'PUSH', attempts: 1, lastErrorCode: 'DEVICE_UNREGISTERED', failedAt: null, createdAt: '2026-10-24T09:00:00Z' },
    ],
  });
});

it('polls every 15 seconds', () => {
  expect(HEALTH_REFETCH_MS).toBe(15_000);
});

it('health cards come from the server report (status pill + fixed detail text)', async () => {
  renderWithQuery(<HealthTab />);
  expect(await screen.findByText('PostgreSQL · 18 ms · pool 4 of 10 in use')).toBeTruthy();
  expect(screen.getByText('Healthy')).toBeTruthy();
  expect(screen.getByText('Warning')).toBeTruthy();
});

it('the chart honestly says "Metrics unavailable" and the range buttons are disabled — no numbers made up from counts', async () => {
  renderWithQuery(<HealthTab />);
  expect(await screen.findByRole('img', { name: 'Metrics unavailable' })).toBeTruthy();
  for (const r of ['1H', '4H', '12H', '1D', '7D']) expect((screen.getByRole('button', { name: r }) as HTMLButtonElement).disabled).toBe(true);
});

it('jobs table shows ids + safe error class; retry runs step-up first (when a password is typed) then the retry with the ids and reason', async () => {
  post.mockResolvedValue({ data: { queue: 'rab-email', done: ['email-outbox.e1.attempt.0'], skipped: [] } });
  renderWithQuery(<HealthTab />);
  const row = (await screen.findByText('email-outbox.e1.attempt.0')).closest('tr')!;
  expect(within(row).getByText('PROVIDER_429')).toBeTruthy();
  fireEvent.click(within(row).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Retry selected' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Reason (saved to the audit log)'), { target: { value: 'Rate limit cleared' } });
  fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'pw' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/queues/rab-email/jobs/retry', { jobIds: ['email-outbox.e1.attempt.0'], reason: 'Rate limit cleared' }));
  expect(post.mock.calls[0]).toEqual(['/auth/step-up', { currentPassword: 'pw' }]);
});

it('D7: Delete is never available on rab-email; nothing at all on rab-shift-statements', async () => {
  renderWithQuery(<HealthTab />);
  await screen.findByText('email-outbox.e1.attempt.0');
  expect((screen.getByRole('button', { name: 'Delete selected' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /rab-shift-statements/ }));
  expect((screen.getByRole('button', { name: 'Retry selected' }) as HTMLButtonElement).title).toBe('Payroll statements cannot be retried or deleted from here.');
});

it('worker cycles table (interval mode) and failed outbox: replay only for replayable emails', async () => {
  renderWithQuery(<HealthTab />);
  expect(await screen.findByText('offer-expiry')).toBeTruthy();
  const pushRow = (await screen.findByText('DEVICE_UNREGISTERED')).closest('tr')!;
  expect((within(pushRow).getByRole('button', { name: 'Replay' }) as HTMLButtonElement).disabled).toBe(true);
  const emailRow = screen.getAllByText('PROVIDER_429').map((n) => n.closest('tr')!).find((r) => within(r).queryByText('Email'))!;
  expect((within(emailRow).getByRole('button', { name: 'Replay' }) as HTMLButtonElement).disabled).toBe(false);
});
