import { useRef, useState } from 'react';
import { IconAdjustmentsHorizontal, IconDownload } from '@tabler/icons-react';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import Popover from '../../shared/components/Popover';
import { getApiErrorMessage } from '../../shared/lib/apiError';
import RejectPayrollDialog from './RejectPayrollDialog';
import PayrollCalendarView from './PayrollCalendarView';
import PayrollRecordsView from './PayrollRecordsView';
import PayrollRunsView from './PayrollRunsView';
import { addMonths, currentMonth, monthLabel, STAGE, toCsv, type PayrollPeriodRow, type PayrollStage, type RecordFilter } from './payrollModel';
import { openShiftStatement, usePayroll } from './usePayroll';
import PayrollLoadError from './PayrollLoadError';
import './payroll.css';

type View = 'calendar' | 'records' | 'runs';

/**
 * Payroll (owner reference 2026-10-21): a month of this workspace's attendance joined with its payroll records.
 * No payroll record yet → "In progress" (awaiting the timesheet; never approvable, figures "—"); pending approval →
 * "Ready for approval"; approved / processing / paid → "Completed"; rejected → "Rejected". "Approve shift payroll"
 * is shown only with `payroll.approve` (display hint) on approvable rows; the server enforces everything. Approval
 * releases an Approved Shift Statement (not a payslip).
 */
export default function Payroll({ initialMonth }: { initialMonth?: string } = {}) {
  const [month, setMonth] = useState(initialMonth ?? currentMonth());
  const [view, setView] = useState<View>('calendar');
  const [filter, setFilter] = useState<RecordFilter>({ stage: '', venue: '' });
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLButtonElement>(null);
  const [rejectTarget, setRejectTarget] = useState<PayrollPeriodRow | null>(null);
  const payroll = usePayroll(month);
  const data = payroll.period.data;
  const allRows = data?.rows ?? [];
  const timezone = data?.timezone ?? 'Europe/London';
  const rows = allRows.filter((r) => (!filter.stage || r.stage === filter.stage) && (!filter.venue || r.venueName === filter.venue));
  const venues = [...new Set(allRows.map((r) => r.venueName))].sort();
  const activeFilters = Number(!!filter.stage) + Number(!!filter.venue);

  const exportCsv = () => {
    const blob = new Blob([toCsv(rows, timezone)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `payroll-${month}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  return (
    <div className="page payroll-page">
      <header className="payroll-header">
        <div className="payroll-header-title">
          <h1>Payroll</h1>
          <span className="payroll-chip">{rows.length} record{rows.length === 1 ? '' : 's'}</span>
          <span className="payroll-period">{monthLabel(month)}</span>
        </div>
        <div className="payroll-header-actions">
          <div className="payroll-segmented" role="tablist" aria-label="Payroll view">
            {(['calendar', 'records', 'runs'] as View[]).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'is-active' : ''} onClick={() => setView(v)}>
                {v === 'calendar' ? 'Calendar' : v === 'records' ? 'Records' : 'Runs'}
              </button>
            ))}
          </div>
          <button ref={filterRef} type="button" className="btn btn-outline" aria-haspopup="dialog" aria-expanded={filterOpen} onClick={() => setFilterOpen((o) => !o)}>
            <IconAdjustmentsHorizontal size={15} aria-hidden="true" /> Filter{activeFilters ? ` · ${activeFilters}` : ''}
          </button>
          <Popover open={filterOpen} onClose={() => setFilterOpen(false)} anchorRef={filterRef} align="end" minWidth={220} role="dialog">
            <div className="payroll-filter" aria-label="Filter payroll">
              <label>Status
                <select aria-label="Filter by status" value={filter.stage} onChange={(e) => setFilter({ ...filter, stage: e.target.value as PayrollStage | '' })}>
                  <option value="">Any status</option>
                  {(Object.keys(STAGE) as PayrollStage[]).map((s) => <option key={s} value={s}>{STAGE[s].label}</option>)}
                </select>
              </label>
              <label>Venue
                <select aria-label="Filter by venue" value={filter.venue} onChange={(e) => setFilter({ ...filter, venue: e.target.value })}>
                  <option value="">Any venue</option>
                  {venues.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              {activeFilters > 0 && <button type="button" className="btn btn-outline" onClick={() => setFilter({ stage: '', venue: '' })}>Clear filters</button>}
            </div>
          </Popover>
          <button type="button" className="btn btn-outline" onClick={exportCsv} disabled={!rows.length}>
            <IconDownload size={15} aria-hidden="true" /> Export
          </button>
        </div>
      </header>

      <div className="page-scroll payroll-body">
        {view === 'runs' ? (
          <PayrollRunsView capabilities={payroll.capabilities} />
        ) : payroll.period.isLoading ? (
          <div className="payroll-card"><TableSkeleton columns={6} /></div>
        ) : payroll.period.isError ? (
          <div className="payroll-card"><PayrollLoadError error={payroll.period.error} retry={() => void payroll.period.refetch()} /></div>
        ) : allRows.length === 0 ? (
          <div className="payroll-card">
            <EmptyState variant="payroll" title={`No payroll records for ${monthLabel(month)}`} description="Shift attendance appears here; approval opens once a shift's timesheet is finalised." />
            <div className="payroll-month-nav">
              <button type="button" className="btn btn-outline" onClick={() => setMonth(addMonths(month, -1))}>Previous month</button>
              <button type="button" className="btn btn-outline" onClick={() => setMonth(addMonths(month, 1))}>Next month</button>
            </div>
          </div>
        ) : view === 'calendar' ? (
          <PayrollCalendarView
            rows={rows}
            timezone={timezone}
            month={month}
            onMonthChange={(d) => setMonth(addMonths(month, d))}
            canApprove={payroll.canApprove}
            busy={payroll.busy}
            onApprove={(r) => r.payrollRecordId && payroll.approve.mutate(r.payrollRecordId)}
            onReject={(r) => { payroll.reject.reset(); setRejectTarget(r); }}
            onRetryStatement={(r) => r.payrollRecordId && payroll.retryStatement.mutate(r.payrollRecordId)}
            onOpenStatement={(r) => r.statement?.fileId && void openShiftStatement(r.statement.fileId, r.statement.filename)}
          />
        ) : (
          <PayrollRecordsView rows={rows} timezone={timezone} filter={filter} canApprove={payroll.canApprove} busy={payroll.busy} onBulkApprove={payroll.approveSelection} />
        )}
      </div>

      <RejectPayrollDialog
        open={!!rejectTarget}
        staffName={rejectTarget?.staffName ?? null}
        loading={payroll.reject.isPending}
        error={payroll.reject.isError ? getApiErrorMessage(payroll.reject.error, 'Payroll could not be rejected. Try again.') : null}
        onConfirm={(reason) => rejectTarget?.payrollRecordId && payroll.reject.mutate({ id: rejectTarget.payrollRecordId, reason }, { onSuccess: () => setRejectTarget(null) })}
        onCancel={() => setRejectTarget(null)}
      />
    </div>
  );
}
