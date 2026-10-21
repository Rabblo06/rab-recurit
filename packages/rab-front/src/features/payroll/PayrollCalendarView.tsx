import { useMemo, useState } from 'react';
import { IconAlertTriangle, IconBuilding, IconChevronLeft, IconChevronRight, IconFileText, IconHash, IconMail, IconSearch, IconCurrencyPound } from '@tabler/icons-react';
import {
  calendarWeeks, countByStage, dayKey, dominantStage, EM_DASH, fmtDate, fmtHours, fmtMoney, fmtPayday, fmtPeriod, isApprovable, monthLabel,
  progress, STAGE, staffSummaries, totals, type PayrollPeriodRow,
} from './payrollModel';
import { StagePill } from './StagePill';

export interface CalendarViewProps {
  rows: PayrollPeriodRow[];
  timezone: string;
  month: string;
  onMonthChange: (delta: number) => void;
  canApprove: boolean;
  busy: boolean;
  onApprove: (row: PayrollPeriodRow) => void;
  onReject: (row: PayrollPeriodRow) => void;
  onOpenStatement: (row: PayrollPeriodRow) => void;
  onRetryStatement: (row: PayrollPeriodRow) => void;
}

/** Calendar view: Team (left) · selected staff month + calendar + selected day (centre) · staff details (right). */
export default function PayrollCalendarView(props: CalendarViewProps) {
  const { rows, timezone, month } = props;
  const [search, setSearch] = useState('');
  const staff = useMemo(() => staffSummaries(rows), [rows]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = staff.find((s) => s.staffProfileId === selectedId) ?? staff[0] ?? null;
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const filteredStaff = staff.filter((s) => s.staffName.toLowerCase().includes(search.trim().toLowerCase()));
  const all = countByStage(rows);
  const venues = [...new Set(rows.map((r) => r.venueName))];

  return (
    <div className="payroll-calendar">
      <section className="payroll-card payroll-team" aria-label="Team">
        <header className="payroll-card-head">
          <h2>Team</h2>
          <span className="payroll-chip">{staff.length} staff</span>
        </header>
        <label className="payroll-search">
          <IconSearch size={14} aria-hidden="true" />
          <input type="search" placeholder="Search staff..." aria-label="Search staff" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <ul className="payroll-team-list" role="listbox" aria-label="Staff">
          {filteredStaff.map((s) => {
            const active = selected?.staffProfileId === s.staffProfileId;
            return (
              <li key={s.staffProfileId} role="presentation">
                <button type="button" role="option" aria-selected={active} className={`payroll-team-row${active ? ' is-selected' : ''}`} onClick={() => { setSelectedId(s.staffProfileId); setSelectedDay(null); }}>
                  <span className="payroll-avatar" aria-hidden="true">{s.initials}</span>
                  <span className="payroll-team-text">
                    <span className="payroll-team-name">{s.staffName}</span>
                    <span className="payroll-team-sub">{s.rows.length} record{s.rows.length === 1 ? '' : 's'} · {STAGE[s.stage].label}</span>
                  </span>
                </button>
              </li>
            );
          })}
          {filteredStaff.length === 0 && <li role="presentation" className="payroll-muted payroll-team-empty">{staff.length ? 'No staff match this search.' : 'No staff records this month.'}</li>}
        </ul>
        <footer className="payroll-team-foot">
          <span className="payroll-eyebrow">This month</span>
          <div className="payroll-foot-stats">
            <span>In progress <b>{all.in_progress + all.ready}</b></span>
            <span>Completed <b>{all.completed}</b></span>
            {venues.length > 0 && <span className="payroll-chip">{venues.length === 1 ? venues[0] : `${venues.length} venues`}</span>}
          </div>
        </footer>
      </section>

      <MonthCard {...props} staffRows={selected?.rows ?? []} staffName={selected?.staffName ?? null} selectedDay={selectedDay} onSelectDay={setSelectedDay} />

      <StaffCard rows={selected?.rows ?? []} timezone={timezone} month={month} onOpenStatement={props.onOpenStatement} />
    </div>
  );
}

function MonthCard({ staffRows, staffName, selectedDay, onSelectDay, timezone, month, onMonthChange, canApprove, busy, onApprove, onReject, onRetryStatement }: CalendarViewProps & {
  staffRows: PayrollPeriodRow[]; staffName: string | null; selectedDay: string | null; onSelectDay: (day: string) => void;
}) {
  const t = totals(staffRows);
  const p = progress(staffRows);
  const counts = countByStage(staffRows);
  const byDay = new Map<string, PayrollPeriodRow[]>();
  for (const r of staffRows) { const k = dayKey(r.startsAt, timezone); byDay.set(k, [...(byDay.get(k) ?? []), r]); }
  const firstDay = [...byDay.keys()].sort()[0] ?? null;
  const day = selectedDay ?? firstDay;
  const dayRows = day ? byDay.get(day) ?? [] : [];
  const amountUnavailable = t.minutes === null;

  return (
    <section className="payroll-card payroll-month" aria-label="Month summary">
      <div className="payroll-total">
        <span className="payroll-total-figure">{amountUnavailable ? EM_DASH : `${fmtHours(t.minutes)} / ${fmtMoney(t.pence)}`}</span>
        <span className="payroll-muted">{staffName ?? 'No staff selected'}{t.pending ? ' · Hours and amount pending' : staffRows.length ? ' · Verified hours and pay' : ''}</span>
      </div>
      <div className="payroll-progress-line">
        <span>In progress · {counts.in_progress + counts.ready} record{counts.in_progress + counts.ready === 1 ? '' : 's'}</span>
        <span>Completed · {counts.completed}</span>
      </div>
      <div className="payroll-progress" role="progressbar" aria-label="Completed records" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.percent}>
        <span className="payroll-progress-fill" style={{ width: `${p.percent}%` }} />
      </div>
      <p className="payroll-progress-legend payroll-muted">{p.completed} of {p.total} completed ({p.percent}%)</p>

      <div className="payroll-month-nav">
        <button type="button" className="btn-icon" aria-label="Previous month" onClick={() => onMonthChange(-1)}><IconChevronLeft size={16} /></button>
        <span className="payroll-month-label" aria-live="polite">{monthLabel(month)}</span>
        <button type="button" className="btn-icon" aria-label="Next month" onClick={() => onMonthChange(1)}><IconChevronRight size={16} /></button>
      </div>
      <div className="payroll-grid-scroll">
        <table className="payroll-grid" aria-label={`Calendar ${monthLabel(month)}`}>
          <thead><tr>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <th key={d} scope="col">{d}</th>)}</tr></thead>
          <tbody>
            {calendarWeeks(month).map((week, i) => (
              <tr key={i}>
                {week.map((cell, j) => {
                  if (!cell) return <td key={j} className="payroll-cell is-pad" />;
                  const cellRows = byDay.get(cell.key) ?? [];
                  const isSel = day === cell.key;
                  return (
                    <td key={j} className={`payroll-cell${cell.weekend ? ' is-weekend' : ''}${isSel ? ' is-selected' : ''}`}>
                      <button type="button" aria-label={`${cell.day} ${monthLabel(month)}${cellRows.length ? `, ${STAGE[dominantStage(cellRows)].label}` : ''}`} aria-pressed={isSel} onClick={() => onSelectDay(cell.key)}>
                        <span className="payroll-cell-day">{cell.day}</span>
                        {cellRows.length > 0 && <StagePill stage={dominantStage(cellRows)} compact />}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="payroll-day">
        {dayRows.length === 0 ? (
          <p className="payroll-muted">{staffRows.length ? 'No record on this day.' : 'No payroll records for this staff member this month.'}</p>
        ) : dayRows.map((r) => (
          <article key={r.attendanceId} className="payroll-record-card" aria-label={`Record ${fmtDate(r.startsAt, timezone)}`}>
            <div className="payroll-record-head">
              <div>
                <div className="payroll-record-date">{fmtDate(r.startsAt, timezone)}</div>
                <div className="payroll-muted">{r.venueName}</div>
              </div>
              <StagePill stage={r.stage} />
            </div>
            <dl className="payroll-record-figures">
              <div><dt>Hours</dt><dd>{fmtHours(r.workedMinutes)}</dd></div>
              <div><dt>Amount</dt><dd>{fmtMoney(r.amountPence)}</dd></div>
              <div><dt>Payroll period</dt><dd>{fmtPeriod(r.allocation?.payrollPeriod ?? null)}</dd></div>
              <div><dt>Scheduled payday</dt><dd>{fmtPayday(r.allocation)}</dd></div>
            </dl>
            {r.allocation?.status === 'carried_forward' && r.allocation.originalPeriod && (
              <p className="payroll-muted">Late approval — carried forward from {fmtPeriod(r.allocation.originalPeriod)}.</p>
            )}
            {r.statement?.state === 'processing' && <p className="payroll-muted" role="status">Preparing Approved Shift Statement…</p>}
            {r.statement?.state === 'failed' && (
              <div className="payroll-record-actions">
                <p className="payroll-muted" role="status">The Approved Shift Statement could not be generated.</p>
                {canApprove && r.payrollRecordId && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => onRetryStatement(r)}>Retry statement</button>}
              </div>
            )}
            {canApprove && isApprovable(r) && (
              <div className="payroll-record-actions">
                <button type="button" className="btn payroll-approve-btn" disabled={busy} onClick={() => onApprove(r)}>Approve shift payroll</button>
                <button type="button" className="btn btn-outline" disabled={busy} onClick={() => onReject(r)}>Reject</button>
              </div>
            )}
            {canApprove && r.stage === 'ready' && r.ownHours && <p className="payroll-muted">You cannot approve payroll for your own hours.</p>}
          </article>
        ))}
        <p className="payroll-caption payroll-muted">Approval releases an Approved Shift Statement to the staff member.</p>
      </div>
    </section>
  );
}

function StaffCard({ rows, timezone, month, onOpenStatement }: { rows: PayrollPeriodRow[]; timezone: string; month: string; onOpenStatement: (row: PayrollPeriodRow) => void }) {
  if (!rows.length) {
    return <section className="payroll-card payroll-staff" aria-label="Staff details"><p className="payroll-muted">Select a staff member to see their details.</p></section>;
  }
  const latest = [...rows].sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0]!;
  const counts = countByStage(rows);
  const statements = rows.filter((r) => r.statement?.state === 'available' && r.statement.fileId);
  const anyPendingFigures = rows.some((r) => r.workedMinutes === null || r.amountPence === null);
  const initials = latest.staffName.trim().split(/\s+/).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
  const venues = [...new Set(rows.map((r) => r.venueName))];
  return (
    <section className="payroll-card payroll-staff" aria-label="Staff details">
      <div className="payroll-staff-head">
        <span className="payroll-avatar payroll-avatar-lg" aria-hidden="true">{initials}</span>
        <div>
          <h2>{latest.staffName}</h2>
          <div className="payroll-muted">{latest.roleName} · {latest.venueName}</div>
        </div>
        <span className="payroll-chip payroll-chip-status">{latest.staffStatus ? latest.staffStatus.replace(/_/g, ' ') : EM_DASH}</span>
      </div>
      <dl className="payroll-staff-rows">
        <div><dt><IconHash size={14} aria-hidden="true" />Reference</dt><dd>{latest.staffRef ?? EM_DASH}</dd></div>
        <div><dt><IconMail size={14} aria-hidden="true" />Email</dt><dd>{latest.staffEmail ?? EM_DASH}</dd></div>
        <div><dt><IconBuilding size={14} aria-hidden="true" />Venue</dt><dd>{venues.join(', ')}</dd></div>
        <div><dt><IconCurrencyPound size={14} aria-hidden="true" />Default rate</dt><dd>{latest.defaultRatePence ? `${fmtMoney(latest.defaultRatePence)} / hr` : EM_DASH}</dd></div>
      </dl>
      <h3 className="payroll-eyebrow">Documents</h3>
      <ul className="payroll-docs">
        {statements.map((r) => (
          <li key={r.attendanceId}>
            <button type="button" className="payroll-doc" onClick={() => onOpenStatement(r)}>
              <IconFileText size={15} aria-hidden="true" />
              <span>Approved Shift Statement · {fmtDate(r.startsAt, timezone)}</span>
            </button>
          </li>
        ))}
        {statements.length === 0 && <li className="payroll-doc is-muted"><IconFileText size={15} aria-hidden="true" /><span>{monthLabel(month).split(' ')[0]} Approved Shift Statement — Not available yet</span></li>}
      </ul>
      <h3 className="payroll-eyebrow">This month</h3>
      <dl className="payroll-staff-rows">
        <div><dt>Payroll records</dt><dd>{rows.length}</dd></div>
        <div><dt>In progress</dt><dd>{counts.in_progress + counts.ready}</dd></div>
        <div><dt>Completed</dt><dd>{counts.completed}</dd></div>
      </dl>
      {anyPendingFigures && (
        <div className="payroll-warning" role="note"><IconAlertTriangle size={15} aria-hidden="true" />Hours and amounts are not yet available for these records.</div>
      )}
    </section>
  );
}
