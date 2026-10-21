import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api';
import Avatar from '../../shared/components/Avatar';
import Drawer from '../../shared/components/Drawer';
import { toast } from '../../shared/lib/toast';
import { PageSlot } from '../../shared/page-slots';
import { AnimatePresence, motion } from 'framer-motion';
import AnimatedNumber from '../../shared/components/AnimatedNumber';
import { layoutSpring, listItem } from '../../shared/motion';
import StaffSelectionPage from './StaffSelectionPage';
import './venue-offer-pipeline.css';

export interface PipelineStaff {
  staffProfileId: string;
  name: string;
  avatarFileId: string | null;
  offerId: string;
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
  stages: string[];
  summary: Record<string, number>;
  stageCounts?: Record<string, number>;
  tableStatus: string;
  staff: PipelineStaff[];
  report: Report | null;
  replacementPlaces: number;
}
const time = (value: string | null) =>
  value
    ? new Date(value).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '\u2014';
const dateTime = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '\u2014';
const minutes = (value: number | null) =>
  value == null ? '\u2014' : `${Math.floor(value / 60)}h ${value % 60}m`;
/** Seat metrics: summary-only, never lanes. */
const SEATS: Array<[string, string]> = [
  ['required', 'Required'],
  ['filled', 'Filled'],
  ['open', 'Open'],
];

/** Lane → summary key and label. Each lane counter IS that lane's card count (server reconciles them). */
const LANES: Record<string, [string, string]> = {
  OFFERED: ['offered', 'Offered'],
  WAITING: ['waiting', 'Waiting'],
  'STAFF ACCEPTED': ['accepted', 'Accepted'],
  CONFIRMED: ['confirmed', 'Confirmed'],
  'LATE STAFF': ['late', 'Late'],
  'CLOCKED IN': ['clockedIn', 'Clocked in'],
  'PENDING REVIEW': ['pendingReview', 'Pending Review'],
  'CLOCKED OUT': ['clockedOut', 'Clocked out'],
  'NO SHOW': ['noShow', 'No Show'],
  REJECTED: ['rejected', 'Rejected'],
  CANCELLED: ['cancelled', 'Cancelled'],
  'DELETED OFFER': ['deleted', 'Deleted'],
};

const TERMINAL = new Set(['REJECTED', 'CANCELLED', 'DELETED OFFER']);

const laneClass = (stage: string) =>
  `stage-${stage.toLowerCase().replaceAll(' ', '-')}`;

