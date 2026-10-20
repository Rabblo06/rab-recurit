import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconArrowLeft, IconArrowRight, IconCalendar, IconCheck, IconChevronDown, IconSearch } from '@tabler/icons-react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../../shared/api';
import AnimatedNumber from '../../shared/components/AnimatedNumber';
import { dropdown, duration, ease, layoutSpring, listItem, tooltip as tooltipMotion, usePrefersReducedMotion } from '../../shared/motion';
import Popover from '../../shared/components/Popover';
import '../../shared/table-toolbar/list-view-select.css';
import './staff-reviews.css';

/** Mirrors `StaffReviewSummary` / `StaffReviewDetail` (server `staff-review-insights.service.ts`). */
type Category = 'grooming' | 'attitude' | 'skills' | 'attendance' | 'timeKeeping';
type Range = 'all' | 'this_month' | 'last_month' | 'custom';
interface Reviewer { userId: string; name: string; venues: string[]; reviews: number }
interface HistoryItem {
  id: string;
  reviewerUserId: string;
  reviewerName: string;
  venueName: string;
  roleName: string;
  startsAt: string;
  endsAt: string;
  score: number;
  feedback: string | null;
  submittedAt: string;
}
export interface StaffReviewSummary {
  staff: { id: string; name: string; roleName: string | null };
  reviewers: Reviewer[];
  total: number;
  reviewerCount: number;
  average: number | null;
  distribution: Array<{ stars: number; count: number; percent: number }>;
  categories: Record<Category, number | null>;
  history: HistoryItem[];
}
interface StaffReviewDetail {
  id: string;
  staff: { name: string };
  venueName: string;
  roleName: string;
  startsAt: string;
  endsAt: string;
  reviewer: { name: string; role: string };
  submittedAt: string;
  score: number;
  ratings: Record<Category, number>;
  feedback: string | null;
}

const CATEGORIES: Array<[Category, string]> = [
  ['grooming', 'Grooming'],
  ['attitude', 'Attitude'],
  ['skills', 'Skills'],
  ['attendance', 'Attendance'],
  ['timeKeeping', 'Time keeping'],
];
const RANGES: Array<[Range, string]> = [
  ['all', 'All time'],
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
  ['custom', 'Custom range'],
];
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const stamp = (iso: string) =>
  `${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${hm(iso)}`;
const fmt = (n: number | null) => (n == null ? '—' : n.toFixed(1));
const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

export default function StaffReviewsTab({ staffId, staffName }: { staffId: string; staffName: string }) {
  const [reviewer, setReviewer] = useState<string | null>(null);
  const [range, setRange] = useState<Range>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [openReview, setOpenReview] = useState<string | null>(null);

  const params = {
    ...(reviewer ? { reviewer } : {}),
    ...(range !== 'all' ? { range } : {}),
    ...(range === 'custom' && from ? { from } : {}),
    ...(range === 'custom' && to ? { to } : {}),
  };
  const summary = useQuery({
    queryKey: ['staff', staffId, 'reviews', params],
    queryFn: async () => (await api.get<StaffReviewSummary>(`/staff/${staffId}/reviews`, { params })).data,
    placeholderData: (previous) => previous,
  });

  if (openReview) return <ReviewDetail staffId={staffId} reviewId={openReview} onBack={() => setOpenReview(null)} />;

  const data = summary.data;
  const selected = data?.reviewers.find((r) => r.userId === reviewer) ?? null;
  return (
    <div className="staff-reviews">
      <h2 className="sr-title">Staff reviews</h2>
      <p className="sr-subtitle">Post-shift feedback for {data?.staff.name ?? staffName}</p>

      <ReviewerPicker reviewers={data?.reviewers ?? []} total={data ? totalOf(data, reviewer) : null} value={reviewer} onChange={setReviewer} />
      <DateRange range={range} onRange={setRange} from={from} to={to} onFrom={setFrom} onTo={setTo} />

      {summary.isError ? (
        <div className="sr-card sr-error" role="alert">
          Staff reviews could not be loaded.{' '}
          <button type="button" className="sr-link" onClick={() => summary.refetch()}>Retry</button>
        </div>
      ) : !data ? (
        <div className="sr-card sr-loading" role="status">Loading reviews…</div>
      ) : (
        <>
          <section className="sr-card" aria-label="Overall rating">
            <div className="sr-card-head">
              <span className="sr-muted">Overall rating</span>
              <strong>
                {data.total} {data.total === 1 ? 'review' : 'reviews'} · {data.reviewerCount}{' '}
                {data.reviewerCount === 1 ? 'manager' : 'managers'}
              </strong>
            </div>
            <RatingDonut average={data.average} distribution={data.distribution} total={data.total} />
            <p className="sr-footnote">Chart: review scores rounded to the nearest star.</p>
          </section>

          <section className="sr-card" aria-label="Average scores">
            <h3 className="sr-card-title">{selected ? `${firstName(selected.name)}'s average scores` : 'Average by category'}</h3>
            {CATEGORIES.map(([key, label]) => (
              <ScoreRow key={key} label={label} value={data.categories[key]} />
            ))}
          </section>

          <h3 className="sr-section-title">{selected ? `Reviews from ${firstName(selected.name)}` : 'Review history'}</h3>
          {data.history.length === 0 ? (
            <div className="sr-card sr-empty">
              {data.total === 0 && !reviewer && range === 'all'
                ? 'No reviews yet. Reviews appear here after a venue manager reviews a shift.'
                : 'No reviews match these filters.'}
            </div>
          ) : (
            <ul className="sr-history">
              <AnimatePresence mode="popLayout">
              {data.history.map((h, i) => (
                <motion.li
                  key={h.id}
                  className="sr-card sr-history-item"
                  layout="position"
                  variants={listItem}
                  custom={i}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  transition={{ layout: layoutSpring }}
                >
                  <div className="sr-card-head">
                    <span>{h.reviewerName}</span>
                    <strong>{fmt(h.score)} / 5</strong>
                  </div>
                  <p className="sr-muted sr-meta">{h.venueName} · {day(h.startsAt)}</p>
                  {h.feedback && <p className="sr-quote">“{h.feedback}”</p>}
                  <div className="sr-history-foot">
                    <span className="sr-muted">Submitted {stamp(h.submittedAt)}</span>
                    <button type="button" className="sr-link" onClick={() => setOpenReview(h.id)} aria-label={`View review by ${h.reviewerName} on ${day(h.startsAt)}`}>
                      View review <IconArrowRight size={12} />
                    </button>
                  </div>
                </motion.li>
              ))}
              </AnimatePresence>
            </ul>
          )}
        </>
      )}
    </div>
  );
}

