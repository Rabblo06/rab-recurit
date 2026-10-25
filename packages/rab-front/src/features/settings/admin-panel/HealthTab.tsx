import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { toast } from '../../../shared/lib/toast';
import AdminActionDialog from './AdminActionDialog';
import { ADMIN_ERROR_TEXT, METRICS_RANGES, adminApi, formatDateTime, metricsSummary, shortId, type HealthCard, type HealthStatus, type JobState, type MetricsRange, type QueueSummary } from './adminPanelApi';

const QueueMetricsChart = lazy(() => import('./QueueMetricsChart'));

export const HEALTH_REFETCH_MS = 15_000;

const CARD_LABEL: Record<HealthCard['key'], string> = { database: 'Database', redis: 'Redis', worker: 'Worker', provisioner: 'Provisioner', email: 'Email', storage: 'File storage' };
const STATUS_PILL: Record<HealthStatus, [string, string]> = {
  healthy: ['ap-ok', 'Healthy'],
  warning: ['ap-warn', 'Warning'],
  degraded: ['ap-bad', 'Degraded'],
  unavailable: ['ap-bad', 'Unavailable'],
};
const STATES: Array<{ id: JobState; label: string }> = [
  { id: 'failed', label: 'Failed' },
  { id: 'active', label: 'Active' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'delayed', label: 'Delayed' },
  { id: 'completed', label: 'Completed' },
];
/** The server caches each metrics answer ~30 s; polling faster would only re-read the cache. */
export const METRICS_REFETCH_MS = 30_000;