/** One status line per card, from the persisted facts behind its lane. */
function cardState(row: PipelineStaff, stage: string, startsAt: string): string {
  if (TERMINAL.has(stage) && row.terminalSource) return row.terminalSource;
  switch (stage) {
    case 'WAITING':
      return 'Notification read - awaiting response';
    case 'STAFF ACCEPTED':
      return `Accepted - ${time(row.acceptedAt)} - awaiting confirmation`;
    case 'CONFIRMED':
      return `Confirmed - starts ${time(startsAt)}`;
    case 'LATE STAFF':
      return `Not clocked in - start ${time(startsAt)}`;
    case 'CLOCKED IN':
      return `Clocked in - ${time(row.clockInAt)}`;
    case 'PENDING REVIEW':
      return row.attendanceStatus === 'missing_clock_out'
        ? `Clock-out missing - in ${time(row.clockInAt)}`
        : row.attendanceStatus === 'disputed'
          ? 'Attendance disputed - awaiting review'
          : `Corrected - out ${time(row.clockOutAt)} - awaiting review`;
    case 'CLOCKED OUT':
      return `Clocked out - ${time(row.clockOutAt)}`;
    case 'NO SHOW':
      return 'No clock-in recorded - no-show';
    case 'REJECTED':
      return 'Rejected';
    case 'CANCELLED':
      return 'Booking cancelled';
    case 'DELETED OFFER':
      return 'Offer removed';
    default:
      return 'Offer sent';
  }
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

/** Owner-approved readiness copy for the Timesheet report action (shown only in response to that action). */
export const TIMESHEET_NOT_READY = "Timesheet isn't ready yet. Wait until all required staff have clocked out.";
export const TIMESHEET_READY = 'Timesheet is ready. All required staff have clocked out.';

export default function VenueOfferPipeline() {
  const { shiftId } = useParams();
  const qc = useQueryClient();
  const [cancel, setCancel] = useState<PipelineStaff | null>(null);
  const [reason, setReason] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const board = useRef<HTMLElement>(null);
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
  if (query.isError || !query.data)
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
  const data = query.data,
    report = data.report;
  if (selecting)
    return (
      <StaffSelectionPage
        shiftId={shiftId!}
        requiredCount={data.replacementPlaces}
        initialStaff={[]}
        mode="replacement"
        onCancel={() => setSelecting(false)}
        onConfirmed={async () => {
          setSelecting(false);
          await refresh();
        }}
      />
    );
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
  const title = (
    <div className="pipeline-title">
      <div className="pipeline-title-row">
        <h1>{data.shift.venueName}</h1>
        <span className="pipeline-status-pill">{data.tableStatus}</span>
      </div>
      <p>
        {new Date(data.shift.startsAt).toLocaleDateString('en-GB', { dateStyle: 'long' })} &middot;{' '}
        {time(data.shift.startsAt)}&ndash;{time(data.shift.endsAt)}
      </p>
    </div>
  );
  const actions = (
    <>
      {data.replacementPlaces > 0 && (
        <button className="btn btn-outline" onClick={() => setSelecting(true)}>
          + Select replacement staff
        </button>
      )}
      {report && (
        <button
          className="btn btn-dark pipeline-timesheet-btn"
          onClick={openTimesheet}
          aria-describedby="pipeline-report-state"
        >
          Timesheet report
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
  const jumpTo = (stage: string) =>
    board.current
      ?.querySelector<HTMLElement>(`[data-stage="${stage}"]`)
      ?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  return (
    <div className="page pipeline">
      <PageSlot name="breadcrumbSuffix">
        <span>/{data.shift.venueName}</span>
      </PageSlot>
      <PageSlot name="title" fallback={title}>
        {title}
      </PageSlot>
      <PageSlot
        name="actions"
        fallback={<div className="pipeline-inline-actions">{actions}</div>}
      >
        {actions}
      </PageSlot>
      <div className="pipeline-top">
        <Link className="pipeline-back" to="/venue-offers">
          &larr; Venue Offers
        </Link>
        <section className="pipeline-summary" aria-label="Staffing summary">
          <div className="pipeline-summary-group" aria-label="Seats">
            {SEATS.map(([key, label]) => (
              <div key={key} className={`pipeline-metric metric-${key}`}>
                <span>{label}</span>
                <strong><AnimatedNumber value={data.summary[key] ?? 0} /></strong>
              </div>
            ))}
          </div>
          <div className="pipeline-summary-group" aria-label="Staff by stage">
            {data.stages.map((stage) => {
              const [key, label] = LANES[stage] ?? [stage, stage];
              return (
                <button
                  type="button"
                  key={stage}
                  className={`pipeline-metric metric-${key}`}
                  onClick={() => jumpTo(stage)}
                  title={`Show ${label}`}
                >
                  <span>{label}</span>
                  <strong><AnimatedNumber value={data.summary[key] ?? 0} /></strong>
                </button>
              );
            })}
          </div>
        </section>
      </div>
      <section
        ref={board}
        className="pipeline-board"
        aria-label="Live staffing board"
        style={{ '--stage-count': data.stages.length } as CSSProperties}
      >
        {data.stages.map((stage) => {
          const cards = data.staff.filter((r) => r.stage === stage);
          return (
            <section
              className={`pipeline-column ${laneClass(stage)}`}
              key={stage}
              data-stage={stage}
              aria-label={stage}
            >
              <h2>
                {stage}
                <span className="pipeline-count">{cards.length}</span>
              </h2>
              <div className="pipeline-column-body">
                {cards.length === 0 && (
                  <p className="pipeline-empty">No staff in this stage</p>
                )}
                <AnimatePresence mode="popLayout">
                {cards.map((row, cardIndex) => (
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
                      <button
                        className="pipeline-person"
                        onClick={() => openStaff(row)}
                      >
                        <Avatar
                          previewUrl={
                            row.avatarFileId
                              ? avatars.data?.[row.avatarFileId]
                              : undefined
                          }
                          label={row.name}
                          variant="sidebar"
                        />
                        <span>
                          <strong title={row.name}>{row.name}</strong>
                          <small>{data.shift.roleName}</small>
                        </span>
                      </button>
                      <details className="pipeline-menu">
                        <summary aria-label={`Actions for ${row.name}`}>
                          &hellip;
                        </summary>
                        <div>
                          <button onClick={() => openStaff(row)}>
                            View staff
                          </button>
                          <button onClick={() => openStaff(row, true)}>
                            Notes
                          </button>
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
                    <p className="pipeline-card-state">
                      {cardState(row, stage, data.shift.startsAt)}
                      {stage === 'CLOCKED OUT' && (
                        <span
                          className={`pipeline-tag ${row.attendanceReviewed ? 'is-reviewed' : 'is-awaiting'}`}
                        >
                          {row.attendanceReviewed ? 'Reviewed' : 'Awaiting review'}
                        </span>
                      )}
                    </p>
                    {TERMINAL.has(stage) &&
                      (row.withdrawnReason || row.declineReason || row.rejectionReason) && (
                        <p className="pipeline-reason">
                          {row.withdrawnReason || row.declineReason || row.rejectionReason}
                        </p>
                      )}
                    <div className="pipeline-card-foot">
                      {TERMINAL.has(stage)
                        ? dateTime(row.cancelledAt || row.respondedAt)
                        : row.clockOutAt
                          ? `In ${time(row.clockInAt)} · Out ${time(row.clockOutAt)} · Break ${row.breakMinutes ?? '—'} min · ${minutes(row.workedMinutes)}`
                          : stage === 'OFFERED' || stage === 'WAITING'
                            ? dateTime(row.sentAt)
                            : `${time(data.shift.startsAt)} - ${time(data.shift.endsAt)}`}
                      {(row.earlierOffers ?? 0) > 0 && (
                        <small className="pipeline-earlier">
                          {row.earlierOffers} earlier{' '}
                          {row.earlierOffers === 1 ? 'offer' : 'offers'}
                        </small>
                      )}
                    </div>
                  </motion.article>
                ))}
                </AnimatePresence>
              </div>
            </section>
          );
        })}
      </section>
      {createPortal(
        <>
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
                          <td>{row.breakMinutes ?? '\u2014'}</td>
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
