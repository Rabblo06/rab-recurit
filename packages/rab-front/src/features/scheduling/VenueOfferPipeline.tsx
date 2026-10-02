import { createPortal } from 'react-dom';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api';
import Avatar from '../../shared/components/Avatar';
import Drawer from '../../shared/components/Drawer';
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

export default function VenueOfferPipeline() {
  const { shiftId } = useParams();
  const qc = useQueryClient();
  const [cancel, setCancel] = useState<PipelineStaff | null>(null);
  const [reason, setReason] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [fileError, setFileError] = useState('');
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
    setFileError('');
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
      setFileError('Could not open this timesheet. Please retry.');
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
  return (
    <div className="page pipeline">
      <Link className="pipeline-back" to="/venue-offers">
        &larr; Venue Offers
      </Link>
      <header className="pipeline-heading">
        <div>
          <p className="pipeline-eyebrow">LIVE STAFFING</p>
          <h1>{data.shift.venueName}</h1>
          <p className="pipeline-role">{data.shift.roleName}</p>
          <p className="pipeline-muted">
            {new Date(data.shift.startsAt).toLocaleDateString('en-GB', {
              dateStyle: 'long',
            })}{' '}
            &middot; {time(data.shift.startsAt)}&ndash;{time(data.shift.endsAt)}
          </p>
        </div>
        <div className="pipeline-actions">
          <span className="badge">{data.tableStatus}</span>
          {data.replacementPlaces > 0 && (
            <button className="btn btn-dark" onClick={() => setSelecting(true)}>
              + Select replacement staff
            </button>
          )}
          {report && (
            <button
              className="btn btn-outline"
              disabled={!report.ready}
              onClick={() => setReportOpen(true)}
            >
              Timesheet Report
            </button>
          )}
          <small className="pipeline-muted">
            {report
              ? report.ready
                ? 'Attendance completed'
                : 'Waiting for all staff to clock out'
              : 'Report access unavailable'}
          </small>
        </div>
      </header>
      <section className="pipeline-summary" aria-label="Staffing summary">
        {[
          ['required', 'Required'],
          ['confirmed', 'Confirmed'],
          ['offered', 'Offered'],
          ['waiting', 'Waiting'],
          ['accepted', 'Accepted'],
          ['late', 'Late'],
          ['open', 'Open'],
          ['rejected', 'Rejected'],
          ['clockedIn', 'Clocked in'],
          ['clockedOut', 'Clocked out'],
        ].map(([key, label]) => (
          <div key={key}>
            <span>{label}</span>
            <strong>{data.summary[key]}</strong>
          </div>
        ))}
      </section>
      <div className="pipeline-refresh">
        <span className="pipeline-live-dot" /> Updates automatically &middot;
        every 5 seconds
      </div>
      <section
        className="pipeline-board"
        aria-label="Live staffing board"
        style={{ '--stage-count': data.stages.length } as CSSProperties}
      >
        {data.stages.map((stage) => {
          const cards = data.staff.filter((r) => r.stage === stage);
          return (
            <section
              className={`pipeline-column stage-${stage.toLowerCase().replaceAll(' ', '-')}`}
              key={stage}
              aria-label={stage}
            >
              <h2>
                {stage}
                <span>{cards.length}</span>
              </h2>
              {cards.length === 0 && (
                <p className="pipeline-empty">No staff in this stage</p>
              )}
              {cards.map((row) => (
                <article className="pipeline-card" key={row.offerId}>
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
                    {row.terminalSource ||
                      (stage === 'CLOCKED IN'
                        ? `Clocked in - ${time(row.clockInAt)}`
                        : stage === 'CLOCKED OUT'
                          ? `Clocked out - ${time(row.clockOutAt)}`
                          : stage === 'LATE STAFF'
                            ? `Not clocked in - start ${time(data.shift.startsAt)}`
                            : stage === 'WAITING'
                              ? 'Notification read - awaiting response'
                              : stage === 'STAFF ACCEPTED'
                                ? `Accepted - ${time(row.acceptedAt)}`
                                : 'Offer sent')}
                  </p>
                  {stage === 'DELETED OFFER' ? (
                    <>
                      {(row.withdrawnReason ||
                        row.declineReason ||
                        row.rejectionReason) && (
                        <p className="pipeline-reason">
                          {row.withdrawnReason ||
                            row.declineReason ||
                            row.rejectionReason}
                        </p>
                      )}
                      <small>
                        {dateTime(row.cancelledAt || row.respondedAt)}
                      </small>
                    </>
                  ) : stage === 'CLOCKED OUT' ? (
                    <dl>
                      <div>
                        <dt>In / out</dt>
                        <dd>
                          {time(row.clockInAt)} / {time(row.clockOutAt)}
                        </dd>
                      </div>
                      <div>
                        <dt>Break</dt>
                        <dd>{row.breakMinutes ?? '\u2014'} min</dd>
                      </div>
                      <div>
                        <dt>Worked</dt>
                        <dd>{minutes(row.workedMinutes)}</dd>
                      </div>
                    </dl>
                  ) : (
                    <small>
                      {stage === 'OFFERED' || stage === 'WAITING'
                        ? dateTime(row.sentAt)
                        : `${time(data.shift.startsAt)} - ${time(data.shift.endsAt)}`}
                    </small>
                  )}
                </article>
              ))}
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
              <p role="alert">
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
                {fileError && <p role="alert">{fileError}</p>}
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
