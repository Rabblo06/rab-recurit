import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import {
  IconArrowUpRight,
  IconCalendarEvent,
  IconMail,
  IconBuilding,
  IconClock,
  IconClipboardCheck,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import PageHeader from '../../shared/components/PageHeader';
import { ListSkeleton } from '../../shared/components/LoadingState';
import { ListError, useRetryUnlessPermanent } from '../../shared/table-toolbar/ListPresentation';
import { useAiChat } from '../ai/AiChatProvider';
import ShiftTimelinePanel from '../scheduling/ShiftTimelinePanel';
import { isApprovable, type PayrollPeriod } from '../payroll/payrollModel';
import UpNextComposer from './UpNextComposer';
import {
  upcomingShifts,
  awaitingOffers,
  rows,
  when,
  londonDate,
  LONDON,
  statusLabel,
  isUrgent,
  type Shift,
  type Offer,
  type Request,
  type Page,
} from './upNextModel';
import './up-next.css';
export { upcomingShifts } from './upNextModel';

type QueryState = { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
function Section({
  title,
  hint,
  to,
  query,
  empty,
  children,
  count,
}: {
  title: string;
  hint?: string;
  to?: string;
  query?: QueryState;
  empty: string;
  children: ReactNode;
  count: number;
}) {
  return (
    <section aria-label={title}>
      <div className="up-next-section-head">
        <h2>
          {title}
          {hint && <span>{hint}</span>}
        </h2>
        {to && (
          <Link to={to}>
            View all <IconArrowUpRight size={12} />
          </Link>
        )}
      </div>
      {query?.isLoading ? (
        <ListSkeleton rows={3} />
      ) : query?.isError ? (
        <ListError error={query.error} retry={query.refetch} />
      ) : count ? (
        <ul className="up-next-list">{children}</ul>
      ) : (
        <p className="up-next-empty">{empty}</p>
      )}
    </section>
  );
}
function Row({
  name,
  detail,
  status,
  date,
  urgent = false,
  icon,
  to,
  onOpen,
}: {
  name: string;
  detail: string;
  status: string;
  date?: string;
  urgent?: boolean;
  icon: ReactNode;
  to?: string;
  onOpen?: () => void;
}) {
  const content = (
    <>
      <span className="up-next-row-icon">{icon}</span>
      <span className="up-next-label">
        <span className="up-next-name">{name}</span>
        <small>{detail}</small>
      </span>
      <span className="up-next-meta">
        <span className={urgent ? 'up-next-status urgent' : 'up-next-status'}>{status}</span>
        {date && <time dateTime={date}>{when(date)}</time>}
      </span>
      <span className="up-next-open" aria-hidden="true">
        <IconArrowUpRight size={16} />
      </span>
    </>
  );
  return (
    <li>
      {to ? (
        <Link to={to}>{content}</Link>
      ) : (
        <button type="button" onClick={onOpen}>
          {content}
        </button>
      )}
    </li>
  );
}
export default function UpNext() {
  const { scope } = useAiChat();
  return <UpNextContent key={scope} scope={scope} />;
}
function UpNextContent({ scope }: { scope: string }) {
  const [now, setNow] = useState(() => new Date());
  const [timeline, setTimeline] = useState<Shift | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const retry = useRetryUnlessPermanent();
  const shell = useOutletContext<{ openSearch?: () => void } | undefined>();
  const day = londonDate(now),
    month = day.slice(0, 7);
  const caps = useQuery({
    queryKey: ['up-next', scope, 'capabilities'],
    queryFn: async () => (await api.get<Record<string, boolean>>('/auth/capabilities')).data,
    retry,
    staleTime: 60000,
  });
  const can = (permission: string) => caps.data?.[permission] === true;
  const readSchedule = can('schedule.view'),
    reviewOffers = readSchedule && can('offer.confirm'),
    reviewRequests = can('staffing_request.approve');
  const reviewPayroll = can('payroll.view') && (can('payroll.approve') || can('attendance.view'));
  const shifts = useQuery({
    queryKey: ['up-next', scope, 'shifts', day],
    enabled: readSchedule,
    retry,
    refetchInterval: 60000,
    queryFn: async () =>
      rows(
        (
          await api.get<Page<Shift> | Shift[]>('/shifts', {
            params: {
              from: new Date(now.getTime() - 86400000).toISOString(),
              to: new Date(now.getTime() + 14 * 86400000).toISOString(),
              sort: 'startsAt',
              direction: 'asc',
              limit: 100,
            },
          })
        ).data,
      ),
  });
  const venues = useQuery({
    queryKey: ['up-next', scope, 'venues'],
    enabled: readSchedule && can('venue.view'),
    retry,
    queryFn: async () =>
      rows(
        (
          await api.get<Page<{ id: string; name: string }> | { id: string; name: string }[]>('/venues', {
            params: { limit: 100 },
          })
        ).data,
      ),
  });
  const offers = useQuery({
    queryKey: ['up-next', scope, 'offers'],
    enabled: reviewOffers,
    retry,
    refetchInterval: 30000,
    queryFn: async () =>
      rows(
        (
          await api.get<Page<Offer> | Offer[]>('/offers', {
            params: { status: 'staff_accepted', sort: 'sentAt', direction: 'asc', limit: 100 },
          })
        ).data,
      ),
  });
  const requests = useQuery({
    queryKey: ['up-next', scope, 'requests'],
    enabled: reviewRequests,
    retry,
    refetchInterval: 60000,
    queryFn: async () =>
      rows(
        (
          await api.get<Page<Request> | Request[]>('/shifts/requests', {
            params: { status: 'pending', limit: 100 },
          })
        ).data,
      ),
  });
  const payroll = useQuery({
    queryKey: ['up-next', scope, 'payroll', month],
    enabled: reviewPayroll,
    retry,
    refetchInterval: 60000,
    queryFn: async () => (await api.get<PayrollPeriod>('/payroll/period', { params: { month } })).data,
  });
  const upcoming = upcomingShifts(shifts.data ?? [], now),
    accepted = awaitingOffers(offers.data ?? [], now);
  const gaps = upcoming.filter((s) => s.filledCount < s.requiredCount).slice(0, 3);
  const urgent = accepted.filter((o) => isUrgent(o.expiresAt, now));
  const pending = (requests.data ?? []).filter((r) => r.status === 'pending_manager_approval').sort((a,b) => Date.parse(a.startsAt)-Date.parse(b.startsAt));
  const reviews = (payroll.data?.rows ?? []).filter(
    (r) =>
      (can('payroll.approve') && isApprovable(r)) ||
      (can('attendance.view') && ['under_review', 'disputed'].includes(r.attendanceStatus)),
  );
  const venue = (s: Shift) =>
    s.venueName || venues.data?.find((v) => v.id === s.venueId)?.name || 'Upcoming shift';
  const offerRow = (o: Offer) => (
    <Row
      key={o.id}
      name={o.staffName || 'Accepted offer'}
      detail={[
        o.venueName,
        o.startsAt ? 'Assignment ' + when(o.startsAt) : '',
        o.offerKind && o.offerKind !== 'standard' ? statusLabel(o.offerKind) : '',
      ]
        .filter(Boolean)
        .join(' · ')}
      status={isUrgent(o.expiresAt, now) ? 'Expires soon' : 'Awaiting confirmation'}
      date={o.expiresAt}
      urgent={isUrgent(o.expiresAt, now)}
      icon={<IconMail size={16} />}
      to="/offers?status=staff_accepted"
    />
  );
  const attentionQueries = [
    ...(readSchedule ? [shifts] : []),
    ...(reviewOffers ? [offers] : []),
    ...(reviewRequests ? [requests] : []),
  ];
  return (
    <div className="up-next-page">
      <PageHeader title="Up next" />
      <main className="up-next-content">
        <header className="up-next-intro">
          <p className="up-next-date">
            {now.toLocaleDateString('en-GB', {
              timeZone: LONDON,
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </p>
          <h1>Your next move.</h1>
          <p>A clear view of your team, shifts and priorities.</p>
          <span>
            <IconClock size={12} /> London time
          </span>
        </header>
        {caps.isLoading ? (
          <ListSkeleton rows={4} />
        ) : caps.isError ? (
          <ListError error={caps.error} retry={caps.refetch} />
        ) : (
          <>
            {(readSchedule || reviewRequests) && (
              <Section
                title="Needs your attention"
                hint="Priorities to review"
                empty="Nothing needs immediate attention in the loaded schedule."
                count={gaps.length + urgent.length + pending.length}
                query={{
                  isLoading: attentionQueries.some((q) => q.isLoading),
                  isError: attentionQueries.some((q) => q.isError),
                  error: attentionQueries.find((q) => q.isError)?.error,
                  refetch: () => Promise.all(attentionQueries.map((q) => q.refetch())),
                }}
              >
                {urgent.slice(0, 3).map(offerRow)}
                {pending.slice(0, 3).map((r) => (
                  <Row
                    key={r.id}
                    name={r.venueName}
                    detail={'Venue request · ' + r.requiredCount + ' staff requested'}
                    status="Pending approval"
                    date={r.startsAt}
                    icon={<IconBuilding size={16} />}
                    onOpen={() =>
                      document.dispatchEvent(
                        new CustomEvent('open-shift-approval', { detail: { shiftId: r.id } }),
                      )
                    }
                  />
                ))}
                {gaps.map((s) => (
                  <Row
                    key={s.id}
                    name={venue(s)}
                    detail={
                      s.requiredCount -
                      s.filledCount +
                      ' unfilled ' +
                      (s.requiredCount - s.filledCount === 1 ? 'position' : 'positions')
                    }
                    status={statusLabel(s.status)}
                    date={s.startsAt}
                    icon={<IconCalendarEvent size={16} />}
                    onOpen={() => setTimeline(s)}
                  />
                ))}
              </Section>
            )}
            {attentionQueries.some((q) => q.isLoading) && (
              <p className="up-next-notice">Checking for further priorities…</p>
            )}
            {attentionQueries.some((q) => q.isError) && (
              <p className="up-next-notice" role="status">
                Some priorities could not be loaded. Retry the affected section below.
              </p>
            )}
            {reviewRequests && requests.isError && (
              <ListError error={requests.error} retry={requests.refetch} />
            )}
            {reviewRequests && pending.length > 3 && (
              <Link className="up-next-more" to="/venue-offers">
                View all venue requests
              </Link>
            )}
            {readSchedule && (
              <Section
                title="Upcoming shifts"
                hint="Next 14 days · first 6"
                to="/shifts"
                query={shifts}
                count={upcoming.length}
                empty="No upcoming shifts to show. Your next shifts will appear here."
              >
                {upcoming.slice(0, 6).map((s) => (
                  <Row
                    key={s.id}
                    name={venue(s)}
                    detail={s.filledCount + ' / ' + s.requiredCount + ' staffed · Ends ' + when(s.endsAt)}
                    status={statusLabel(s.status)}
                    date={s.startsAt}
                    icon={<IconCalendarEvent size={16} />}
                    onOpen={() => setTimeline(s)}
                  />
                ))}
              </Section>
            )}
            {reviewOffers && (
              <Section
                title="Awaiting confirmation"
                hint="Manual review · first 6"
                to="/offers?status=staff_accepted"
                query={offers}
                count={accepted.length}
                empty="You're up to date. No accepted offers are waiting for confirmation."
              >
                {accepted.slice(0, 6).map(offerRow)}
              </Section>
            )}
            {reviewPayroll && (
              <Section
                title="Attendance & timesheets"
                hint="This month · first 6"
                to="/payroll"
                query={payroll}
                count={reviews.length}
                empty="No attendance or timesheets need your review this month."
              >
                {reviews.slice(0, 6).map((r) => (
                  <Row
                    key={r.attendanceId}
                    name={r.staffName}
                    detail={r.venueName}
                    status={
                      ['under_review', 'disputed'].includes(r.attendanceStatus)
                        ? statusLabel(r.attendanceStatus)
                        : 'Ready for payroll review'
                    }
                    date={r.startsAt}
                    icon={<IconClipboardCheck size={16} />}
                    to="/payroll"
                  />
                ))}
              </Section>
            )}
            {!readSchedule && !reviewRequests && !reviewPayroll && (
              <p className="up-next-empty">No staffing queues are available with your current permissions.</p>
            )}
          </>
        )}
        <UpNextComposer onSearch={shell?.openSearch} />
      </main>
      <ShiftTimelinePanel
        shiftId={timeline?.id ?? null}
        title={timeline ? venue(timeline) : undefined}
        onClose={() => setTimeline(null)}
      />
    </div>
  );
}
