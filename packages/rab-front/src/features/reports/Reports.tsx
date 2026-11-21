import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { REPORT_EXPORT_FILE_RETENTION_HOURS, REPORT_KEYS, REPORT_LABELS, ReportKey, reportIsPayOnly, reportTakesPeriod } from '@rab/shared';
import type { ReportExportErrorType, ReportExportSummary, ReportKeyType } from '@rab/shared';
import PageHeader from '../../shared/components/PageHeader';
import { capabilitiesQuery } from '../../shared/queries/navQueries';
import { fetchAllPages } from '../../shared/table-toolbar/pagination';
import { api } from '../../shared/api';
import { getApiErrorMessage } from '../../shared/lib/apiError';
import { toast } from '../../shared/lib/toast';
import { downloadExport, listExports, requestExport, type ReportExportRequest } from './reportsApi';
import './reports.css';

/** What each report holds, in plain words (shown under the picker). */
const REPORT_HELP: Record<ReportKeyType, string> = {
  hours_and_pay_by_venue: 'Shifts worked and hours per venue. Gross pay (recorded at clock-out) only if you can see pay.',
  attendance_exceptions: 'No-shows, late arrivals, missing clock-outs and clock-ins outside the venue area.',
  weekly_hours_per_staff: 'Hours per staff member per week (Monday to Sunday), with a warning above 48 hours.',
  fill_rate_by_venue: 'Positions filled and unfilled per venue, for published shifts.',
  payroll_run_summary: 'The payroll-provider summary of one payroll run.',
};

const FAILURE_TEXT: Record<ReportExportErrorType, string> = {
  too_large: 'Too large. Choose a shorter period or one venue.',
  not_found: 'The payroll run no longer exists.',
  build_failed: 'Could not be built. Try again.',
};

interface PeriodRunSummary {
  period: { id: string; start: string; end: string };
  run: { id: string; status: 'prepared' | 'finalised' } | null;
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const firstOfMonth = () => {
  const d = new Date();
  return isoDay(new Date(d.getFullYear(), d.getMonth(), 1));
};
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function statusText(e: ReportExportSummary): string {
  switch (e.status) {
    case 'pending':
      return 'Building…';
    case 'ready':
      return e.fileExpiresAt ? `Ready · deleted ${fmtTime(e.fileExpiresAt)}` : 'Ready';
    case 'failed':
      return `Failed: ${e.errorCode ? FAILURE_TEXT[e.errorCode] : 'try again.'}`;
    case 'expired':
      return 'File deleted';
    default:
      return e.status;
  }
}

/**
 * Owner decision 29, reports page v1. Pick a report, a period and (optionally) a venue; Export starts a background job
 * and the list below shows when it is ready (also an in-app notice). Download asks the server for a single-use,
 * 60-second link each time; the file is deleted after 24 hours. Presentation only: what a user may export, which venues
 * and whether pay columns appear are decided and re-checked by the server.
 */
export default function Reports() {
  const queryClient = useQueryClient();
  const capabilities = useQuery(capabilitiesQuery);
  const canExport = capabilities.data?.['report.export'] === true;
  const canSeePay = capabilities.data?.['payroll.view'] === true;
  const keys = REPORT_KEYS.filter((k) => !reportIsPayOnly(k) || canSeePay);

  const [reportKey, setReportKey] = useState<ReportKeyType>(ReportKey.HOURS_AND_PAY_BY_VENUE);
  const [periodFrom, setPeriodFrom] = useState(firstOfMonth);
  const [periodTo, setPeriodTo] = useState(() => isoDay(new Date()));
  const [venueId, setVenueId] = useState('');
  const [payrollRunId, setPayrollRunId] = useState('');
  const takesPeriod = reportTakesPeriod(reportKey);

  const venues = useQuery({ queryKey: ['reports', 'venues'], queryFn: () => fetchAllPages<{ id: string; name: string }>('/venues') });
  const runs = useQuery({
    queryKey: ['reports', 'payroll-runs'],
    enabled: canSeePay,
    queryFn: async () => (await api.get<{ periods: PeriodRunSummary[] }>('/payroll/runs')).data.periods.filter((p) => p.run),
  });
  const exports = useQuery({
    queryKey: ['reports', 'exports'],
    queryFn: listExports,
    // While something is building, look again every 5 s (the server's Worker scan runs every 15 s by default).
    refetchInterval: (query) => ((query.state.data ?? []).some((e) => e.status === 'pending') ? 5_000 : false),
  });

  const start = useMutation({
    mutationFn: (body: ReportExportRequest) => requestExport(body),
    onSuccess: () => {
      toast.success('Export started. You will get a notice when it is ready.');
      void queryClient.invalidateQueries({ queryKey: ['reports', 'exports'] });
    },
    onError: (error) => toast.error(getApiErrorMessage(error, 'The export could not be started. Try again.')),
  });
  const [downloading, setDownloading] = useState<string | null>(null);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (takesPeriod) {
      if (!periodFrom || !periodTo || periodTo < periodFrom) {
        toast.error('Choose a period that ends on or after its start.');
        return;
      }
      start.mutate({ reportKey, periodFrom, periodTo, ...(venueId ? { venueId } : {}) });
    } else {
      if (!payrollRunId) {
        toast.error('Choose a payroll run.');
        return;
      }
      start.mutate({ reportKey, payrollRunId });
    }
  };

