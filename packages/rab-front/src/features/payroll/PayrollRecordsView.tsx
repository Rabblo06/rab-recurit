import { useMemo, useState } from 'react';
import { IconSend } from '@tabler/icons-react';
import BulkActionBar from '../../shared/components/BulkActionBar';
import { ListViewSelect } from '../../shared/table-toolbar/ListPresentation';
import { TableSearchInput } from '../../shared/table-toolbar/TableToolbar';
import {
  applyRecordsView, dayKey, fmtDate, fmtHours, fmtMoney, fmtPayday, fmtPeriod, initialsOf, isApprovable, isOpenStage,
  type PayrollPeriodRow, type RecordFilter, type RecordsTab, type SortKey,
} from './payrollModel';
import { StagePill } from './StagePill';

export interface RecordsViewProps {
  rows: PayrollPeriodRow[];
  timezone: string;
  filter: RecordFilter;
  canApprove: boolean;
  busy: boolean;
  /** Called with the eligible payroll record ids of the selection and how many selected rows were not eligible. */
  onBulkApprove: (recordIds: string[], skipped: number) => Promise<boolean | void>;
}

const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: 'date_desc', label: 'Sort: Date' },
  { value: 'date_asc', label: 'Sort: Date (oldest)' },
  { value: 'staff', label: 'Sort: Staff' },
  { value: 'amount', label: 'Sort: Amount' },
];

const VIEWS = [
  { value: '', label: 'All payroll' },
  { value: 'ready', label: 'Ready for approval' },
  { value: 'rejected', label: 'Rejected' },
];

/** Records view: tabs, toolbar, table, footer and the floating bulk dock. Ineligible rows may be selected for viewing. */
export default function PayrollRecordsView({ rows, timezone, filter, canApprove, busy, onBulkApprove }: RecordsViewProps) {
  const [tab, setTab] = useState<RecordsTab>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('date_desc');
  const [view, setView] = useState<'' | 'ready' | 'rejected'>('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const tabCounts = {
    all: rows.length,
    in_progress: rows.filter((r) => isOpenStage(r.stage)).length,
    completed: rows.filter((r) => r.stage === 'completed').length,
  };
  const visible = useMemo(
    () => applyRecordsView(rows, { tab, search, sort, filter: { stage: view || filter.stage, venue: filter.venue } }),
    [rows, tab, search, sort, view, filter],
  );
  const visibleIds = visible.map((r) => r.attendanceId);
  const selectedRows = visible.filter((r) => selected.has(r.attendanceId));
  const eligible = selectedRows.filter(isApprovable);
  const allSelected = visible.length > 0 && selectedRows.length === visible.length;
  const staffCount = new Set(visible.map((r) => r.staffProfileId)).size;
  const pendingFigures = visible.some((r) => r.amountPence === null);

  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const clear = () => setSelected(new Set());

  const submit = async () => {
    // Keep the selection when nothing was approved (request failed), so the user can simply try again.
    const done = await onBulkApprove(eligible.map((r) => r.payrollRecordId!), selectedRows.length - eligible.length);
    if (done !== false) clear();
  };

  return (
    <section className="payroll-card payroll-records" aria-label="Payroll records">
      <div className="payroll-tabs" role="tablist" aria-label="Record status">
        {([['all', 'All records'], ['in_progress', 'In progress'], ['completed', 'Completed']] as Array<[RecordsTab, string]>).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={`payroll-tab${tab === key ? ' is-active' : ''}`} onClick={() => { setTab(key); clear(); }}>
            {label} · {tabCounts[key]}
          </button>
        ))}
      </div>
      <div className="payroll-records-toolbar">
        <ListViewSelect label="Payroll view" value={view} options={VIEWS} onChange={(v) => { setView(v as typeof view); clear(); }} />
        <TableSearchInput value={search} onChange={setSearch} />
        <label className="payroll-sort">
          <span className="sr-only">Sort</span>
          <select aria-label="Sort records" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      </div>
      <div className="payroll-table-scroll">
        <table className="table payroll-table">
          <thead>
            <tr>
              <th className="checkbox-col">
                <input type="checkbox" aria-label="Select all visible records" disabled={!visible.length} checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = selectedRows.length > 0 && !allSelected; }}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(visibleIds))} />
              </th>
              <th>Staff</th><th>Venue</th><th>Shift date</th><th>Payroll period</th><th>Payday</th><th>Hours</th><th>Amount</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.attendanceId} className={selected.has(r.attendanceId) ? 'row-selected' : undefined}>
                <td className="checkbox-col"><input type="checkbox" aria-label={`Select ${r.staffName} ${dayKey(r.startsAt, timezone)}`} checked={selected.has(r.attendanceId)} onChange={() => toggle(r.attendanceId)} /></td>
                <td><span className="user-cell"><span className="payroll-avatar" aria-hidden="true">{initialsOf(r.staffName)}</span>{r.staffName}</span></td>
                <td className="cell-muted">{r.venueName}</td>
                <td className="cell-muted">{fmtDate(r.startsAt, timezone)}</td>
                <td className="cell-muted">{fmtPeriod(r.allocation?.payrollPeriod ?? null)}{r.allocation?.status === 'carried_forward' ? ' · late' : ''}</td>
                <td className="cell-muted">{fmtPayday(r.allocation)}</td>
                <td className="cell-muted">{fmtHours(r.workedMinutes)}</td>
                <td className="cell-primary">{fmtMoney(r.amountPence)}</td>
                <td><StagePill stage={r.stage} /></td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={9} className="payroll-muted payroll-empty-cell">{rows.length ? 'No records match this view.' : 'No payroll records this month.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <footer className="payroll-records-foot">
        <span>{visible.length} record{visible.length === 1 ? '' : 's'} · {staffCount} staff</span>
        {pendingFigures && <span className="payroll-muted">Hours and amounts pending</span>}
      </footer>
      <BulkActionBar
        count={selectedRows.length}
        onClear={clear}
        scopeNote={selectedRows.length > eligible.length ? `${selectedRows.length - eligible.length} not ready` : undefined}
        actions={canApprove ? [{
          key: 'approve',
          label: 'Approve shift payroll',
          icon: <IconSend size={16} />,
          onClick: () => { void submit(); },
          disabled: busy,
          title: eligible.length
            ? `Approves ${eligible.length} record${eligible.length === 1 ? '' : 's'} ready for approval${selectedRows.length > eligible.length ? '; the others are skipped' : ''}.`
            : 'None of the selected records is ready for approval.',
        }] : []}
      />
    </section>
  );
}
