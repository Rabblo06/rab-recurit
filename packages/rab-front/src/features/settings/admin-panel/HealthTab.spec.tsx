import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { api } from '../../../shared/api';
import { renderWithQuery, routeGet } from './adminPanelTestKit';
import HealthTab, { HEALTH_REFETCH_MS, METRICS_REFETCH_MS } from './HealthTab';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

const queues = {
  mode: 'interval',
  metrics: { collected: true, retentionMinutes: 10080 },
  worker: { heartbeatAgeSeconds: 4, stale: false, scheduler: null },
  cycles: [{ source: 'worker', loop: 'offer-expiry', runs: 3, p50Ms: 9, p95Ms: 85, maxMs: 85, lastMs: 8, succeeded: 3, idle: 0, failed: 0, skipped: 0, measuredAt: '2026-10-24T09:00:00Z' }],
  lastRuns: [],
  queues: [
    { name: 'rab-email', kind: 'consumer', counts: { failed: 2, active: 0, waiting: 0, delayed: 0, completed: 5 }, actions: { retry: ['failed'], delete: [], lockedReason: null } },
    { name: 'rab-push', kind: 'consumer', counts: { failed: 0 }, actions: { retry: ['failed'], delete: [], lockedReason: null } },
    { name: 'rab-shift-statements', kind: 'consumer', counts: { failed: 1 }, actions: { retry: [], delete: [], lockedReason: 'Payroll statements cannot be retried or deleted from here.' } },
  ],
};

const hourly = (n: number, at: (i: number) => { completed: number; failed: number }) =>
  Array.from({ length: n }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, 24, 13 + i)).toISOString(), ...at(i) }));
function metricsFor(range: string, available: boolean) {
  const count = { '1H': 60, '4H': 4, '12H': 12, '1D': 24, '7D': 168 }[range]!;
  const buckets = hourly(count, (i) => (available ? { completed: 10 + i, failed: i === count - 1 ? 3 : 0 } : { completed: 0, failed: 0 }));
  const completed = buckets.reduce((t, b) => t + b.completed, 0);
  const failed = buckets.reduce((t, b) => t + b.failed, 0);
  return { queue: 'rab-email', range, bucketMinutes: range === '1H' ? 1 : 60, from: buckets[0]!.at, to: buckets[count - 1]!.at, available, reason: available ? null : 'NO_DATA', buckets, totals: { completed, failed }, generatedAt: new Date().toISOString() };
}
let metricsAvailable = false;

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  metricsAvailable = false;
  routeGet(get, {
    '/admin/queues/rab-email/metrics': (params?: Record<string, unknown>) => metricsFor(String(params?.range ?? '1D'), metricsAvailable),
    '/admin/queues/rab-shift-statements/metrics': (params?: Record<string, unknown>) => ({ ...metricsFor(String(params?.range ?? '1D'), false), queue: 'rab-shift-statements' }),
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

it('polls every 15 seconds (metrics every 30 s: the server caches them that long)', () => {
  expect(HEALTH_REFETCH_MS).toBe(15_000);
  expect(METRICS_REFETCH_MS).toBe(30_000);
});

it('health cards come from the server report (status pill + fixed detail text)', async () => {
  renderWithQuery(<HealthTab />);
  expect(await screen.findByText('PostgreSQL · 18 ms · pool 4 of 10 in use')).toBeTruthy();
  expect(screen.getByText('Healthy')).toBeTruthy();
  expect(screen.getByText('Warning')).toBeTruthy();
});

it('no recorded data point → "Metrics unavailable" (never numbers made up from counts); the ranges ask the server for that range', async () => {
  renderWithQuery(<HealthTab />);
  expect(await screen.findByRole('img', { name: 'Metrics unavailable' })).toBeTruthy();
  expect(screen.getByText(/No completed or failed job has been recorded for this queue yet/)).toBeTruthy();
  expect(get).toHaveBeenCalledWith('/admin/queues/rab-email/metrics', { params: { range: '1D' } });
  for (const r of ['1H', '4H', '12H', '1D', '7D']) expect((screen.getByRole('button', { name: r }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole('button', { name: '1D' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '7D' }));
  await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/queues/rab-email/metrics', { params: { range: '7D' } }));
  expect(screen.getByRole('button', { name: '7D' }).getAttribute('aria-pressed')).toBe('true');
});

it('with recorded metrics: the chart is drawn from the server buckets, the subtitle states the real totals and failure rate', async () => {
  metricsAvailable = true;
  renderWithQuery(<HealthTab />);
  // 24 hourly buckets: completed 10..33 (sum 516) + 3 failed in the last hour → 519 jobs, 0.6% failed.
  // The chart module (recharts) is lazy-loaded: allow for a slow first import under a parallel test run.
  const chart = await screen.findByRole('img', { name: 'rab-email completed and failed jobs, last 24 h · 519 jobs · 0.6% failed' }, { timeout: 15_000 });
  expect(chart).toBeTruthy();
  expect(screen.getByText('· last 24 h · 519 jobs · 0.6% failed')).toBeTruthy();
  expect(screen.queryByRole('img', { name: 'Metrics unavailable' })).toBeNull();
  // Switching queue asks for that queue's own metrics.
  fireEvent.click(screen.getByRole('button', { name: /rab-shift-statements/ }));
  await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/queues/rab-shift-statements/metrics', { params: { range: '1D' } }));
  expect(await screen.findByRole('img', { name: 'Metrics unavailable' })).toBeTruthy();
});

it('a metrics read the server could not answer says so (UNAVAILABLE), still no invented numbers', async () => {
  routeGet(get, {
    '/admin/health/report': { checkedAt: new Date().toISOString(), attention: 0, cards: [] },
    '/admin/queues': queues,
    '/admin/queues/rab-email/metrics': { ...metricsFor('1D', false), reason: 'UNAVAILABLE' },
    '/admin/queues/rab-email/jobs': { total: 0, items: [] },
    '/admin/outbox/failed': [],
  });
  renderWithQuery(<HealthTab />);
  expect(await screen.findByText(/The queue metrics could not be read right now/)).toBeTruthy();
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
