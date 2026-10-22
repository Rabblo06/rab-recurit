import { IconArrowUpRight } from '@tabler/icons-react';
import type { PipelineStaff } from './VenueOfferPipeline';
import {
  ATTENDANCE_BUCKETS,
  attendanceBreakdown,
  attendanceBucket,
  filledSeats,
  isProvisionalNoShow,
  normaliseStage,
  type StageDef,
  type StageTone,
} from './VenueOfferPipelineStages';

/** Chart colours come from the theme's status tokens (light + dark), each always shown beside a text label. */
export const TONE_COLOUR: Record<StageTone, string> = {
  brand: 'var(--color-brand)',
  neutral: 'var(--font-light)',
  success: 'var(--color-green)',
  info: 'var(--feedback-info)',
  warning: 'var(--pipeline-amber)',
  danger: 'var(--color-red)',
  ink: 'var(--font-primary)',
  violet: 'var(--pipeline-violet)',
};

const hhmm = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '—';

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('') || '?';

/** Display label for a row's status pill: provisional marks read as missing attendance, never a final no-show. */
export function rowStatus(row: PipelineStaff, lanes: StageDef[]): { label: string; tone: StageTone } {
  if (isProvisionalNoShow(row)) return { label: 'Attendance missing', tone: 'warning' };
  const key = normaliseStage(row.stage);
  const lane = lanes.find((l) => l.key === key);
  if (key === 'no_show') return { label: 'No-show (confirmed)', tone: 'danger' };
  return { label: lane?.label ?? key, tone: lane?.tone ?? 'neutral' };
}

function CoverageChart({ required, filled, open }: { required: number; filled: number; open: number }) {
  const bars = [
    { key: 'required', label: 'Required', value: required, colour: 'var(--font-primary)' },
    { key: 'filled', label: 'Filled', value: filled, colour: 'var(--color-green)' },
    { key: 'open', label: 'Open', value: open, colour: 'var(--color-brand)' },
  ];
  const max = Math.max(1, ...bars.map((b) => b.value));
  const ticks = Array.from(new Set([0, Math.round(max / 2), max]));
  return (
    <div className="pa-coverage" role="img" aria-label={`Required ${required}, filled ${filled}, open ${open}`}>
      <div className="pa-coverage-plot">
        {ticks.map((t) => (
          <span key={t} className="pa-gridline" style={{ bottom: `${(t / max) * 100}%` }}>
            <em>{t}</em>
          </span>
        ))}
        {bars.map((bar) => (
          <div key={bar.key} className="pa-col" data-metric={bar.key} title={`${bar.label}: ${bar.value}`}>
            <strong>{bar.value}</strong>
            <span
              className="pa-col-bar"
              style={{ height: `${(bar.value / max) * 100}%`, background: bar.colour }}
            />
          </div>
        ))}
      </div>
      <div className="pa-coverage-axis" aria-hidden>
        {bars.map((bar) => (
          <span key={bar.key}>{bar.label}</span>
        ))}
      </div>
    </div>
  );
}

function Donut({ segments, total }: { segments: Array<{ key: string; value: number; colour: string; label: string }>; total: number }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const drawn = segments.filter((s) => s.value > 0);
  const gap = drawn.length > 1 ? 2 : 0;
  let offset = 0;
  return (
    <svg className="pa-donut" viewBox="0 0 140 140" role="img" aria-label={`${total} booked staff`}>
      <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--chart-track)" strokeWidth="16" />
      {total > 0 &&
        drawn.map((s) => {
          const length = (s.value / total) * circumference;
          const dash = Math.max(0, length - gap);
          const el = (
            <circle
              key={s.key}
              cx="70"
              cy="70"
              r={radius}
              fill="none"
              stroke={s.colour}
              strokeWidth="16"
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 70 70)"
            >
              <title>{`${s.label}: ${s.value}`}</title>
            </circle>
          );
          offset += length;
          return el;
        })}
      <text x="70" y="68" textAnchor="middle" className="pa-donut-total">
        {total}
      </text>
      <text x="70" y="88" textAnchor="middle" className="pa-donut-caption">
        Booked staff
      </text>
    </svg>
  );
}

