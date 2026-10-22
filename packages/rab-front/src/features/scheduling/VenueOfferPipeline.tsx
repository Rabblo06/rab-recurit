import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  IconAlertCircle,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUpRight,
  IconCalendar,
  IconChartBar,
  IconClock,
  IconLayoutKanban,
  IconPlus,
  IconSearch,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import Avatar from '../../shared/components/Avatar';
import Drawer from '../../shared/components/Drawer';
import { toast } from '../../shared/lib/toast';
import { PageSlot } from '../../shared/page-slots';
import { layoutSpring, listItem } from '../../shared/motion';
import VenueOfferPipelineAnalytics, { initials, rowStatus } from './VenueOfferPipelineAnalytics';
import {
  PIPELINE_TABS,
  attentionFor,
  isProvisionalNoShow,
  normaliseStage,
  stageCountsOf,
  stageLanes,
  tabCounts,
  type PipelineTab,
  type StageDef,
} from './VenueOfferPipelineStages';
import './venue-offer-pipeline.css';

export interface PipelineStaff {
  staffProfileId: string;
  name: string;
  avatarFileId: string | null;
  offerId: string;
  /** Server lane key: the contract's snake_case (`staff_accepted`) or the older label (`'STAFF ACCEPTED'`). */
  stage: string;
  offerStatus: string;
  assignmentStatus: string;
  attendanceStatus: string | null;
  sentAt: string;
  acceptedAt: string | null;
  respondedAt: string | null;
  cancelledAt: string | null;
  terminalSource: string | null;
  clockInAt: string | null;
  clockOutAt: string | null;
  breakMinutes: number | null;
  workedMinutes: number | null;
  declineReason: string | null;
  withdrawnReason: string | null;
  rejectionReason: string | null;
  canManagerCancel: boolean;
  /** The seat's attendance review is complete (server `shift_assignment.attendance_reviewed_at`). */
  attendanceReviewed?: boolean;
  /** Earlier offers to the same person on this shift (the card shows their latest one). */
  earlierOffers?: number;
  /** Arrival check-in (not worked time), when the server provides it. */
  checkedInAt?: string | null;
  /** Authoritative offer kind from the server; the card tags only `replacement` / `standby`. */
  offerKind?: string | null;
}
interface ReportRow {
  roleName?: string;
  staffProfileId: string;
  staffName: string;
  avatarFileId: string | null;
  clockInAt: string | null;
  clockOutAt: string | null;
  breakMinutes: number | null;
  workedMinutes: number | null;
  attendanceStatus: string | null;
  assignmentStatus: string;
  corrected: boolean;
}
interface Report {
  ready: boolean;
  originalFileId: string | null;
  signedFileId: string | null;
  reportStatus: string;
  finalisedByName: string | null;
  finalisedAt: string | null;
  staff: ReportRow[];
}
export interface Pipeline {
  shift: {
    id: string;
    venueName: string;
    roleName: string;
    startsAt: string;
    endsAt: string;
    status: string;
    requiredCount: number;
  };
  serverNow?: string;
  stages: string[];
  summary: Record<string, number>;
  stageCounts?: Record<string, number>;
  tableStatus: string;
  staff: PipelineStaff[];
  report: Report | null;
  replacementPlaces: number;
  /** Replacement/standby state (newer API). Absent on older builds → fall back to `replacementPlaces`. */
  replacement?: {
    vacancy: number;
    confirmedNoShows: number;
    provisionalNoShows: number;
    nextOfferKind: string;
    canSend: boolean;
  } | null;
}
const time = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const dateTime = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';
const minutes = (value: number | null) =>
  value == null ? '—' : `${Math.floor(value / 60)}h ${value % 60}m`;

const TERMINAL = new Set(['rejected', 'cancelled', 'deleted']);