const totalOf = (data: StaffReviewSummary, reviewer: string | null) =>
  reviewer ? data.total : data.reviewers.reduce((sum, r) => sum + r.reviews, 0);

function ScoreRow({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="sr-score-row">
      <span>{label}</span>
      <span className="sr-score-bar" aria-hidden="true">
        <span style={{ width: `${value == null ? 0 : (value / 5) * 100}%` }} />
      </span>
      <strong>{value == null ? '—' : <AnimatedNumber value={value} format={(n) => n.toFixed(1)} />} / 5</strong>
    </div>
  );
}

/** Popover listbox with search, matching the reference "All venue managers" selector. */
function ReviewerPicker({ reviewers, total, value, onChange }: {
  reviewers: Reviewer[];
  total: number | null;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [{ userId: null as string | null, name: 'All venue managers', detail: total == null ? '' : `${total} ${total === 1 ? 'review' : 'reviews'}` }];
    const people = reviewers.map((r) => ({
      userId: r.userId as string | null,
      name: r.name,
      detail: [r.venues.join(', '), r.reviews ? `${r.reviews} ${r.reviews === 1 ? 'review' : 'reviews'}` : 'No reviews'].filter(Boolean).join(' · '),
    }));
    return q ? people.filter((p) => `${p.name} ${p.detail}`.toLowerCase().includes(q)) : [...all, ...people];
  }, [reviewers, total, query]);
  const current = reviewers.find((r) => r.userId === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    search.current?.focus(); // effect runs after the popover rendered
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  useEffect(() => setActive(0), [query]);

  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
    setQuery('');
    button.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && options[active]) { e.preventDefault(); pick(options[active].userId); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); button.current?.focus(); }
  };

  return (
    <div className="sr-picker" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="sr-select"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Venue manager: ${current ? current.name : 'All venue managers'}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{current ? `${current.name}${current.venues[0] ? ` · ${current.venues[0]}` : ''}` : 'All venue managers'}</span>
        <IconChevronDown size={14} />
      </button>
      <AnimatePresence>
      {open && (
        <motion.div className="sr-popover" onKeyDown={onKey} variants={dropdown} initial="hidden" animate="visible" exit="exit">
          <label className="sr-search">
            <IconSearch size={13} />
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search venue manager..."
              aria-label="Search venue manager"
              aria-controls="sr-reviewer-options"
              aria-activedescendant={options[active] ? `sr-opt-${active}` : undefined}
            />
          </label>
          <ul id="sr-reviewer-options" role="listbox" aria-label="Venue managers">
            {options.length === 0 && <li className="sr-muted sr-none">No venue manager matches.</li>}
            {options.map((o, i) => (
              <li
                key={o.userId ?? 'all'}
                id={`sr-opt-${i}`}
                role="option"
                aria-selected={o.userId === value}
                className={`${i === active ? 'is-active' : ''}${o.userId === value ? ' is-selected' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o.userId)}
              >
                <strong>{o.name}</strong>
                {o.detail && <small>{o.detail}</small>}
              </li>
            ))}
          </ul>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}

function DateRange({ range, onRange, from, to, onFrom, onTo }: {
  range: Range;
  onRange: (r: Range) => void;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  return (
    <div className="sr-range">
      <div className="sr-range-row">
        <span className="sr-muted" id="sr-range-label">Date range</span>
        <RangeMenu value={range} onChange={onRange} />
      </div>
      {range === 'custom' && (
        <div className="sr-range-custom">
          <label>From <input type="date" value={from} max={to || undefined} onChange={(e) => onFrom(e.target.value)} /></label>
          <label>To <input type="date" value={to} min={from || undefined} onChange={(e) => onTo(e.target.value)} /></label>
        </div>
      )}
    </div>
  );
}

/**
 * Date-range menu in the app's own view-menu style (shared `Popover` + `list-view-option`, as the Users "All staff"
 * selector): cream selected row with a check, hover/keyboard highlight; never the browser's native select list.
 */
function RangeMenu({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = Math.max(0, RANGES.findIndex(([v]) => v === value));
  const reveal = (index = selected) => { setActive(index); setOpen(true); };
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const choose = (index: number) => {
    const option = RANGES[index];
    if (option && option[0] !== value) onChange(option[0]);
    close();
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="sr-range-trigger"
        role="combobox"
        aria-labelledby="sr-range-label"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? 'sr-range-options' : undefined}
        aria-activedescendant={open ? `sr-range-${active}` : undefined}
        onClick={() => (open ? close() : reveal())}
        onKeyDown={(e) => {
          if (e.key === 'Tab') { setOpen(false); return; }
          if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); return; }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) reveal();
            else setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + RANGES.length) % RANGES.length);
          } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault(); reveal(e.key === 'Home' ? 0 : RANGES.length - 1);
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault(); if (open) choose(active); else reveal();
          }
        }}
      >
        <span>{RANGES[selected][1]}</span>
        <IconChevronDown size={12} aria-hidden="true" />
      </button>
      <Popover open={open} onClose={close} anchorRef={trigger} align="end" minWidth={200} className="list-view-popover sr-range-popover" role="presentation" animated>
        <div id="sr-range-options" role="listbox" aria-label="Date range" className="list-view-options">
          {RANGES.map(([v, label], index) => (
            <button
              key={v}
              id={`sr-range-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={value === v}
              className={`list-view-option${active === index ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(index)}
            >
              <IconCalendar size={15} aria-hidden="true" />
              <span>{label}</span>
              {value === v && <IconCheck size={13} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

/**
 * Thin donut of the star distribution. Analytical palette (validated: light on the panel surface, dark on #1c1a17),
 * separate from the walnut page theme; 2px surface gaps between segments; the legend carries every count and percent
 * (identity never by colour alone); hover/focus a segment or legend row for a tooltip.
 */
function RatingDonut({ average, distribution, total }: {
  average: number | null;
  distribution: Array<{ stars: number; count: number; percent: number }>;
  total: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const reduce = usePrefersReducedMotion();
  const size = 132, stroke = 11, r = (size - stroke) / 2 - 2, c = 2 * Math.PI * r;
  const gap = total > 1 ? 2 : 0;
  const drawn = distribution.filter((d) => d.count > 0);
  let offset = 0;
  const arcs = drawn.map((d) => {
    const length = (d.count / total) * c;
    const arc = { ...d, dash: Math.max(0, length - gap), offset };
    offset += length;
    return arc;
  });
  const hovered = distribution.find((d) => d.stars === hover);
  return (
    <div className="sr-donut-wrap">
      <div className="sr-donut">
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={total ? `Average ${fmt(average)} out of 5 from ${total} reviews` : 'No reviews yet'}
        >
          <circle className="sr-donut-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {arcs.map((a) => (
              <g key={a.stars}>
                <motion.circle
                  className={`sr-arc sr-star-${a.stars}${hover != null && hover !== a.stars ? ' is-dim' : ''}`}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  strokeWidth={hover === a.stars ? stroke + 2 : stroke}
                  initial={reduce ? false : { strokeDasharray: `0 ${c}`, strokeDashoffset: -a.offset }}
                  animate={{ strokeDasharray: `${a.dash} ${c - a.dash}`, strokeDashoffset: -a.offset }}
                  transition={{ duration: reduce ? 0 : duration.chart, ease: ease.out }}
                />
                {/* Wider invisible hit target than the mark. */}
                <circle
                  className="sr-arc-hit"
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  strokeWidth={stroke + 14}
                  strokeDasharray={`${a.dash} ${c - a.dash}`}
                  strokeDashoffset={-a.offset}
                  onMouseEnter={() => setHover(a.stars)}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            ))}
          </g>
        </svg>
        <div className="sr-donut-center" aria-hidden="true">
          <strong>{average == null ? '—' : <AnimatedNumber value={average} format={(n) => n.toFixed(1)} />}</strong>
          <span>{total ? 'out of 5' : 'No reviews yet'}</span>
        </div>
        <AnimatePresence>
        {hovered && hovered.count > 0 && (
          <motion.div className="sr-tooltip" role="tooltip" key={hovered.stars} variants={tooltipMotion} initial="hidden" animate="visible" exit="exit"
            style={{ x: '-50%' }}>
            <span className={`sr-swatch sr-star-${hovered.stars}`} />
            {hovered.stars} {hovered.stars === 1 ? 'star' : 'stars'}: {hovered.count} {hovered.count === 1 ? 'review' : 'reviews'} ({hovered.percent}%)
          </motion.div>
        )}
        </AnimatePresence>
      </div>
      <table className="sr-legend">
        <caption className="sr-visually-hidden">Reviews by star rating</caption>
        <tbody>
          {distribution.map((d) => (
            <tr
              key={d.stars}
              tabIndex={d.count ? 0 : -1}
              className={hover === d.stars ? 'is-hover' : ''}
              onMouseEnter={() => setHover(d.stars)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(d.stars)}
              onBlur={() => setHover(null)}
            >
              <th scope="row">
                <span className={`sr-swatch sr-star-${d.stars}`} aria-hidden="true" />
                {d.stars} {d.stars === 1 ? 'star' : 'stars'}
              </th>
              <td>{d.count ? `${d.count} · ${d.percent}%` : '0'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReviewDetail({ staffId, reviewId, onBack }: { staffId: string; reviewId: string; onBack: () => void }) {
  const q = useQuery({
    queryKey: ['staff', staffId, 'reviews', 'detail', reviewId],
    queryFn: async () => (await api.get<StaffReviewDetail>(`/staff/${staffId}/reviews/${reviewId}`)).data,
  });
  const d = q.data;
  return (
    <div className="staff-reviews">
      <button type="button" className="sr-link sr-back" onClick={onBack}>
        <IconArrowLeft size={12} /> Back to reviews
      </button>
      <h2 className="sr-title">Shift review</h2>
      {q.isError ? (
        <div className="sr-card sr-error" role="alert">This review is unavailable.</div>
      ) : !d ? (
        <div className="sr-card sr-loading" role="status">Loading review…</div>
      ) : (
        <>
          <section className="sr-card">
            <h3 className="sr-card-title sr-big">{d.staff.name}</h3>
            <p className="sr-muted">{d.venueName} · {d.roleName}</p>
            <p className="sr-muted">{day(d.startsAt)} · {hm(d.startsAt)}–{hm(d.endsAt)}</p>
          </section>
          <section className="sr-card">
            <h3 className="sr-card-title">Reviewed by {d.reviewer.name}</h3>
            <p className="sr-muted sr-small">{d.reviewer.role} · Submitted {stamp(d.submittedAt)}</p>
            <div className="sr-score-row sr-plain">
              <span>Review score</span>
              <strong>{fmt(d.score)} / 5</strong>
            </div>
          </section>
          <section className="sr-card">
            <h3 className="sr-card-title">Staff performance</h3>
            {CATEGORIES.map(([key, label]) => (
              <div key={key} className="sr-score-row sr-plain">
                <span>{label}</span>
                <strong>{d.ratings[key]} / 5</strong>
              </div>
            ))}
            <p className="sr-footnote">1 Poor · 2 Needs improvement · 3 Satisfactory · 4 Good · 5 Excellent</p>
          </section>
          <section className="sr-card">
            <h3 className="sr-card-title">Written feedback</h3>
            <p className="sr-feedback">{d.feedback ?? 'No written feedback was left for this shift.'}</p>
          </section>
          <p className="sr-footnote">Only submitted feedback is visible. Scores and comments belong to the reviewing venue manager.</p>
        </>
      )}
    </div>
  );
}