  const onDownload = async (e: ReportExportSummary) => {
    setDownloading(e.id);
    try {
      await downloadExport(e.id, `${e.reportKey}.csv`);
    } catch (error) {
      toast.error(getApiErrorMessage(error, {
        fallback: 'The file could not be downloaded. Try again.',
        messages: { not_found: 'This file is no longer available, or its download link expired. Try Download again.' },
      }));
      void queryClient.invalidateQueries({ queryKey: ['reports', 'exports'] });
    } finally {
      setDownloading(null);
    }
  };

  const venueName = (id: string | null) => (id ? venues.data?.find((v) => v.id === id)?.name ?? 'One venue' : 'All venues');
  const filterText = (e: ReportExportSummary) =>
    e.periodFrom ? `${e.periodFrom} to ${e.periodTo} · ${venueName(e.venueId)}` : 'Payroll run';

  return (
    <div className="page reports-page">
      <PageHeader title="Reports" />
      <div className="page-scroll reports-scroll">
        {canExport && (
          <form className="reports-card" onSubmit={onSubmit} aria-label="New export">
            <h2>New export</h2>
            <div className="field">
              <label htmlFor="report-key">Report</label>
              <select id="report-key" value={reportKey} onChange={(e) => setReportKey(e.target.value as ReportKeyType)}>
                {keys.map((k) => (
                  <option key={k} value={k}>{REPORT_LABELS[k]}</option>
                ))}
              </select>
              <p className="reports-help">{REPORT_HELP[reportKey]}</p>
            </div>
            {takesPeriod ? (
              <div className="reports-row">
                <div className="field">
                  <label htmlFor="report-from">From</label>
                  <input id="report-from" type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} required />
                </div>
                <div className="field">
                  <label htmlFor="report-to">To</label>
                  <input id="report-to" type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} required />
                </div>
                <div className="field">
                  <label htmlFor="report-venue">Venue</label>
                  <select id="report-venue" value={venueId} onChange={(e) => setVenueId(e.target.value)}>
                    <option value="">All venues</option>
                    {(venues.data ?? []).map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="report-run">Payroll run</label>
                <select id="report-run" value={payrollRunId} onChange={(e) => setPayrollRunId(e.target.value)}>
                  <option value="">Choose a run</option>
                  {(runs.data ?? []).map((p) => (
                    <option key={p.run!.id} value={p.run!.id}>{`${p.period.start} to ${p.period.end} (${p.run!.status})`}</option>
                  ))}
                </select>
              </div>
            )}
            <p className="reports-help">
              CSV, built in the background. Download links work once, for 60 seconds. Files are deleted after {REPORT_EXPORT_FILE_RETENTION_HOURS} hours.
            </p>
            <div>
              <button type="submit" className="btn btn-dark" disabled={start.isPending}>{start.isPending ? 'Starting…' : 'Export'}</button>
            </div>
          </form>
        )}

        <section className="reports-card" aria-label="Your exports">
          <h2>Your exports</h2>
          {exports.isLoading ? (
            <p className="reports-help" role="status">Loading…</p>
          ) : exports.isError ? (
            <p className="reports-help" role="alert">{getApiErrorMessage(exports.error, 'Your exports could not be loaded.')}</p>
          ) : (exports.data ?? []).length === 0 ? (
            <p className="reports-help">No exports yet.</p>
          ) : (
            <table className="table reports-table">
              <thead>
                <tr><th>Report</th><th>Filter</th><th>Requested</th><th>Status</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {exports.data!.map((e) => (
                  <tr key={e.id}>
                    <td>{REPORT_LABELS[e.reportKey]}{e.includePay ? <span className="reports-tag">pay</span> : null}</td>
                    <td>{filterText(e)}</td>
                    <td>{fmtTime(e.createdAt)}</td>
                    <td className={`reports-status reports-status-${e.status}`}>{statusText(e)}</td>
                    <td>
                      {e.status === 'ready' && canExport && (
                        <button type="button" className="btn btn-outline" disabled={downloading === e.id} aria-label={`Download ${REPORT_LABELS[e.reportKey]}`} onClick={() => void onDownload(e)}>
                          {downloading === e.id ? 'Downloading…' : 'Download'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