/** The time line of a card (clock icon), from the persisted facts behind its lane. */
function cardTime(row: PipelineStaff, stage: string, shift: Pipeline['shift']): string {
  if (TERMINAL.has(stage)) return dateTime(row.cancelledAt || row.respondedAt);
  switch (stage) {
    case 'offered':
    case 'waiting':
      return `Sent ${dateTime(row.sentAt)}`;
    case 'checked_in':
      return row.checkedInAt ? `Checked in ${time(row.checkedInAt)}` : `${time(shift.startsAt)}–${time(shift.endsAt)}`;
    case 'clocked_in':
      return `In ${time(row.clockInAt)}`;
    case 'pending_review':
    case 'clocked_out':
      return row.clockOutAt
        ? `${time(row.clockInAt)}–${time(row.clockOutAt)} · ${minutes(row.workedMinutes)}`
        : `In ${time(row.clockInAt)} · no clock-out`;
    default:
      return `${time(shift.startsAt)}–${time(shift.endsAt)}`;
  }
}

/** One short status note per card where the lane alone does not say enough. */
function cardNote(row: PipelineStaff, stage: string, startsAt: string): string | null {
  if (TERMINAL.has(stage)) return row.terminalSource;
  switch (stage) {
    case 'waiting':
      return 'Opened · awaiting response';
    case 'staff_accepted':
      return `Accepted ${time(row.acceptedAt)} · awaiting confirmation`;
    case 'late':
      return `Not clocked in · started ${time(startsAt)}`;
    case 'checked_in':
      return 'Arrived · not yet clocked in';
    case 'pending_review':
      return row.attendanceStatus === 'missing_clock_out'
        ? `Clock-out missing · in ${time(row.clockInAt)}`
        : row.attendanceStatus === 'disputed'
          ? 'Attendance disputed · awaiting review'
          : `Corrected · out ${time(row.clockOutAt)} · awaiting review`;
    case 'attendance_missing':
      return 'No clock-in recorded · needs review';
    case 'no_show':
      return isProvisionalNoShow(row) ? 'No clock-in recorded · needs review' : 'No-show confirmed by manager';
    default:
      return null;
  }
}

function needsAttention(row: PipelineStaff): boolean {
  const stage = normaliseStage(row.stage);
  return (
    ['late', 'pending_review', 'attendance_missing'].includes(stage) ||
    isProvisionalNoShow(row) ||
    (stage === 'clocked_out' && row.attendanceReviewed === false)
  );
}

function openStaff(row: PipelineStaff, notes = false) {
  document.dispatchEvent(
    new CustomEvent('open-user-detail', {
      detail: {
        id: row.staffProfileId,
        type: 'staff',
        tab: notes ? 'notes' : 'home',
      },
    }),
  );
}

