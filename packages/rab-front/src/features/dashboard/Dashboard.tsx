import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import {
  IconArrowUpRight, IconCalendar, IconCheck, IconChevronLeft, IconChevronRight, IconCircleDashed, IconClock,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import { fetchAllPages } from '../../shared/table-toolbar/pagination';
import Avatar from '../../shared/components/Avatar';
import AnimatedNumber, { COUNT_EASE } from '../../shared/components/AnimatedNumber';
import { EmptyState, ListSkeleton } from '../../shared/components/LoadingState';
import { ListError, listErrorStatus, useRetryUnlessPermanent } from '../../shared/table-toolbar/ListPresentation';
import { timeAgo } from '../../shared/lib/timeAgo';
import { useCurrentProfile } from '../../shared/hooks/useCurrentProfile';
import { getUserId, subscribeToSession } from '../../shared/lib/auth-session';
import { duration, ease, layoutSpring, period, staggerDelay, tooltip, usePrefersReducedMotion } from '../../shared/motion';
import './dashboard.css';

/**
 * Crewflow dashboard (2026-10-19 reference). Every figure comes from an existing, already-authorised endpoint:
 * counts are the server's `total` for a filtered list (`limit: 1`), never `.length` of a page-capped download. Each
 * card loads and fails on its own (error + Retry, never a fake empty state). Motion: first-load entrance only — a
 * background refetch updates values in place (numbers tween, bars morph) without replaying the entrance.
 */

// ── Shared helpers ────────────────────────────────────────────────────────────
type Page<T> = { data: T[]; total: number };
interface ShiftRow {
  id: string; venueId: string; startsAt: string; endsAt: string; requiredCount: number; filledCount: number; status: string;
  createdBy?: string | null; requestedBy?: string | null;
}
interface VenueRow { id: string; name: string }
interface AttendanceRow { id: string; clockInAt: string; workedMinutes: number | null }
interface OfferRow { id: string; status: string; sentAt: string; staffName: string; venueName: string; startsAt: string }
interface PipelineSummary {
  summary: Record<string, number>;
  report: { ready: boolean; finalisedAt?: string | null } | null;
  shift: { id: string; venueName: string; roleName: string; startsAt: string; endsAt: string };
}

const DAY_MS = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek = (d: Date) => { const s = startOfDay(d); const dow = (s.getDay() + 6) % 7; return new Date(s.getTime() - dow * DAY_MS); };
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const ymd = (d: Date) => d.toLocaleDateString('sv-SE');
const fmtRange = (a: Date, b: Date) => `${a.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${b.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const listOf = <T,>(data: Page<T> | T[]): T[] => (Array.isArray(data) ? data : data.data ?? []);

/** Server-side COUNT for a filtered list: the endpoint's `total`, fetched with `limit: 1`. */
function useCount(key: unknown[], url: string, params: Record<string, string | undefined>) {
  return useQuery({
    queryKey: ['dashboard', 'count', url, ...key],
    queryFn: async () => (await api.get<Page<unknown>>(url, { params: { ...params, limit: 1 } })).data.total ?? 0,
    staleTime: 30_000,
  });
}

function greeting(now: Date) {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/**
 * Dashboard entry (owner decision 2026-10-20): EVERY deliberate entry — first load or navigating back from another page,
 * even with cached data — replays the short reveal: cards rise in, numbers count up from 0 and slow into their real
 * values, bars and fills grow. The route component mounts on each entry, so mount IS the entry signal (no Date.now keys,
 * no refetch). `entering` stays true only for the reveal window; afterwards changed data morphs quickly from the shown
 * value and unchanged polling does nothing. Dashboard content is keyed by the signed-in identity, so an account switch
 * discards the previous account's values instead of animating them into the new ones.
 */
const ENTRY_WINDOW_MS = 1700;
const EntranceContext = createContext(true);

function useEntering(): boolean {
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setEntering(false), ENTRY_WINDOW_MS);
    return () => window.clearTimeout(t);
  }, []);
  return entering;
}

/**
 * A card's own reveal window: opens when its data first becomes available (so late data still reveals) and closes
 * after the reveal. Bars/fills mount at that moment growing from 0 with the slow transition; changes after the window
 * morph from their current geometry with the quick one.
 */
const REVEAL_WINDOW_MS = 1600;
function useRevealWindow(ready: boolean): boolean {
  const [phase, setPhase] = useState<'waiting' | 'revealing' | 'settled'>('waiting');
  useEffect(() => {
    if (!ready || phase === 'settled') return;
    if (phase === 'waiting') setPhase('revealing');
    const t = window.setTimeout(() => setPhase('settled'), REVEAL_WINDOW_MS);
    return () => window.clearTimeout(t);
  }, [ready, phase]);
  return phase !== 'settled';
}

function barTransition(reduce: boolean, revealing: boolean, index = 0) {
  if (reduce) return { duration: 0 };
  return revealing ? { duration: 1.05, ease: COUNT_EASE, delay: Math.min(index, 8) * 0.035 } : { duration: 0.5, ease: COUNT_EASE };
}

const pctFormat = (n: number) => `${Math.round(n)}%`;

/** First-load entrance only (`initial` runs once per mount); reduced motion: no movement, no stagger. */
function Reveal({ index = 0, children, className, style }: { index?: number; children: ReactNode; className?: string; style?: CSSProperties }) {
  const reduce = usePrefersReducedMotion();
  const entrance = useContext(EntranceContext);
  return (
    <motion.div className={className} style={style} initial={reduce || !entrance ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.page, ease: ease.out, delay: reduce ? 0 : staggerDelay(index) }}>
      {children}
    </motion.div>
  );
}

function Card({ title, subtitle, to, index, className = '', children }: { title: string; subtitle?: string; to?: string; index: number; className?: string; children: ReactNode }) {
  return (
    <Reveal index={index} className={`dash-card ${className}`}>
      <div className="dash-card-head">
        <div>
          <h2 className="dash-card-title">{title}</h2>
          {subtitle && <p className="dash-card-subtitle">{subtitle}</p>}
        </div>
        {to && <Link className="dash-card-link" to={to} aria-label={`Open ${title}`}><IconArrowUpRight size={16} stroke={1.6} /></Link>}
      </div>
      {children}
    </Reveal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { data: profile } = useCurrentProfile();
  const [now] = useState(() => new Date());
  const weekStart = startOfWeek(now);
  const { data: summary } = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: async () => (await api.get('/dashboard/summary')).data as { staffCount?: number | null; managerCount?: number | null; venueManagerCount?: number | null; venueCount?: number | null; activeOfferCount?: number | null },
  });
  const name = profile?.firstName?.trim();
  const identity = useSyncExternalStore(subscribeToSession, getUserId) ?? 'session';
  const entrance = useEntering();
  // Identity fence: when the signed-in account changes under a mounted Dashboard, nothing from the previous account is
  // painted (let alone animated into the new values) — its dashboard caches are dropped first, then the page starts fresh.
  const qc = useQueryClient();
  const [boundIdentity, setBoundIdentity] = useState(identity);
  useEffect(() => {
    if (identity === boundIdentity) return;
    qc.removeQueries({ queryKey: ['dashboard'] });
    qc.removeQueries({ queryKey: ['dashboard-summary'] });
    qc.removeQueries({ queryKey: ['profile'] });
    setBoundIdentity(identity);
  }, [identity, boundIdentity, qc]);
  // A Manager counts the Venue Managers of their own workspace (the Users → Venue managers list); a CEO / platform admin
  // the organisation's Managers. `null` means "not available to you" (shown as –), never a fabricated 0.
  const people: readonly [string, number | null | undefined] = summary?.venueManagerCount != null || summary?.managerCount == null
    ? ['Venue managers', summary?.venueManagerCount]
    : ['Managers', summary?.managerCount];

  if (identity !== boundIdentity) return <div className="page dashboard-page" aria-busy="true" />;

  return (
    <EntranceContext.Provider value={entrance}>
    <div className="page dashboard-page" key={identity}>
      {/* No visible page title (owner request); kept for screen readers. */}
      <h1 className="visually-hidden">Dashboard</h1>
      <div className="page-scroll dash-scroll">
        <Reveal index={0} className="dash-greeting">
          <div>
            <h2 className="dash-hello">{greeting(now)}{name ? `, ${name}` : ''}</h2>
            <p className="dash-hello-sub">Your workforce, shifts and venue activity at a glance.</p>
          </div>
          <p className="dash-week"><IconCalendar size={15} stroke={1.6} aria-hidden="true" />{fmtRange(weekStart, addDays(weekStart, 6))}</p>
        </Reveal>

        <Reveal index={1} className="dash-overview">
          <OfferStrip now={now} />
          <dl className="dash-counts">
            {([['Staff', summary?.staffCount], people, ['Venues', summary?.venueCount]] as const).map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd>{value == null ? '–' : <AnimatedNumber value={value} reveal />}</dd></div>
            ))}
          </dl>
        </Reveal>

        <div className="dash-grid">
          <ProfileCard index={2} />
          <HoursWorked index={3} now={now} />
          <ShiftsByVenue index={4} now={now} />
          <Readiness index={5} now={now} />
          <OfferPipeline index={6} />
          <WeekCalendar index={7} now={now} />
        </div>

        <RecentOffers index={8} />
      </div>
    </div>
    </EntranceContext.Provider>
  );
}

// ── Offer / open-shift strip ──────────────────────────────────────────────────
function OfferStrip({ now }: { now: Date }) {
  const reduce = usePrefersReducedMotion();
  const pending = useCount(['pending'], '/offers', { status: 'pending' });
  const accepted = useCount(['staff_accepted'], '/offers', { status: 'staff_accepted' });
  const confirmed = useCount(['manager_confirmed'], '/offers', { status: 'manager_confirmed' });
  const horizon = { from: now.toISOString(), to: addDays(now, 30).toISOString() };
  const open = useCount(['open', horizon.from.slice(0, 13)], '/shifts', { ...horizon, status: 'open' });
  const upcoming = useCount(['upcoming', horizon.from.slice(0, 13)], '/shifts', horizon);
  const offerQueries = [pending, accepted, confirmed];
  const failed = offerQueries.some((q) => q.isError);
  const total = (pending.data ?? 0) + (accepted.data ?? 0) + (confirmed.data ?? 0);
  const segments = [
    { key: 'pending', label: 'Offers pending', value: pending.data ?? 0, cls: 'is-dark' },
    { key: 'accepted', label: 'Accepted', value: accepted.data ?? 0, cls: 'is-warm' },
    { key: 'confirmed', label: 'Confirmed', value: confirmed.data ?? 0, cls: 'is-hatched' },
  ];
  const loading = offerQueries.some((q) => q.isLoading);
  const revealing = useRevealWindow(!loading && !failed);
  return (
    <div className="dash-strip" aria-label="Offer progress">
      {failed ? <div className="dash-strip-error"><ListError retry={() => offerQueries.forEach((q) => q.refetch())} /></div> : segments.map((s, i) => {
        const share = pct(s.value, total);
        // Width = the category's real share (static: never an animated column). The FILL reveals inside it; a genuine 0%
        // is an empty track, never a filled pill.
        return (
          <div key={s.key} className="dash-strip-item" style={{ flexGrow: loading ? 1 : Math.max(share, 12) }} title={`${s.value} of ${total} current offers`}>
            <span className="dash-strip-label">{s.label}</span>
            <span className={`dash-strip-pill ${s.cls}${!loading && share === 0 ? ' is-empty' : ''}`}>
              <motion.span className="dash-strip-fill" aria-hidden="true" style={{ transformOrigin: 'left' }}
                initial={reduce ? false : { scaleX: 0 }} animate={{ scaleX: !loading && share > 0 ? 1 : 0 }} transition={barTransition(reduce, revealing, i)} />
              <span className="dash-strip-value">{loading ? '–' : <AnimatedNumber value={share} format={pctFormat} reveal revealDurationS={1.15} />}</span>
            </span>
          </div>
        );
      })}
      <div className="dash-strip-item is-fixed" title={upcoming.data != null && open.data != null ? `${open.data} of ${upcoming.data} shifts in the next 30 days are open` : undefined}>
        <span className="dash-strip-label">Open shifts</span>
        <span className="dash-strip-pill is-outline"><span className="dash-strip-value">{open.isError || upcoming.isError ? '–' : open.data == null || upcoming.data == null ? '–' : <AnimatedNumber value={pct(open.data, upcoming.data)} format={pctFormat} reveal revealDurationS={1.15} />}</span></span>
      </div>
    </div>
  );
}

// ── Manager profile ───────────────────────────────────────────────────────────
function ProfileCard({ index }: { index: number }) {
  const { data: profile } = useCurrentProfile();
  const full = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ');
  const initials = full.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <Reveal index={index} className="dash-card dash-profile">
      {/* The authenticated manager's own image, or initials — never a stock portrait. */}
      {profile?.avatarKey
        ? <div className="dash-profile-photo"><Avatar imageKey={profile.avatarKey} label={full || 'Account'} variant="xl" alt={full || 'Your profile photo'} /></div>
        : <div className="dash-profile-initials" aria-hidden="true">{initials || '·'}</div>}
      <div className="dash-profile-foot">
        <div>
          <p className="dash-profile-name">{full || 'Your profile'}</p>
          <p className="dash-profile-role">{profile?.jobTitle || 'Your workspace'}</p>
        </div>
        <Link className="dash-card-link is-light" to="/settings/profile" aria-label="Open your profile settings"><IconArrowUpRight size={16} stroke={1.6} /></Link>
      </div>
    </Reveal>
  );
}

// ── Hours worked (last 7 days, real attendance) ──────────────────────────────
function HoursWorked({ index, now }: { index: number; now: Date }) {
  const reduce = usePrefersReducedMotion();
  const [hover, setHover] = useState<number | null>(null);
  const from = addDays(startOfDay(now), -6);
  const q = useQuery({
    queryKey: ['dashboard', 'hours', ymd(from)],
    // Every record in the 7 days, in pages of 200 (Phase C1: was one capped request of 1,000).
    queryFn: () => fetchAllPages<AttendanceRow>('/attendance', { clockInFrom: from.toISOString(), clockInTo: now.toISOString() }),
  });
  const days = useMemo(() => {
    const out = Array.from({ length: 7 }, (_, i) => ({ date: addDays(from, i), minutes: 0 }));
    for (const r of q.data ?? []) {
      if (r.workedMinutes == null) continue; // still clocked in: not worked time yet
      const i = Math.floor((startOfDay(new Date(r.clockInAt)).getTime() - from.getTime()) / DAY_MS);
      if (i >= 0 && i < 7) out[i].minutes += r.workedMinutes;
    }
    return out;
  }, [q.data, from.getTime()]);
  const max = Math.max(60, ...days.map((d) => d.minutes));
  const worked = days.filter((d) => d.minutes > 0);
  const avg = worked.length ? worked.reduce((s, d) => s + d.minutes, 0) / worked.length / 60 : 0;
  const revealing = useRevealWindow(!!q.data);
  return (
    <Card index={index} title="Hours worked" to="/payroll" className="dash-hours">
      {q.isLoading ? <ListSkeleton rows={3} /> : q.isError ? <ListError retry={q.refetch} error={q.error} /> : (
        <>
          <div className="dash-hours-head">
            <p className="dash-big"><AnimatedNumber value={avg} format={(n) => n.toFixed(1)} reveal /> <small>h</small></p>
            <p className="dash-muted">Avg. workday<br />last 7 days</p>
          </div>
          <div className="dash-bars" role="img" aria-label={`Hours worked per day: ${days.map((d) => `${d.date.toLocaleDateString('en-GB', { weekday: 'short' })} ${(d.minutes / 60).toFixed(1)} h`).join(', ')}`} onMouseLeave={() => setHover(null)}>
            {days.map((d, i) => (
              <div key={ymd(d.date)} className={`dash-bar-col${hover === i ? ' is-hover' : ''}${hover != null && hover !== i ? ' is-dim' : ''}`} onMouseEnter={() => setHover(i)}>
                <div className="dash-bar-track">
                  <motion.span className={`dash-bar${i === 6 ? ' is-today' : ''}`} style={{ transformOrigin: 'bottom' }}
                    initial={reduce ? false : { scaleY: 0 }} animate={{ scaleY: d.minutes / max }} transition={barTransition(reduce, revealing, i)} />
                </div>
                <span className="dash-bar-label">{d.date.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
                <AnimatePresence>
                  {hover === i && (
                    <motion.span className="dash-tooltip" variants={tooltip} initial="hidden" animate="visible" exit="exit">
                      {d.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · {(d.minutes / 60).toFixed(1)} h
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ── Shifts by venue (last 30 days) ────────────────────────────────────────────
function ShiftsByVenue({ index, now }: { index: number; now: Date }) {
  const reduce = usePrefersReducedMotion();
  const from = addDays(startOfDay(now), -30);
  const shifts = useQuery({
    queryKey: ['dashboard', 'shifts-30d', ymd(from)],
    queryFn: () => fetchAllPages<ShiftRow>('/shifts', { from: from.toISOString(), to: now.toISOString() }),
  });
  const venues = useQuery({
    queryKey: ['dashboard', 'venues'],
    queryFn: () => fetchAllPages<VenueRow>('/venues'),
    staleTime: 5 * 60_000,
  });
  const rows = useMemo(() => {
    const names = new Map((venues.data ?? []).map((v) => [v.id, v.name]));
    const counts = new Map<string, number>();
    for (const s of shifts.data ?? []) counts.set(s.venueId, (counts.get(s.venueId) ?? 0) + 1);
    return [...counts.entries()].map(([id, count]) => ({ id, name: names.get(id) ?? 'Venue', count })).sort((a, b) => b.count - a.count).slice(0, 5);
  }, [shifts.data, venues.data]);
  const total = (shifts.data ?? []).length;
  const max = Math.max(1, ...rows.map((r) => r.count));
  const error = shifts.isError ? shifts : venues.isError ? venues : null;
  const revealing = useRevealWindow(!!shifts.data && !!venues.data);
  return (
    <Card index={index} title="Shifts by venue" subtitle="Last 30 days" to="/venues" className="dash-venues">
      {shifts.isLoading || venues.isLoading ? <ListSkeleton rows={4} /> : error ? <ListError retry={error.refetch} error={error.error} /> : rows.length === 0 ? (
        <p className="dash-empty">No shifts in the last 30 days.</p>
      ) : (
        <>
          <LayoutGroup id="dash-venues">
            <ul className="dash-hbars">
              {rows.map((r, i) => (
                <motion.li key={r.id} layout={!reduce} transition={layoutSpring}>
                  <span className="dash-hbar-name" title={r.name}>{r.name}</span>
                  <span className="dash-hbar-track">
                    <motion.span className="dash-hbar" style={{ transformOrigin: 'left' }} initial={reduce ? false : { scaleX: 0 }} animate={{ scaleX: r.count / max }}
                      transition={barTransition(reduce, revealing, i)} />
                  </span>
                  <span className="dash-hbar-value"><AnimatedNumber value={r.count} reveal revealDurationS={1.1} /></span>
                </motion.li>
              ))}
            </ul>
          </LayoutGroup>
          <p className="dash-foot"><AnimatedNumber value={total} reveal /> shift{total === 1 ? '' : 's'} across venues</p>
        </>
      )}
    </Card>
  );
}

// ── Shift readiness + checklist for the next shift (real pipeline data) ───────
/** The exact refusal `RequireWorkspaceGuard` returns when the session has no operational workspace. */
const NO_WORKSPACE_MESSAGE = /no private Workspace yet/i;

type ReadinessErrorKind = 'no-workspace' | 'forbidden' | 'missing' | 'failed';

/** Why a readiness request failed. "No workspace" only when the server said exactly that, never inferred from a 404. */
function readinessErrorKind(error: unknown): ReadinessErrorKind {
  const status = listErrorStatus(error);
  const message = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
  if (status === 403 && typeof message === 'string' && NO_WORKSPACE_MESSAGE.test(message)) return 'no-workspace';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'missing';
  return 'failed';
}

/** The shift list itself failing is never "details missing": a 404 there is a genuine failure (with Retry). */
function shiftListErrorKind(error: unknown): Exclude<ReadinessErrorKind, 'missing'> {
  const kind = readinessErrorKind(error);
  return kind === 'missing' ? 'failed' : kind;
}

function ReadinessError({ kind, retry }: { kind: Exclude<ReadinessErrorKind, 'missing'>; retry: () => unknown }) {
  if (kind === 'no-workspace') {
    return <div className="list-error" role="alert"><p className="feedback-error">No operational workspace is available for your account yet.</p><p>Set up or join a workspace to see shift readiness. Your data has not been changed.</p></div>;
  }
  if (kind === 'forbidden') {
    return <div className="list-error" role="alert"><p className="feedback-error">You don’t have permission to view shift readiness.</p><p>Ask an administrator if you need access. Your data has not been changed.</p></div>;
  }
  return <div className="list-error" role="alert"><p className="feedback-error">We couldn’t load shift readiness.</p><p>Your data has not been changed.</p><button className="btn btn-outline" onClick={() => retry()}>Retry</button></div>;
}

function Readiness({ index, now }: { index: number; now: Date }) {
  const reduce = usePrefersReducedMotion();
  const today = startOfDay(now);
  const userId = useSyncExternalStore(subscribeToSession, getUserId);
  const retry = useRetryUnlessPermanent();
  const next = useQuery({
    queryKey: ['dashboard', 'next-shift', ymd(today)],
    retry,
    queryFn: async () => {
      const rows = listOf((await api.get<Page<ShiftRow>>('/shifts', { params: { from: today.toISOString(), to: addDays(today, 14).toISOString(), sort: 'startsAt', direction: 'asc', limit: 25 } })).data);
      // The next shift that is actually being staffed or worked (not a draft/request/cancelled/finished one).
      return rows.find((s) => ['open', 'offered', 'partially_filled', 'fully_filled', 'confirmed', 'in_progress'].includes(s.status) && new Date(s.endsAt) > now) ?? null;
    },
  });
  // The detailed pipeline is the venue-request view: the server serves it only for a shift the caller requested from a
  // venue (their own `createdBy` with a `requestedBy`). It is requested only for such a shift; for any other shift the
  // card shows the staffing counts the shift list already returned, and never probes the restricted endpoint.
  const detailAllowed = !!next.data && !!userId && next.data.createdBy === userId && !!next.data.requestedBy;
  const pipeline = useQuery({
    queryKey: ['dashboard', 'pipeline', next.data?.id],
    enabled: detailAllowed,
    retry,
    queryFn: async () => (await api.get<PipelineSummary>(`/shifts/${next.data!.id}/pipeline`)).data,
  });
  const pipelineError = pipeline.isError ? readinessErrorKind(pipeline.error) : null;
  // Basic view: the shift is not one the caller requested, or its details are no longer available (404). Only the
  // list's own counts are shown; no check is ever presented as done without the data that proves it.
  const basic = !!next.data && (!detailAllowed || pipelineError === 'missing');
  const s = pipeline.data?.summary ?? {};
  const required = s.required ?? next.data?.requiredCount ?? 0;
  const filled = s.filled ?? 0;
  const arrived = (s.clockedIn ?? 0) + (s.pendingReview ?? 0) + (s.clockedOut ?? 0);
  const basicRequired = next.data?.requiredCount ?? 0;
  const basicFilled = next.data?.filledCount ?? 0;
  type Task = { label: string; meta: string; done: boolean; available: boolean };
  // Basic view: only the staffing check is known (from the shift list); every other check is shown as not available,
  // never as done or to-do.
  const tasks: Task[] = basic ? [
    { label: 'Staff assigned', meta: `${basicFilled} / ${basicRequired} places filled`, done: basicRequired > 0 && basicFilled >= basicRequired, available: true },
    ...['Offers answered', 'Staff confirmed', 'Staff clocked in', 'Attendance reviewed', 'Timesheet ready', 'Timesheet finalised']
      .map((label) => ({ label, meta: 'Not available for this shift', done: false, available: false })),
  ] : pipeline.data ? [
    { label: 'Staff assigned', meta: `${filled} / ${required} places filled`, done: required > 0 && filled >= required },
    { label: 'Offers answered', meta: `${(s.offered ?? 0) + (s.waiting ?? 0)} awaiting a reply`, done: (s.offered ?? 0) + (s.waiting ?? 0) === 0 && filled > 0 },
    { label: 'Staff confirmed', meta: `${s.accepted ?? 0} accepted, awaiting confirmation`, done: (s.accepted ?? 0) === 0 && filled > 0 },
    { label: 'Staff clocked in', meta: `${arrived} / ${filled} arrived`, done: filled > 0 && arrived >= filled },
    { label: 'Attendance reviewed', meta: `${s.pendingReview ?? 0} pending review`, done: filled > 0 && (s.pendingReview ?? 0) === 0 && (s.clockedOut ?? 0) >= filled },
    { label: 'Timesheet ready', meta: pipeline.data.report?.ready ? 'All staff clocked out' : 'Waiting for clock-outs', done: !!pipeline.data.report?.ready },
    { label: 'Timesheet finalised', meta: pipeline.data.report?.finalisedAt ? new Date(pipeline.data.report.finalisedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Not yet signed', done: !!pipeline.data.report?.finalisedAt },
  ].map((t) => ({ ...t, available: true })) : [];
  const done = tasks.filter((t) => t.done).length;
  const stages = basic
    ? [{ label: 'Staffing', value: pct(basicFilled, basicRequired) }]
    : [
      { label: 'Staffing', value: pct(filled, required) },
      { label: 'Attendance', value: pct(arrived, filled) },
      { label: 'Review', value: pct(tasks.slice(4).filter((t) => t.done).length, 3) },
    ];
  const shift = pipeline.data?.shift;
  const when = (iso: string) => `${new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${fmtTime(iso)}`;
  const subtitle = shift ? `${shift.venueName} · ${when(shift.startsAt)}` : basic && next.data ? `Next shift · ${when(next.data.startsAt)}` : 'Next shift in the coming 14 days';
  const revealing = useRevealWindow(basic || !!pipeline.data);
  return (
    <Reveal index={index} className="dash-card dash-readiness">
      <div className="dash-card-head">
        <div>
          <h2 className="dash-card-title">Shift readiness</h2>
          <p className="dash-card-subtitle">{subtitle}</p>
        </div>
        {tasks.length > 0 && !basic && <p className="dash-readiness-pct"><AnimatedNumber value={pct(done, tasks.length)} format={pctFormat} reveal revealDurationS={1.25} /></p>}
      </div>
      {next.isLoading || (detailAllowed && pipeline.isLoading) ? <ListSkeleton rows={4} /> : next.isError ? (
        <ReadinessError kind={shiftListErrorKind(next.error)} retry={next.refetch} />
      ) : !next.data ? (
        <p className="dash-empty">No upcoming shifts in the next 14 days.</p>
      ) : pipelineError && pipelineError !== 'missing' ? <ReadinessError kind={pipelineError} retry={pipeline.refetch} /> : (
        <>
          <div className="dash-stages">
            {stages.map((st, i) => (
              <div key={st.label} className="dash-stage">
                <span className="dash-stage-pct"><AnimatedNumber value={st.value} format={pctFormat} reveal revealDurationS={1.15} /></span>
                <span className="dash-stage-chip">
                  <motion.span className="dash-stage-fill" style={{ transformOrigin: 'left' }} initial={reduce ? false : { scaleX: 0 }} animate={{ scaleX: st.value / 100 }}
                    transition={barTransition(reduce, revealing, i)} />
                  <span className="dash-stage-label">{st.label}</span>
                </span>
              </div>
            ))}
          </div>
          <div className="dash-checklist">
            <div className="dash-checklist-head">
              <h3>Shift checklist</h3>
              {basic ? <small className="dash-checklist-scope">Staffing only</small> : <span><AnimatedNumber value={done} reveal revealDurationS={1.0} />/{tasks.length}</span>}
            </div>
            <ul>
              {tasks.map((t) => (
                <li key={t.label} className={t.done ? 'is-done' : t.available ? '' : 'is-unavailable'}>
                  {t.done ? <IconCheck size={15} stroke={2} aria-hidden="true" /> : <IconCircleDashed size={15} stroke={1.6} aria-hidden="true" />}
                  <div><p>{t.label}<span className="visually-hidden">{t.done ? ' (done)' : t.available ? ' (to do)' : ' (not available)'}</span></p><small>{t.meta}</small></div>
                </li>
              ))}
            </ul>
            {basic ? (
              <p className="dash-checklist-note">
                {pipelineError === 'missing'
                  ? 'The detailed checklist for this shift isn’t available.'
                  : 'The detailed checklist is shown for shifts you requested from a venue.'}
              </p>
            ) : (
              <Link className="dash-checklist-link" to={`/venue-offers/${next.data.id}`}>Open staffing pipeline <IconArrowUpRight size={14} stroke={1.6} /></Link>
            )}
          </div>
        </>
      )}
    </Reveal>
  );
}

// ── Offer pipeline summary ────────────────────────────────────────────────────
function OfferPipeline({ index }: { index: number }) {
  const reduce = usePrefersReducedMotion();
  const pending = useCount(['pending'], '/offers', { status: 'pending' });
  const accepted = useCount(['staff_accepted'], '/offers', { status: 'staff_accepted' });
  const confirmed = useCount(['manager_confirmed'], '/offers', { status: 'manager_confirmed' });
  const declined = useCount(['declined'], '/offers', { status: 'declined' });
  const expired = useCount(['expired'], '/offers', { status: 'expired' });
  const qs = [pending, accepted, confirmed, declined];
  const rows = [
    { label: 'Pending', value: pending.data ?? 0, cls: 'seg-1' },
    { label: 'Accepted', value: accepted.data ?? 0, cls: 'seg-2' },
    { label: 'Confirmed', value: confirmed.data ?? 0, cls: 'seg-3' },
    { label: 'Declined', value: declined.data ?? 0, cls: 'seg-4' },
  ];
  const total = rows.reduce((s, r) => s + r.value, 0);
  const revealing = useRevealWindow(!qs.some((q) => q.isLoading || q.isError));
  return (
    <Card index={index} title="Offer pipeline" subtitle="Current offers by stage" className="dash-pipeline">
      <Link className="dash-card-textlink" to="/offers">All offers <IconArrowUpRight size={13} stroke={1.6} /></Link>
      {qs.some((q) => q.isLoading) ? <ListSkeleton rows={3} /> : qs.some((q) => q.isError) ? <ListError retry={() => qs.forEach((q) => q.refetch())} /> : (
        <>
          <p className="dash-big"><AnimatedNumber value={total} reveal /> <small>offers</small></p>
          <motion.div className={`dash-segments${total === 0 ? ' is-empty' : ''}`} aria-hidden="true"
            initial={reduce ? false : { clipPath: 'inset(0 100% 0 0)' }} animate={{ clipPath: 'inset(0 0% 0 0)' }} transition={barTransition(reduce, revealing)}>
            {rows.filter((r) => r.value > 0).map((r) => (
              <motion.span key={r.label} className={`dash-seg ${r.cls}`} initial={false} animate={{ flexGrow: r.value }} transition={barTransition(reduce, false)} />
            ))}
          </motion.div>
          <dl className="dash-legend">
            {rows.map((r) => <div key={r.label}><dt><i className={r.cls} />{r.label}</dt><dd><AnimatedNumber value={r.value} reveal revealDurationS={1.1} /></dd></div>)}
          </dl>
          {!expired.isError && (expired.data ?? 0) > 0 && (
            <p className="dash-note"><IconClock size={14} stroke={1.6} aria-hidden="true" />{expired.data} offer{expired.data === 1 ? '' : 's'} expired</p>
          )}
        </>
      )}
    </Card>
  );
}

// ── Week calendar (real shifts) ───────────────────────────────────────────────
function WeekCalendar({ index, now }: { index: number; now: Date }) {
  const [offset, setOffset] = useState(0);
  const [dir, setDir] = useState(1);
  const start = addDays(startOfWeek(now), offset * 7);
  const end = addDays(start, 7);
  const shifts = useQuery({
    queryKey: ['dashboard', 'week', ymd(start)],
    queryFn: () => fetchAllPages<ShiftRow>('/shifts', { from: start.toISOString(), to: end.toISOString(), sort: 'startsAt', direction: 'asc' }),
    placeholderData: (prev) => prev,
  });
  const venues = useQuery({ queryKey: ['dashboard', 'venues'], queryFn: () => fetchAllPages<VenueRow>('/venues'), staleTime: 5 * 60_000 });
  const names = new Map((venues.data ?? []).map((v) => [v.id, v.name]));
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const go = (d: number) => { setDir(d); setOffset((o) => o + d); };
  const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return (
    <Reveal index={index} className="dash-card dash-week-card">
      <div className="dash-week-nav">
        <button type="button" className="btn-icon" onClick={() => go(-1)} aria-label="Previous week"><IconChevronLeft size={16} /></button>
        <h2 className="dash-card-title" aria-live="polite">{fmt(start)} – {fmt(addDays(start, 6))}</h2>
        <button type="button" className="btn-icon" onClick={() => go(1)} aria-label="Next week"><IconChevronRight size={16} /></button>
      </div>
      {shifts.isError ? <ListError retry={shifts.refetch} error={shifts.error} /> : (
        <AnimatePresence mode="popLayout" initial={false} custom={dir}>
          <motion.div key={ymd(start)} className="dash-week-grid" custom={dir} variants={period} initial="enter" animate="center" exit="exit">
            {days.map((d) => {
              const events = (shifts.data ?? []).filter((s) => ymd(new Date(s.startsAt)) === ymd(d));
              const isToday = ymd(d) === ymd(now);
              return (
                <div key={ymd(d)} className={`dash-week-day${isToday ? ' is-today' : ''}`}>
                  <p className="dash-week-dow">{d.toLocaleDateString('en-GB', { weekday: 'short' })}</p>
                  <p className="dash-week-date"><span>{d.getDate()}</span></p>
                  <div className="dash-week-events">
                    {shifts.isLoading ? null : events.slice(0, 3).map((s) => (
                      <Link key={s.id} to="/calendar" className={`dash-event status-${s.status}`} title={`${names.get(s.venueId) ?? 'Venue'} · ${fmtTime(s.startsAt)}–${fmtTime(s.endsAt)} · ${s.filledCount}/${s.requiredCount} staff`}>
                        <strong>{names.get(s.venueId) ?? 'Venue'}</strong>
                        <small>{fmtTime(s.startsAt)}</small>
                        <small>{s.filledCount}/{s.requiredCount} staff</small>
                      </Link>
                    ))}
                    {events.length > 3 && <Link to="/calendar" className="dash-event-more">+{events.length - 3} more</Link>}
                  </div>
                </div>
              );
            })}
          </motion.div>
        </AnimatePresence>
      )}
    </Reveal>
  );
}

// ── Recent offers (kept from the previous dashboard) ──────────────────────────
function RecentOffers({ index }: { index: number }) {
  const q = useQuery({
    queryKey: ['dashboard', 'recent-offers'],
    queryFn: async () => listOf((await api.get<Page<OfferRow> | OfferRow[]>('/offers', { params: { sort: 'sentAt', direction: 'desc', limit: 6 } })).data),
  });
  return (
    <Reveal index={index} className="dash-card dash-recent">
      <div className="dash-card-head">
        <h2 className="dash-card-title">Recent offers</h2>
        <Link className="dash-card-textlink" to="/offers">All offers <IconArrowUpRight size={13} stroke={1.6} /></Link>
      </div>
      {q.isLoading ? <ListSkeleton rows={4} /> : q.isError ? <ListError retry={q.refetch} error={q.error} /> : (q.data ?? []).length === 0 ? (
        <EmptyState compact variant="inbox" title="No offers yet." description="Shift offers will appear here after they are sent." />
      ) : (
        <table className="table dash-recent-table">
          <thead><tr><th>Staff</th><th>Venue</th><th>Shift date</th><th>Status</th><th>Sent</th></tr></thead>
          <tbody>
            {(q.data ?? []).map((o) => (
              <tr key={o.id}>
                <td className="cell-primary">{o.staffName ?? '–'}</td>
                <td>{o.venueName ?? '–'}</td>
                <td>{o.startsAt ? new Date(o.startsAt).toLocaleDateString('en-GB') : '–'}</td>
                <td><span className={`badge badge-${o.status}`}>{o.status.replace(/_/g, ' ')}</span></td>
                <td>{timeAgo(o.sentAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Reveal>
  );
}