function secondsAgo(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s} second${s === 1 ? '' : 's'} ago` : `${Math.round(s / 60)} min ago`;
}

/**
 * Admin panel → Health (mockup v2). Probes, queues and the outbox refetch every 15 s while the tab is visible. The chart
 * shows completed vs failed jobs per bucket from the Workers' BullMQ metrics (`GET /admin/queues/:queue/metrics`,
 * 1H per minute, 4H/12H/1D/7D per hour, refetched every 30 s); with no recorded point it says "Metrics unavailable" and
 * never draws numbers made up from counts. Job DATA is never shown: ids, attempts and a safe error class only.
 */
export default function HealthTab() {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const health = useQuery({ queryKey: ['admin', 'health'], queryFn: adminApi.health, refetchInterval: HEALTH_REFETCH_MS });
  const queues = useQuery({ queryKey: ['admin', 'queues'], queryFn: adminApi.queues, refetchInterval: HEALTH_REFETCH_MS });
  const outbox = useQuery({ queryKey: ['admin', 'outbox'], queryFn: adminApi.failedOutbox, refetchInterval: HEALTH_REFETCH_MS });

  const [queueName, setQueueName] = useState('rab-email');
  const [state, setState] = useState<JobState>('failed');
  const [range, setRange] = useState<MetricsRange>('1D');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<'retry' | 'delete' | { replay: { organisationId: string; id: string } } | null>(null);
  const queue: QueueSummary | undefined = queues.data?.queues?.find((q) => q.name === queueName) ?? queues.data?.queues?.[0];
  const jobs = useQuery({
    queryKey: ['admin', 'jobs', queue?.name, state],
    queryFn: () => adminApi.jobs(queue!.name, state),
    enabled: Boolean(queue),
    refetchInterval: HEALTH_REFETCH_MS,
  });
  const metrics = useQuery({
    queryKey: ['admin', 'queue-metrics', queue?.name, range],
    queryFn: () => adminApi.queueMetrics(queue!.name, range),
    enabled: Boolean(queue),
    refetchInterval: METRICS_REFETCH_MS,
  });
  useEffect(() => setSelected(new Set()), [queue?.name, state]);

  const canRetry = Boolean(queue?.actions.retry.includes(state));
  const canDelete = Boolean(queue?.actions.delete.includes(state));
  const jobItems = useMemo(() => (jobs.data?.items ?? []).filter((j) => !j.scheduler), [jobs.data]);
  const allSelected = jobItems.length > 0 && jobItems.every((j) => selected.has(j.id));

  /** Background refresh of the Health tab's own data after a confirmed action (never awaited before the feedback). */
  const refreshHealth = () => {
    for (const key of ['health', 'queues', 'outbox', 'jobs', 'queue-metrics']) void qc.invalidateQueries({ queryKey: ['admin', key] });
  };

  return (
    <>
      <section className="ap-block" aria-label="System health">
        <div className="ap-block-head">
          <h2 className="ap-h2">System health</h2>
          <span className="ap-muted" style={{ font: 'var(--text-small)' }}>
            {health.data ? `Checked ${secondsAgo(health.data.checkedAt, now)}` : health.isError ? 'Health could not be checked' : 'Checking…'} ·{' '}
            <button type="button" className="ap-btn ap-sm" onClick={() => void health.refetch()} disabled={health.isFetching}>{health.isFetching ? 'Checking…' : 'Refresh'}</button>
          </span>
        </div>
        <div className="ap-grid-3">
          {(health.data?.cards ?? []).map((c) => (
            <div key={c.key} className="ap-card ap-indicator">
              <b>{CARD_LABEL[c.key]}</b>
              <span className={`ap-pill ${STATUS_PILL[c.status][0]}`}>{STATUS_PILL[c.status][1]}</span>
              <p>{c.detail}</p>
            </div>
          ))}
          {!health.data?.cards && (
            <div className="ap-card ap-indicator"><b>Health</b><span className="ap-pill">{health.isError ? 'Unavailable' : 'Checking'}</span><p>{health.isError ? 'The health report could not be loaded.' : 'Running checks…'}</p></div>
          )}
        </div>
      </section>

      <section className="ap-block" aria-label="Worker queues">
        <div className="ap-block-head">
          <h2 className="ap-h2">Worker queues</h2>
          <div className="ap-seg" role="group" aria-label="Time range">
            {METRICS_RANGES.map((r) => (
              <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>{r}</button>
            ))}
          </div>
        </div>
        <div className="ap-pills" role="group" aria-label="Queues">
          {(queues.data?.queues ?? []).map((q) => (
            <button key={q.name} type="button" aria-pressed={q.name === queue?.name} onClick={() => setQueueName(q.name)}>
              {q.name}
              {q.counts === null ? <span className="ap-f">unavailable</span> : q.counts.failed ? <span className="ap-f">{q.counts.failed} failed</span> : null}
            </button>
          ))}
          {queues.isError && <span className="ap-muted">Queues could not be loaded.</span>}
        </div>
        <p className="ap-callout">
          {queues.data?.mode === 'bullmq'
            ? 'Scan queues (crewflow-scan-*) are listed because a WORKER_SCHEDULER=bullmq worker is running.'
            : 'Scan queues (crewflow-scan-*) appear only when WORKER_SCHEDULER=bullmq. The worker runs in interval mode: see Worker cycles below.'}{' '}
          The chart reads the Workers’ BullMQ metrics (one-minute points, kept for 7 days).
        </p>
        <div className="ap-card">
          <div className="ap-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <div><b>{queue?.name ?? '—'}</b> <span className="ap-muted">· {metrics.data?.available ? metricsSummary(metrics.data) : 'completed vs failed'}</span></div>
            <div className="ap-legend"><span><i style={{ background: 'var(--chart-3)' }} />Completed</span><span><i style={{ background: 'var(--feedback-error)' }} />Failed</span></div>
          </div>
          {metrics.data?.available ? (
            <Suspense fallback={<div className="ap-chart-empty" aria-busy="true"><div>Loading chart…</div></div>}>
              <QueueMetricsChart metrics={metrics.data} />
            </Suspense>
          ) : (queue ? metrics.isLoading : queues.isLoading) ? (
            <div className="ap-chart-empty" aria-busy="true"><div>Loading metrics…</div></div>
          ) : (
            <div className="ap-chart-empty" role="img" aria-label="Metrics unavailable">
              <div>
                <b>Metrics unavailable</b>
                <div>
                  {metrics.isError || metrics.data?.reason === 'UNAVAILABLE'
                    ? 'The queue metrics could not be read right now. Current counts are in the queue list and the jobs table.'
                    : 'No completed or failed job has been recorded for this queue yet. Current counts are in the queue list and the jobs table.'}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="ap-block-head" style={{ marginTop: 8 }}>
          <h3 className="ap-h3">Jobs</h3>
          <div className="ap-row">
            <div className="ap-seg" role="group" aria-label="Job state">
              {STATES.map((s) => (
                <button key={s.id} type="button" aria-pressed={state === s.id} onClick={() => setState(s.id)}>
                  {s.label}{queue?.counts?.[s.id] ? ` · ${queue.counts[s.id]}` : ''}
                </button>
              ))}
            </div>
            <button type="button" className="ap-btn ap-sm" disabled={!canRetry || selected.size === 0} title={canRetry ? undefined : queue?.actions.lockedReason ?? 'Retry is available for failed jobs only.'} onClick={() => setDialog('retry')}>
              Retry selected
            </button>
            <button type="button" className="ap-btn ap-sm ap-danger" disabled={!canDelete || selected.size === 0} title={canDelete ? undefined : queue?.actions.lockedReason ?? 'Delete is not available on this queue.'} onClick={() => setDialog('delete')}>
              Delete selected
            </button>
          </div>
        </div>
        <div className="ap-tablewrap">
          <table className="ap-table">
            <thead>
              <tr>
                <th><input type="checkbox" aria-label="Select all jobs" checked={allSelected} disabled={!(canRetry || canDelete) || jobItems.length === 0} onChange={(e) => setSelected(e.target.checked ? new Set(jobItems.map((j) => j.id)) : new Set())} /></th>
                <th>Job ID</th><th>Job</th><th>Organisation</th><th className="ap-num">Attempts</th><th>{state === 'failed' ? 'Failed' : 'Updated'}</th><th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {jobs.isLoading ? (
                <tr><td colSpan={7} className="ap-empty">Loading jobs…</td></tr>
              ) : jobs.data?.total === null ? (
                <tr><td colSpan={7} className="ap-empty">This queue is not reachable right now.</td></tr>
              ) : jobItems.length === 0 ? (
                <tr><td colSpan={7} className="ap-empty">No {state} jobs in this queue.</td></tr>
              ) : (
                jobItems.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${j.id}`}
                        disabled={!(canRetry || canDelete)}
                        checked={selected.has(j.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(j.id);
                          else next.delete(j.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td className="ap-mono">{j.id}</td>
                    <td>{j.name}</td>
                    <td className="ap-mono" title={j.organisationId ?? undefined}>{j.organisationId ? shortId(j.organisationId) : '—'}</td>
                    <td className="ap-num">{j.attemptsMade}{j.maxAttempts ? ` / ${j.maxAttempts}` : ''}</td>
                    <td>{formatDateTime(j.finishedAt ?? j.processedAt ?? j.createdAt)}</td>
                    <td className="ap-muted ap-mono">{j.errorClass ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="ap-callout">Job data is never shown here: IDs and a safe error class only. Retry and delete need step-up and a reason, and are audited. Nothing can be retried or deleted on rab-shift-statements (payroll).</p>
      </section>

      <section className="ap-block" aria-label="Worker cycles">
        <div className="ap-block-head">
          <h2 className="ap-h2">Worker cycles</h2>
          <p className="ap-sub">
            {queues.data?.worker
              ? `Heartbeat ${queues.data.worker.heartbeatAgeSeconds === null ? 'not seen' : `${queues.data.worker.heartbeatAgeSeconds} s ago`}${queues.data.worker.stale ? ' (stale)' : ''} · scheduler: ${queues.data.mode}`
              : 'Loop durations reported by the worker (last 1,024 runs per loop).'}
          </p>
        </div>
        <div className="ap-tablewrap">
          <table className="ap-table">
            <thead><tr><th>Process</th><th>Loop</th><th className="ap-num">Runs</th><th className="ap-num">p50</th><th className="ap-num">p95</th><th className="ap-num">Max</th><th className="ap-num">Failed</th><th className="ap-num">Skipped</th><th>Measured</th></tr></thead>
            <tbody>
              {!queues.data?.cycles?.length ? (
                <tr><td colSpan={9} className="ap-empty">{queues.isLoading ? 'Loading…' : 'No cycle durations reported yet.'}</td></tr>
              ) : (
                queues.data.cycles.map((c) => (
                  <tr key={`${c.source}:${c.loop}`}>
                    <td className="ap-muted">{c.source === 'worker' ? 'Jobs' : 'Provisioner'}</td>
                    <td className="ap-mono">{c.loop}</td>
                    <td className="ap-num">{c.runs}</td>
                    <td className="ap-num">{c.p50Ms ?? '—'}{c.p50Ms !== null ? ' ms' : ''}</td>
                    <td className="ap-num">{c.p95Ms ?? '—'}{c.p95Ms !== null ? ' ms' : ''}</td>
                    <td className="ap-num">{c.maxMs ?? '—'}{c.maxMs !== null ? ' ms' : ''}</td>
                    <td className="ap-num">{c.failed}</td>
                    <td className="ap-num">{c.skipped}</td>
                    <td className="ap-muted">{formatDateTime(c.measuredAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ap-block" aria-label="Failed outbox messages">
        <div className="ap-block-head">
          <h2 className="ap-h2">Failed outbox messages</h2>
          <p className="ap-sub">Emails and pushes that ran out of retries. Replay sends one message exactly once.</p>
        </div>
        <div className="ap-tablewrap">
          <table className="ap-table">
            <thead><tr><th>Kind</th><th>Message ID</th><th>Organisation</th><th>Template</th><th>Error</th><th>Failed</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {outbox.isLoading ? (
                <tr><td colSpan={7} className="ap-empty">Loading…</td></tr>
              ) : outbox.isError ? (
                <tr><td colSpan={7} className="ap-empty">Failed messages could not be loaded.</td></tr>
              ) : !Array.isArray(outbox.data) || !outbox.data.length ? (
                <tr><td colSpan={7} className="ap-empty">No failed messages.</td></tr>
              ) : (
                outbox.data.map((m) => {
                  const replayable = m.kind === 'email' && m.replayable === true;
                  const why = m.kind !== 'email' ? 'Replay is available for emails only.' : !m.replayable ? 'Permanent failure: fix the address first, or the email carried a one-time link that was cleared.' : undefined;
                  return (
                    <tr key={`${m.kind}:${m.id}`}>
                      <td>{m.kind === 'email' ? 'Email' : m.kind === 'push' ? 'Push' : m.kind === 'realtime' ? 'Realtime' : 'Worker event'}</td>
                      <td className="ap-mono" title={m.id}>{shortId(m.id)}</td>
                      <td className="ap-mono" title={m.organisationId}>{shortId(m.organisationId)}</td>
                      <td>{m.type ?? '—'}</td>
                      <td className="ap-mono">{m.lastErrorCode ?? '—'}</td>
                      <td>{formatDateTime(m.failedAt)}</td>
                      <td>
                        <button type="button" className="ap-btn ap-sm" disabled={!replayable} title={why} onClick={() => setDialog({ replay: { organisationId: m.organisationId, id: m.id } })}>Replay</button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {(dialog === 'retry' || dialog === 'delete') && queue && (
        <AdminActionDialog
          title={dialog === 'retry' ? 'Retry failed jobs' : 'Delete jobs'}
          body={
            dialog === 'retry'
              ? `Puts the ${selected.size} selected job${selected.size === 1 ? '' : 's'} back on ${queue.name}. Each job keeps its ID, so it cannot run twice at the same time.`
              : `Removes the ${selected.size} selected job${selected.size === 1 ? '' : 's'} from ${queue.name}.`
          }
          confirmLabel={dialog === 'retry' ? 'Retry' : 'Delete jobs'}
          tone={dialog === 'delete' ? 'danger' : 'primary'}
          errorText={ADMIN_ERROR_TEXT}
          failureText={dialog === 'retry' ? 'Could not retry the selected jobs. Please try again.' : 'Could not delete the selected jobs. Please try again.'}
          onConfirm={async ({ reason, currentPassword, code }) => {
            await adminApi.stepUpIfGiven({ currentPassword, code });
            const ids = [...selected];
            const result = dialog === 'retry' ? await adminApi.retryJobs(queue.name, ids, reason) : await adminApi.deleteJobs(queue.name, ids, reason);
            setSelected(new Set());
            const verb = dialog === 'retry' ? 'queued for retry' : 'deleted';
            // Nothing done is not a success; some skipped is a partial result the admin should read.
            if (result.done.length === 0) toast.warning(`No job was ${verb}: ${result.skipped.length} no longer eligible. The list is refreshed.`);
            else if (result.skipped.length) toast.warning(`${result.done.length} job${result.done.length === 1 ? '' : 's'} ${verb} · ${result.skipped.length} skipped (no longer eligible)`);
            else toast.success(`${result.done.length} job${result.done.length === 1 ? '' : 's'} ${verb}`);
            setDialog(null);
            refreshHealth();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog && typeof dialog === 'object' && 'replay' in dialog && (
        <AdminActionDialog
          title="Replay this email"
          body={`Sends message ${shortId(dialog.replay.id)} again, exactly once. The original row is kept for the record.`}
          confirmLabel="Replay"
          errorText={ADMIN_ERROR_TEXT}
          failureText="Could not replay this email. Please try again."
          onConfirm={async ({ reason, currentPassword, code }) => {
            await adminApi.stepUpIfGiven({ currentPassword, code });
            await adminApi.replayEmail(dialog.replay.organisationId, dialog.replay.id, reason);
            toast.success('Email queued for replay');
            setDialog(null);
            refreshHealth();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