/** CSV cell, quoted, with spreadsheet formula injection neutralised. */
const csvCell = (value: unknown) => {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

type Filter = 'all' | 'attention' | 'reviewed';
type Sort = 'name' | 'name-desc' | 'recent' | 'clock-in';
const FILTERS: Array<[Filter, string]> = [
  ['all', 'Filter: All staff'],
  ['attention', 'Filter: Needs attention'],
  ['reviewed', 'Filter: Reviewed'],
];
const SORTS: Array<[Sort, string]> = [
  ['name', 'Sort: Name'],
  ['name-desc', 'Sort: Name (Z–A)'],
  ['recent', 'Sort: Recently sent'],
  ['clock-in', 'Sort: Clock-in time'],
];

/** Owner-approved readiness copy for the Timesheet report action (shown only in response to that action). */
export const TIMESHEET_NOT_READY = "Timesheet isn't ready yet. Wait until all required staff have clocked out.";
export const TIMESHEET_READY = 'Timesheet is ready. All required staff have clocked out.';

/**
 * Opens the existing Send offers drawer (ShiftDrawers, mounted by the shell) in REPLACEMENT mode for this shift.
 * Event: `open-send-offer`, detail `{ shiftId, mode: 'replacement', shift? }` — `shift` is the full shift record when it
 * could be read, so a drawer that still needs it keeps working.
 */
export const SEND_OFFER_EVENT = 'open-send-offer';

export default function VenueOfferPipeline() {
  const { shiftId } = useParams();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [cancel, setCancel] = useState<PipelineStaff | null>(null);
  const [reason, setReason] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const [review, setReview] = useState<PipelineStaff | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('name');
  const [opening, setOpening] = useState(false);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Set when the manager asked for the timesheet before it was ready: once the board then reports it ready, they
  // get the "ready" toast once. Never on page load or on a poll that merely confirms the same state.
  const awaitingTimesheet = useRef(false);
  const query = useQuery({
    queryKey: ['venue-pipeline', shiftId],
    queryFn: async () =>
      (await api.get<Pipeline>(`/shifts/${shiftId}/pipeline`)).data,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
  // Display hints only: the send routes enforce `offer.send` and the shift's ownership themselves.
  const capabilities = useQuery({
    queryKey: ['auth', 'capabilities'],
    queryFn: async () => (await api.get<Record<string, boolean>>('/auth/capabilities')).data,
    staleTime: 300_000,
  });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get<{ roles: string[] }>('/auth/me')).data,
    staleTime: 300_000,
  });
  const canSendOffer =
    capabilities.data?.['offer.send'] === true &&
    Array.isArray(me.data?.roles) &&
    !me.data!.roles.includes('venue_manager');
  const avatarIds = [
    ...new Set(
      [
        ...(query.data?.staff ?? []).map((r) => r.avatarFileId),
        ...(query.data?.report?.staff ?? []).map((r) => r.avatarFileId),
      ].filter((id): id is string => !!id),
    ),
  ].sort();
  const avatars = useQuery({
    queryKey: ['pipeline-avatars', avatarIds],
    enabled: avatarIds.length > 0,
    staleTime: 60000,
    refetchInterval: 60000,
    queryFn: async () => {
      const previews: Record<string, string> = {};
      for (let i = 0; i < avatarIds.length; i += 32)
        Object.assign(
          previews,
          (
            await api.post('/files/previews', {
              fileIds: avatarIds.slice(i, i + 32),
            })
          ).data.previews,
        );
      return previews;
    },
  });
  const timesheetReady = query.data?.report?.ready;
  useEffect(() => {
    if (timesheetReady && awaitingTimesheet.current) {
      awaitingTimesheet.current = false;
      toast.success(TIMESHEET_READY);
    }
  }, [timesheetReady]);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['venue-pipeline', shiftId] });
    await qc.invalidateQueries({ queryKey: ['venue-offers'] });
  };
  // After the Send offers drawer succeeds for THIS shift, refresh the board at once (not on the next poll): its send
  // mutation carries `shiftId` in its variables; an explicit `offers-sent` event is honoured too.
  useEffect(() => {
    const matches = (detail: unknown) =>
      !!detail && typeof detail === 'object' && (detail as { shiftId?: unknown }).shiftId === shiftId;
    const onSent = (e: Event) => {
      if (matches((e as CustomEvent).detail)) void refresh();
    };
    document.addEventListener('offers-sent', onSent);
    const unsubscribe = qc.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'success' && matches(event.mutation.state.variables))
        void refresh();
    });
    return () => {
      document.removeEventListener('offers-sent', onSent);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, shiftId]);
  const withdrawal = useMutation({
    mutationFn: () =>
      api.post(`/shifts/${shiftId}/pipeline/offers/${cancel!.offerId}/cancel`, {
        reason: reason.trim() || undefined,
      }),
    onSuccess: async () => {
      setCancel(null);
      setReason('');
      await refresh();
    },
  });
  const data = query.data;
  const lanes = useMemo(() => (data ? stageLanes(data) : []), [data]);
  const counts = useMemo(() => (data ? stageCountsOf(data) : {}), [data]);
  const file = async (id: string, download: boolean) => {
    const tab = download ? null : window.open('', '_blank');
    try {
      const res = await api.get(`/files/${id}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      if (download) {
        const link = document.createElement('a');
        link.href = url;
        link.download = 'timesheet.pdf';
        link.click();
      } else if (tab) {
        tab.opener = null;
        tab.location.href = url;
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      tab?.close();
      toast.error('Could not open this timesheet. Please retry.');
    }
  };
  if (query.isPending)
    return (
      <div className="page pipeline">
        <Link to="/venue-offers">&larr; Venue Offers</Link>
        <p role="status">Loading staffing pipeline...</p>
      </div>
    );
  if (query.isError || !data)
    return (
      <div className="page pipeline">
        <Link to="/venue-offers">&larr; Venue Offers</Link>
        <h1>Could not load staffing pipeline</h1>
        <p>This request may be unavailable or outside your workspace.</p>
        <button className="btn btn-outline" onClick={() => query.refetch()}>
          Retry
        </button>
      </div>
    );
  const report = data.report;
  const staff = data.staff ?? [];
  const tabTotals = tabCounts(lanes, counts);
  const view = params.get('view') === 'analytics' ? 'analytics' : 'pipeline';
  const requestedTab = params.get('tab');
  const started = new Date(data.serverNow ?? Date.now()).getTime() >= new Date(data.shift.startsAt).getTime();
  const tab: PipelineTab = PIPELINE_TABS.some((t) => t.key === requestedTab)
    ? (requestedTab as PipelineTab)
    : started && tabTotals.attendance > 0
      ? 'attendance'
      : 'staffing';
  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value == null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  const attention = attentionFor(staff, counts);

  const term = search.trim().toLowerCase();
  const filtering = term !== '' || filter !== 'all';
  const visible = staff
    .filter((row) => !term || row.name.toLowerCase().includes(term))
    .filter((row) =>
      filter === 'attention' ? needsAttention(row) : filter === 'reviewed' ? row.attendanceReviewed === true : true,
    )
    .sort((a, b) => {
      switch (sort) {
        case 'name-desc':
          return b.name.localeCompare(a.name);
        case 'recent':
          return new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime();
        case 'clock-in':
          return (
            (a.clockInAt ? new Date(a.clockInAt).getTime() : Infinity) -
              (b.clockInAt ? new Date(b.clockInAt).getTime() : Infinity) || a.name.localeCompare(b.name)
          );
        default:
          return a.name.localeCompare(b.name);
      }
    });
  const cardsFor = (lane: StageDef) => visible.filter((row) => normaliseStage(row.stage) === lane.key);
  const visibleInTab = (t: PipelineTab) =>
    lanes.filter((l) => l.tab === t).reduce((sum, lane) => sum + cardsFor(lane).length, 0);

  const openTimesheet = () => {
    if (!report) return;
    if (!report.ready) {
      awaitingTimesheet.current = true;
      toast.error(TIMESHEET_NOT_READY);
      return;
    }
    awaitingTimesheet.current = false;
    setReportOpen(true);
  };
  const sendOffer = async () => {
    if (opening) return;
    setOpening(true);
    let shift: unknown;
    try {
      shift = (await api.get(`/shifts/${shiftId}`)).data;
    } catch {
      shift = undefined; // The drawer can still load the shift itself from `shiftId`.
    } finally {
      setOpening(false);
    }
    document.dispatchEvent(
      new CustomEvent(SEND_OFFER_EVENT, {
        detail: { shiftId, mode: 'replacement', ...(shift && typeof shift === 'object' ? { shift } : {}) },
      }),
    );
  };
  // The server decides whether offers can be sent: `replacement.canSend` (also after a no-show, when the pre-start
  // `replacementPlaces` is 0); older APIs without that block fall back to `replacementPlaces > 0`.
  const replacement = data.replacement ?? null;
  const noPlaces = replacement ? !replacement.canSend : data.replacementPlaces <= 0;
  const sendTitle = noPlaces
    ? 'No open places to offer: the shift is full, has started or has ended.'
    : replacement
      ? replacement.nextOfferKind === 'standby'
        ? 'Offers will be sent as standby'
        : `${replacement.vacancy} ${replacement.vacancy === 1 ? 'place' : 'places'} to fill`
      : undefined;
  const exportCsv = () => {
    const header = ['Staff', 'Role', 'Stage', 'Offer status', 'Booking status', 'Offer sent', 'Clock in', 'Clock out', 'Break (min)', 'Worked (min)', 'Attendance reviewed'];
    const lines = staff.map((row) => {
      const lane = rowStatus(row, lanes);
      return [
        row.name,
        data.shift.roleName,
        lane.label,
        row.offerStatus,
        row.assignmentStatus,
        row.sentAt,
        row.clockInAt ?? '',
        row.clockOutAt ?? '',
        row.breakMinutes ?? '',
        row.workedMinutes ?? '',
        row.attendanceReviewed ? 'Yes' : 'No',
      ]
        .map(csvCell)
        .join(',');
    });
    const blob = new Blob([[header.map(csvCell).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${data.shift.venueName.replace(/[^\w-]+/g, '-')}-${data.shift.startsAt.slice(0, 10)}-pipeline.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = PIPELINE_TABS.length - 1;
    const next =
      e.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (next == null) return;
    e.preventDefault();
    const key = PIPELINE_TABS[next]!.key;
    setParam('tab', key);
    tabRefs.current[key]?.focus();
  };

  const actions = (
    <>
      {report && (
        <button
          className="btn btn-outline pipeline-timesheet-btn"
          onClick={openTimesheet}
          aria-describedby="pipeline-report-state"
        >
          Timesheet report
        </button>
      )}
      {canSendOffer && (
        <button
          className="btn pipeline-send-btn"
          onClick={sendOffer}
          disabled={noPlaces || opening}
          title={sendTitle}
        >
          <IconPlus size={14} aria-hidden /> Send offer
        </button>
      )}
      <span id="pipeline-report-state" className="pipeline-sr">
        {report
          ? report.ready
            ? 'Attendance completed'
            : 'Waiting for all staff to clock out'
          : 'Report access unavailable'}
      </span>
    </>
  );

  const renderCard = (row: PipelineStaff, lane: StageDef, cardIndex: number) => {
    const note = cardNote(row, lane.key, data.shift.startsAt);
    const reason = TERMINAL.has(lane.key) ? row.withdrawnReason || row.declineReason || row.rejectionReason : null;
    const kind = row.offerKind === 'replacement' ? 'Replacement' : row.offerKind === 'standby' ? 'Standby' : null;
    const preview = row.avatarFileId ? avatars.data?.[row.avatarFileId] : undefined;
    return (
      <motion.article
        className="pipeline-card"
        key={row.offerId}
        data-offer-id={row.offerId}
        layout="position"
        variants={listItem}
        custom={cardIndex}
        initial="hidden"
        animate="visible"
        exit="exit"
        transition={{ layout: layoutSpring }}
      >
        <div className="pipeline-card-top">
          <button className="pipeline-person" onClick={() => openStaff(row)}>
            {preview ? (
              <Avatar previewUrl={preview} label={row.name} variant="sidebar" />
            ) : (
              <span className="pipeline-initials" aria-hidden>
                {initials(row.name)}
              </span>
            )}
            <span>
              <strong title={row.name}>{row.name}</strong>
              <small>{data.shift.roleName}</small>
            </span>
          </button>
          <details className="pipeline-menu">
            <summary aria-label={`Actions for ${row.name}`}>&hellip;</summary>
            <div>
              <button onClick={() => openStaff(row)}>View staff</button>
              <button onClick={() => openStaff(row, true)}>Notes</button>
              <button
                disabled={!row.canManagerCancel}
                title={
                  !row.canManagerCancel
                    ? 'Cancellation is closed or this booking is no longer cancellable'
                    : undefined
                }
                onClick={() => {
                  withdrawal.reset();
                  setReason('');
                  setCancel(row);
                }}
              >
                Cancel offer
              </button>
            </div>
          </details>
        </div>
        <p className="pipeline-card-time">
          <IconClock size={13} aria-hidden />
          <span>{cardTime(row, lane.key, data.shift)}</span>
        </p>
        {(note || lane.key === 'clocked_out' || kind) && (
          <p className="pipeline-card-state">
            {note}
            {lane.key === 'clocked_out' && (
              <span className={`pipeline-tag ${row.attendanceReviewed ? 'is-reviewed' : 'is-awaiting'}`}>
                {row.attendanceReviewed ? 'Reviewed' : 'Awaiting review'}
              </span>
            )}
            {kind && <span className="pipeline-tag is-kind">{kind}</span>}
          </p>
        )}
        {reason && <p className="pipeline-reason">{reason}</p>}
        {(row.earlierOffers ?? 0) > 0 && (
          <small className="pipeline-earlier">
            {row.earlierOffers} earlier {row.earlierOffers === 1 ? 'offer' : 'offers'}
          </small>
        )}
        <div className="pipeline-card-foot">
          <span className="pipeline-venue-chip" title={data.shift.venueName}>
            {data.shift.venueName}
          </span>
          <button
            type="button"
            className="pipeline-review"
            aria-label={`Review ${row.name}`}
            onClick={() => setReview(row)}
          >
            Review <IconArrowUpRight size={12} aria-hidden />
          </button>
        </div>
      </motion.article>
    );
  };

  const countLabel = (shown: number, total: number) =>
    filtering && shown !== total ? (
      <span className="pipeline-count" aria-label={`${shown} shown of ${total}`}>
        {shown}/{total}
      </span>
    ) : (
      <span className="pipeline-count">{total}</span>
    );

  return (
    <div className="page pipeline">
      <PageSlot name="breadcrumbSuffix">
        <span>/{data.shift.venueName}</span>
      </PageSlot>
      <PageSlot
        name="actions"
        fallback={<div className="pipeline-inline-actions">{actions}</div>}
      >
        {actions}
      </PageSlot>
      <header className="pipeline-head">
        <div className="pipeline-title">
          <div className="pipeline-title-row">
            <Link className="pipeline-back" to="/venue-offers" aria-label="Back to Venue Offers" title="Back to Venue Offers">
              <IconArrowLeft size={16} aria-hidden />
            </Link>
            <h1>{data.shift.venueName}</h1>
            <span className="pipeline-status-pill">{data.tableStatus}</span>
          </div>
          <p className="pipeline-when">
            <span>
              <IconCalendar size={14} aria-hidden />
              {new Date(data.shift.startsAt).toLocaleDateString('en-GB', {
                weekday: 'short',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            </span>
            <span aria-hidden>·</span>
            <span>
              <IconClock size={14} aria-hidden />
              {time(data.shift.startsAt)}–{time(data.shift.endsAt)}
            </span>
            <span aria-hidden>·</span>
            <span>{data.shift.roleName}</span>
          </p>
        </div>
        <div className="pipeline-head-tools">
          <div className="pipeline-switch" role="group" aria-label="View">
            <button
              type="button"
              aria-pressed={view === 'pipeline'}
              onClick={() => setParam('view', null)}
            >
              <IconLayoutKanban size={14} aria-hidden /> Pipeline
            </button>
            <button
              type="button"
              aria-pressed={view === 'analytics'}
              onClick={() => setParam('view', 'analytics')}
            >
              <IconChartBar size={14} aria-hidden /> Analytics
            </button>
          </div>
          <button type="button" className="btn btn-outline pipeline-export" onClick={exportCsv}>
            Export
          </button>
        </div>
      </header>
      {attention && (
        <div className={`pipeline-attention tone-${attention.tone}`} role="status">
          <IconAlertCircle size={16} aria-hidden />
          <strong>{attention.title}</strong>
          <span>{attention.detail}</span>
          <button
            type="button"
            className="pipeline-attention-link"
            onClick={() => setParam('view', view === 'analytics' ? null : 'analytics')}
          >
            {view === 'analytics' ? 'Open pipeline' : 'View analytics'} <IconArrowRight size={14} aria-hidden />
          </button>
        </div>
      )}
      {view === 'analytics' ? (
        <VenueOfferPipelineAnalytics
          staff={staff}
          lanes={lanes}
          counts={counts}
          requiredCount={data.shift.requiredCount ?? data.summary?.required ?? 0}
          venueName={data.shift.venueName}
          roleName={data.shift.roleName}
          startsAt={data.shift.startsAt}
          endsAt={data.shift.endsAt}
          onReview={setReview}
          onOpenPipeline={() => setParam('view', null)}
        />
      ) : (
        <section className="pipeline-shell" aria-label="Live staffing board">
          <div className="pipeline-toolbar">
            <div className="pipeline-tabs" role="tablist" aria-label="Pipeline stages">
              {PIPELINE_TABS.map((t, index) => (
                <button
                  key={t.key}
                  ref={(el) => {
                    tabRefs.current[t.key] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`pipeline-tab-${t.key}`}
                  aria-selected={tab === t.key}
                  aria-controls={`pipeline-panel-${t.key}`}
                  tabIndex={tab === t.key ? 0 : -1}
                  onClick={() => setParam('tab', t.key)}
                  onKeyDown={(e) => onTabKey(e, index)}
                >
                  {t.label}
                  {countLabel(visibleInTab(t.key), tabTotals[t.key])}
                </button>
              ))}
            </div>
            <div className="pipeline-tools">
              <label className="pipeline-search">
                <IconSearch size={14} aria-hidden />
                <input
                  type="search"
                  placeholder="Search staff..."
                  aria-label="Search staff"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <select
                className="pipeline-select"
                aria-label="Filter staff"
                value={filter}
                onChange={(e) => setFilter(e.target.value as Filter)}
              >
                {FILTERS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                className="pipeline-select"
                aria-label="Sort staff"
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
              >
                {SORTS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div
            className="pipeline-board"
            role="tabpanel"
            id={`pipeline-panel-${tab}`}
            aria-labelledby={`pipeline-tab-${tab}`}
            tabIndex={0}
          >
            {lanes
              .filter((lane) => lane.tab === tab)
              .map((lane) => {
                const cards = cardsFor(lane);
                const total = counts[lane.key] ?? 0;
                return (
                  <section
                    className={`pipeline-column stage-${lane.key}`}
                    key={lane.key}
                    data-stage={lane.key}
                    aria-label={lane.label}
                  >
                    <h2>
                      <span className={`pipeline-chip tone-${lane.tone}`}>{lane.label}</span>
                      {countLabel(cards.length, total)}
                    </h2>
                    {lane.key === 'offered' && canSendOffer && (
                      <button
                        type="button"
                        className="pipeline-lane-send"
                        onClick={sendOffer}
                        disabled={noPlaces || opening}
                        title={sendTitle}
                      >
                        <IconPlus size={13} aria-hidden /> Send offer
                      </button>
                    )}
                    <div className="pipeline-column-body">
                      {cards.length === 0 && (
                        <p className="pipeline-empty">
                          {filtering && total > 0 ? 'No matching staff' : 'No staff in this stage'}
                        </p>
                      )}
                      <AnimatePresence mode="popLayout">
                        {cards.map((row, cardIndex) => renderCard(row, lane, cardIndex))}
                      </AnimatePresence>
                    </div>
                  </section>
                );
              })}
          </div>
          <div className="pipeline-footer">
            <span>{lanes.length} stages across Staffing, Attendance and Closed</span>
            <span>Current shift · {staff.length} staff</span>
          </div>
        </section>
      )}
      {createPortal(
        <>
          <Drawer
            open={!!review}
            onClose={() => setReview(null)}
            title={review ? `${review.name} · attendance` : 'Attendance'}
            description={`${data.shift.venueName} · ${data.shift.roleName} · ${dateTime(data.shift.startsAt)}–${time(data.shift.endsAt)}`}
            footer={
              review ? (
                <>
                  <button className="btn btn-outline" onClick={() => openStaff(review, true)}>
                    Notes
                  </button>
                  <button className="btn btn-dark" onClick={() => openStaff(review)}>
                    View staff profile
                  </button>
                </>
              ) : undefined
            }
          >
            {review && (
              <>
                <dl className="pipeline-review-list">
                  <div>
                    <dt>Stage</dt>
                    <dd>
                      <span className={`pipeline-chip tone-${rowStatus(review, lanes).tone}`}>
                        {rowStatus(review, lanes).label}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>Offer sent</dt>
                    <dd>{dateTime(review.sentAt)}</dd>
                  </div>
                  <div>
                    <dt>Accepted</dt>
                    <dd>{dateTime(review.acceptedAt)}</dd>
                  </div>
                  {review.checkedInAt !== undefined && (
                    <div>
                      <dt>Checked in (arrival)</dt>
                      <dd>{time(review.checkedInAt)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Clock in</dt>
                    <dd>{time(review.clockInAt)}</dd>
                  </div>
                  <div>
                    <dt>Clock out</dt>
                    <dd>{time(review.clockOutAt)}</dd>
                  </div>
                  <div>
                    <dt>Break</dt>
                    <dd>{review.breakMinutes == null ? '—' : `${review.breakMinutes} min`}</dd>
                  </div>
                  <div>
                    <dt>Worked</dt>
                    <dd>{minutes(review.workedMinutes)}</dd>
                  </div>
                  <div>
                    <dt>Attendance review</dt>
                    <dd>{review.attendanceReviewed ? 'Reviewed' : 'Not reviewed yet'}</dd>
                  </div>
                </dl>
                <p className="pipeline-muted">
                  Attendance is recorded, corrected and reviewed by the Venue Manager in the Crewflow app. Missing
                  attendance is not a no-show until a manager confirms it.
                </p>
              </>
            )}
          </Drawer>
          <Drawer
            open={!!cancel}
            onClose={() => {
              if (!withdrawal.isPending) setCancel(null);
            }}
            title={`Cancel ${cancel?.name ?? 'staff'}'s offer?`}
            footer={
              <>
                <button
                  className="btn btn-outline"
                  disabled={withdrawal.isPending}
                  onClick={() => setCancel(null)}
                >
                  Keep Staff
                </button>
                <button
                  className="btn btn-dark"
                  disabled={withdrawal.isPending}
                  onClick={() => withdrawal.mutate()}
                >
                  {withdrawal.isPending ? 'Cancelling...' : 'Cancel Offer'}
                </button>
              </>
            }
          >
            <p>
              This will remove this shift from the staff member's active
              schedule.
            </p>
            <label htmlFor="cancel-reason">Reason (optional)</label>
            <textarea
              id="cancel-reason"
              className="input pipeline-cancel-reason"
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={withdrawal.isPending}
            />
            {withdrawal.isError && (
              <p role="alert" className="feedback-error">
                Cancellation could not be completed. The cutoff or booking may
                have changed. Close and refresh the board.
              </p>
            )}
          </Drawer>
          <Drawer
            open={reportOpen}
            onClose={() => setReportOpen(false)}
            title="Timesheet Report"
            size="wide"
          >
            {report && (
              <>
                <h2>{data.shift.venueName}</h2>
                <p>
                  {data.shift.roleName} &middot; {dateTime(data.shift.startsAt)}{' '}
                  &ndash;
                  {time(data.shift.endsAt)}
                </p>
                <div className="pipeline-report-files">
                  {[
                    {
                      label: 'Original Timesheet',
                      id: report.originalFileId,
                      note: report.originalFileId
                        ? 'Unsigned'
                        : 'Generating original timesheet...',
                    },
                    {
                      label: 'Venue Signed Timesheet',
                      id: report.signedFileId,
                      note: report.finalisedAt
                        ? `Finalised by ${report.finalisedByName ?? 'recorded reviewer'} - ${dateTime(report.finalisedAt)}${report.signedFileId ? '' : ' - Generating PDF...'}`
                        : 'Waiting for Venue Manager finalisation',
                    },
                  ].map((version) => (
                    <section key={version.label}>
                      <h3>{version.label}</h3>
                      <p>{version.note}</p>
                      {version.id && (
                        <div>
                          <button
                            className="btn btn-outline"
                            onClick={() => file(version.id!, false)}
                          >
                            View
                          </button>
                          <button
                            className="btn btn-outline"
                            onClick={() => file(version.id!, true)}
                          >
                            Download
                          </button>
                        </div>
                      )}
                    </section>
                  ))}
                </div>
                <p className="pipeline-muted">
                  Sign-off uses the existing recorded finalisation. No
                  handwritten signature is captured.
                </p>
                <div className="pipeline-report-table">
                  <table className="table">
                    <thead>
                      <tr>
                        {[
                          'Staff',
                          'Role',
                          'Clock in',
                          'Break',
                          'Clock out',
                          'Worked',
                          'Status',
                        ].map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {report.staff.map((row) => (
                        <tr key={row.staffProfileId}>
                          <td>
                            <span className="pipeline-person">
                              <Avatar
                                previewUrl={
                                  row.avatarFileId
                                    ? avatars.data?.[row.avatarFileId]
                                    : undefined
                                }
                                label={row.staffName}
                                variant="sidebar"
                              />
                              {row.staffName}
                            </span>
                          </td>
                          <td>{row.roleName ?? data.shift.roleName}</td>
                          <td>{time(row.clockInAt)}</td>
                          <td>{row.breakMinutes ?? '—'}</td>
                          <td>{time(row.clockOutAt)}</td>
                          <td>{minutes(row.workedMinutes)}</td>
                          <td>
                            {(
                              row.attendanceStatus || row.assignmentStatus
                            ).replaceAll('_', ' ')}
                            {row.corrected ? ' - Corrected' : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Drawer>
        </>,
        document.querySelector('.app-layout') ?? document.body,
      )}
    </div>
  );
}
