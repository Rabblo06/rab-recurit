import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api';
import { toast } from '../../shared/lib/toast';
import ModalFrame from '../../shared/components/ModalFrame';
import { jobRolesQuery } from '../../shared/queries/navQueries';
import { venuesWithArchivedQuery } from './schedulingQueries';
import './copy-week.css';

/** One row of `POST /shifts/copy-previous-week[/preview]` (the server's DraftBatchRow). Never a pay amount. */
export interface CopyWeekRow {
  key: string;
  venueId: string;
  jobRoleId: string;
  startsAt: string;
  endsAt: string;
  requiredCount: number;
  outcome: 'create' | 'skip';
  reason?: string;
}
interface CopyWeekPreview { timezone: string; rows: CopyWeekRow[]; createCount: number; skipCount: number }
interface CopyWeekResult extends CopyWeekPreview { created: { key: string; shiftId: string }[] }
interface Venue { id: string; name: string; archivedAt?: string | null; status?: string }
interface JobRole { id: string; name: string }

/** Plain-English text for every skip reason the server can return. */
export const SKIP_REASON_TEXT: Record<string, string> = {
  already_exists: 'Already scheduled',
  duplicate_in_batch: 'Duplicate of another row',
  starts_in_past: 'Would start in the past',
  invalid_local_time: 'That time doesn’t exist on this day (clock change)',
  break_too_long: 'Break is not shorter than the shift that day',
  venue_unavailable: 'Venue not available',
  venue_archived: 'Venue archived',
  job_role_unavailable: 'Job role not available',
  job_role_archived: 'Job role archived',
  not_selected: 'Not selected',
};

const when = (row: CopyWeekRow) => {
  const start = new Date(row.startsAt);
  const day = start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time(row.startsAt)}–${time(row.endsAt)}`;
};

function errorText(error: unknown): string {
  const response = (error as { response?: { status?: number; data?: { message?: string | string[] } } } | null)?.response;
  if (response?.status === 403) return 'You don’t have permission to create shifts.';
  if (response?.status === 404) return 'That venue isn’t available to you.';
  const message = response?.data?.message;
  return (Array.isArray(message) ? message[0] : message) || 'Something went wrong. Try again.';
}

/**
 * Copy previous week: preview every shift of the 7 days before `weekStart` moved one week on, untick any you don't
 * want, then create them as new DRAFT shifts. Staff, offers and publication are never copied; the server re-plans on
 * confirm and reports each skipped row with its reason.
 */
export default function CopyWeekDialog({ open, weekStart, onClose }: { open: boolean; weekStart: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [venueId, setVenueId] = useState('');
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CopyWeekResult | null>(null);

  // Each opening starts fresh (no stale selection or result from the last time).
  useEffect(() => {
    if (!open) return;
    setDeselected(new Set());
    setResult(null);
  }, [open, weekStart]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const { data: venues = [] } = useQuery({ ...venuesWithArchivedQuery<Venue>(), enabled: open });
  const { data: jobRoles = [] } = useQuery({ ...jobRolesQuery<JobRole>(), enabled: open });
  const activeVenues = venues.filter((v) => !v.archivedAt && v.status !== 'archived');
  const venueName = (id: string) => venues.find((v) => v.id === id)?.name ?? 'Unknown venue';
  const roleName = (id: string) => jobRoles.find((r) => r.id === id)?.name ?? 'Unknown role';

  const body = useMemo(() => ({ weekStart, ...(venueId ? { venueId } : {}) }), [weekStart, venueId]);
  const preview = useQuery({
    queryKey: ['shifts', 'copy-previous-week', body],
    queryFn: async () => (await api.post<CopyWeekPreview>('/shifts/copy-previous-week/preview', body)).data,
    enabled: open && !result,
    staleTime: 0,
    gcTime: 0,
  });
  const rows = preview.data?.rows ?? [];
  const selected = rows.filter((r) => r.outcome === 'create' && !deselected.has(r.key));

  const confirm = useMutation({
    mutationFn: async () => (await api.post<CopyWeekResult>('/shifts/copy-previous-week', { ...body, sourceShiftIds: selected.map((r) => r.key) })).data,
    onSuccess: async (data) => {
      setResult(data);
      await queryClient.invalidateQueries({ queryKey: ['shifts'] });
      toast.success(`${data.created.length} draft shift${data.created.length === 1 ? '' : 's'} created.`);
    },
  });

  const toggle = (key: string) => setDeselected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const weekLabel = new Date(`${weekStart}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const shown = result?.rows ?? rows;

  return createPortal(
    <ModalFrame
      open={open}
      overlayProps={{ 'data-rab-portal': '' }}
      dialogClassName="copy-week"
      onBackdropMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'copy-week-title' }}
    >
      <h3 id="copy-week-title">Copy previous week</h3>
      <p className="copy-week__intro">
        Copies last week’s shifts into the week of {weekLabel} as new <strong>draft</strong> shifts. Staff, offers and publishing are not copied, and pay is set from the current rates.
      </p>
      {!result && (
        <label className="copy-week__venue">
          Venue
          <select value={venueId} onChange={(e) => { setVenueId(e.target.value); setDeselected(new Set()); }}>
            <option value="">All my venues</option>
            {activeVenues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
      )}
      {preview.isLoading && !result && <p className="copy-week__status">Checking last week…</p>}
      {preview.isError && !result && <p className="feedback-error copy-week__status" role="alert">{errorText(preview.error)}</p>}
      {(preview.data || result) && shown.length === 0 && <p className="copy-week__status">There are no shifts to copy from last week.</p>}
      {shown.length > 0 && (
        <div className="copy-week__table-wrap">
          <table className="copy-week__table" aria-label={result ? 'Copy result' : 'Shifts to copy'}>
            <thead><tr><th scope="col"><span className="visually-hidden">Copy</span></th><th scope="col">New shift</th><th scope="col">Venue</th><th scope="col">Role</th><th scope="col">Staff</th><th scope="col">Result</th></tr></thead>
            <tbody>
              {shown.map((row) => {
                const created = result?.created.some((c) => c.key === row.key);
                return (
                  <tr key={row.key} className={row.outcome === 'skip' ? 'copy-week__skip' : undefined}>
                    <td>
                      {!result && row.outcome === 'create' && <input type="checkbox" aria-label={`Copy ${when(row)} at ${venueName(row.venueId)}`} checked={!deselected.has(row.key)} onChange={() => toggle(row.key)} />}
                    </td>
                    <td>{when(row)}</td>
                    <td>{venueName(row.venueId)}</td>
                    <td>{roleName(row.jobRoleId)}</td>
                    <td>{row.requiredCount}</td>
                    <td>{result ? (created ? 'Created as draft' : SKIP_REASON_TEXT[row.reason ?? ''] ?? 'Skipped') : row.outcome === 'create' ? (deselected.has(row.key) ? 'Not selected' : 'Will be created') : SKIP_REASON_TEXT[row.reason ?? ''] ?? 'Skipped'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {confirm.isError && <p className="feedback-error copy-week__status" role="alert">{errorText(confirm.error)}</p>}
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
        {!result && (
          <button type="button" className="btn btn-dark" disabled={selected.length === 0 || confirm.isPending || !preview.data} onClick={() => confirm.mutate()}>
            {confirm.isPending ? 'Copying…' : `Create ${selected.length} draft shift${selected.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
    </ModalFrame>,
    document.body,
  );
}