export default function VenueOfferPipelineAnalytics({
  staff,
  lanes,
  counts,
  requiredCount,
  venueName,
  roleName,
  startsAt,
  endsAt,
  onReview,
  onOpenPipeline,
}: {
  staff: PipelineStaff[];
  lanes: StageDef[];
  counts: Record<string, number>;
  requiredCount: number;
  venueName: string;
  roleName: string;
  startsAt: string;
  endsAt: string;
  onReview: (row: PipelineStaff) => void;
  onOpenPipeline: () => void;
}) {
  const filled = filledSeats(staff);
  const open = Math.max(0, requiredCount - filled);
  const breakdown = attendanceBreakdown(staff);
  const segments = ATTENDANCE_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    value: breakdown.counts[b.key],
    colour: TONE_COLOUR[b.tone],
  }));
  const pct = (n: number) => (breakdown.total ? Math.round((n / breakdown.total) * 100) : 0);
  const missing = breakdown.counts.attendance_missing;
  const confirmedNoShow = breakdown.counts.no_show;
  const stageMax = Math.max(1, ...lanes.map((l) => counts[l.key] ?? 0));
  const reportRows = staff
    .filter((row) => attendanceBucket(row) !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const shiftDate = new Date(startsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return (
    <div className="pa" aria-label="Shift analytics">
      <div className="pa-grid">
        <section className="pa-card" aria-labelledby="pa-coverage-title">
          <h2 id="pa-coverage-title">Staffing coverage</h2>
          <p className="pa-sub">Required, filled and open positions</p>
          <CoverageChart required={requiredCount} filled={filled} open={open} />
          <p className="pa-foot" data-testid="coverage-foot">
            {filled} of {requiredCount} positions filled · {open} still open
          </p>
        </section>
        <section className="pa-card" aria-labelledby="pa-attendance-title">
          <h2 id="pa-attendance-title">Attendance breakdown</h2>
          <p className="pa-sub">Booked staff by current attendance status</p>
          <div className="pa-donut-wrap">
            <Donut segments={segments} total={breakdown.total} />
            <ul className="pa-legend" aria-label="Attendance breakdown">
              {ATTENDANCE_BUCKETS.map((b) => (
                <li key={b.key} data-bucket={b.key}>
                  <i style={{ background: TONE_COLOUR[b.tone] }} aria-hidden />
                  <span>
                    {b.label}
                    {b.hint && <small> · {b.hint}</small>}
                  </span>
                  <strong>{breakdown.counts[b.key]}</strong>
                  <em>{pct(breakdown.counts[b.key])}%</em>
                </li>
              ))}
            </ul>
          </div>
          <p
            className={`pa-foot ${missing ? 'is-warning' : confirmedNoShow ? 'is-danger' : ''}`}
            data-testid="attendance-foot"
          >
            {missing > 0
              ? `${missing} staff with attendance missing · needs review, not a confirmed no-show`
              : confirmedNoShow > 0
                ? `${confirmedNoShow} confirmed no-show`
                : `${breakdown.counts.clocked_in} working now · ${breakdown.counts.checked_in} checked in, not yet clocked in`}
          </p>
        </section>
        <section className="pa-card" aria-labelledby="pa-stage-title">
          <h2 id="pa-stage-title">Staff by pipeline stage</h2>
          <p className="pa-sub">Current snapshot · number of staff</p>
          <ul className="pa-stage-bars" aria-label="Staff by pipeline stage">
            {lanes.map((lane) => {
              const value = counts[lane.key] ?? 0;
              return (
                <li key={lane.key} data-stage={lane.key} className={value ? 'has-value' : ''} title={`${lane.label}: ${value}`}>
                  <span>{lane.label}</span>
                  <span className="pa-stage-track">
                    <span className="pa-stage-bar" style={{ width: `${(value / stageMax) * 100}%` }} />
                  </span>
                  <strong>{value}</strong>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
      <section className="pa-card pa-report" aria-labelledby="pa-report-title">
        <div className="pa-report-head">
          <div>
            <h2 id="pa-report-title">Staff attendance report</h2>
            <p className="pa-sub">Scheduled hours, attendance records and staff outcomes</p>
          </div>
          <button type="button" className="btn btn-outline" onClick={onOpenPipeline}>
            View pipeline
          </button>
        </div>
        <div className="pa-table-wrap">
          <table className="pa-table">
            <thead>
              <tr>
                <th scope="col">Staff</th>
                <th scope="col">Scheduled shift</th>
                <th scope="col">Clock in</th>
                <th scope="col">Clock out</th>
                <th scope="col">Status</th>
                <th scope="col" className="pa-actions-col">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {reportRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="pa-empty">
                    No booked staff yet. Confirmed staff appear here with their attendance.
                  </td>
                </tr>
              )}
              {reportRows.map((row) => {
                const status = rowStatus(row, lanes);
                return (
                  <tr key={row.offerId}>
                    <td>
                      <span className="pa-person">
                        <span className="pa-initials" aria-hidden>
                          {initials(row.name)}
                        </span>
                        <span>
                          <strong>{row.name}</strong>
                          <small>{roleName}</small>
                        </span>
                      </span>
                    </td>
                    <td>
                      {shiftDate} · {hhmm(startsAt)}–{hhmm(endsAt)}
                    </td>
                    <td>{hhmm(row.clockInAt)}</td>
                    <td>{hhmm(row.clockOutAt)}</td>
                    <td>
                      <span className={`pipeline-chip tone-${status.tone}`}>{status.label}</span>
                    </td>
                    <td className="pa-actions-col">
                      <button
                        type="button"
                        className="pa-link"
                        aria-label={`Review attendance for ${row.name}`}
                        onClick={() => onReview(row)}
                      >
                        Review attendance <IconArrowUpRight size={13} aria-hidden />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="pa-table-foot">
          <span>
            {reportRows.length} staff · {venueName}
          </span>
          <span>Missing clock-in or clock-out records are shown as —.</span>
        </div>
      </section>
      <div className="pipeline-footer">
        <span>Shift snapshot · {new Date(startsAt).toLocaleDateString('en-GB', { dateStyle: 'long' })}</span>
        <span>Coverage and attendance are shown separately.</span>
      </div>
    </div>
  );
}
