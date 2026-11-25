import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api';
import { toast } from '../../shared/lib/toast';
import ModalFrame from '../../shared/components/ModalFrame';
import { jobRolesQuery } from '../../shared/queries/navQueries';
import { venuesWithArchivedQuery } from './schedulingQueries';
import { SKIP_REASON_TEXT, type CopyWeekRow } from './CopyWeekDialog';
import './copy-week.css';

interface Venue { id: string; name: string; archivedAt?: string | null; status?: string }
interface JobRole { id: string; name: string; archivedAt?: string | null }
interface PatternPreview { timezone: string; rows: CopyWeekRow[]; createCount: number; skipCount: number }
interface PatternResult extends PatternPreview { created: { key: string; shiftId: string }[]; recurrenceGroupId: string | null }

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export interface PatternForm {
  venueId: string;
  jobRoleId: string;
  startDate: string;
  endDate: string;
  weekdays: string[];
  startTime: string;
  endTime: string;
  intervalWeeks: number;
  requiredCount: number;
  breakMinutes: number;
  notes: string;
}

/** The request body: exactly the fields the server's ShiftPatternDto declares (empty notes are left out). */
export function patternBody(form: PatternForm) {
  return {
    venueId: form.venueId,
    jobRoleId: form.jobRoleId,
    startDate: form.startDate,
    endDate: form.endDate,
    weekdays: WEEKDAYS.filter((d) => form.weekdays.includes(d)),
    startTime: form.startTime,
    endTime: form.endTime,
    intervalWeeks: form.intervalWeeks,
    requiredCount: form.requiredCount,
    breakMinutes: form.breakMinutes,
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
  };
}

const when = (row: CopyWeekRow) => {
  const day = new Date(row.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time(row.startsAt)}–${time(row.endsAt)}`;
};

function errorText(error: unknown): string {
  const response = (error as { response?: { status?: number; data?: { message?: string | string[] } } } | null)?.response;
  if (response?.status === 403) return 'You don’t have permission to create shifts.';
  if (response?.status === 404) return 'That venue or job role isn’t available to you.';
  const message = response?.data?.message;
  return (Array.isArray(message) ? message[0] : message) || 'Something went wrong. Try again.';
}

/**
 * Recurring shifts: describe the pattern, preview every occurrence (with the reason any would be skipped), untick the
 * ones you don't want, then create them all as DRAFT shifts in one go. The server generates and checks everything.
 */
export default function ShiftPatternDialog({ open, defaultStartDate, onClose }: { open: boolean; defaultStartDate: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const blank = (): PatternForm => ({ venueId: '', jobRoleId: '', startDate: defaultStartDate, endDate: defaultStartDate, weekdays: [], startTime: '09:00', endTime: '17:00', intervalWeeks: 1, requiredCount: 1, breakMinutes: 0, notes: '' });
  const [form, setForm] = useState<PatternForm>(blank);
  const [preview, setPreview] = useState<PatternPreview | null>(null);
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<PatternResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(blank());
    setPreview(null);
    setResult(null);
    setDeselected(new Set());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const { data: venues = [] } = useQuery({ ...venuesWithArchivedQuery<Venue>(), enabled: open });
  const { data: jobRoles = [] } = useQuery({ ...jobRolesQuery<JobRole>(), enabled: open });
  const venueName = (id: string) => venues.find((v) => v.id === id)?.name ?? 'Unknown venue';

  const update = (patch: Partial<PatternForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setPreview(null); // a changed pattern needs a fresh preview
    setDeselected(new Set());
  };
  const toggleDay = (day: string) => update({ weekdays: form.weekdays.includes(day) ? form.weekdays.filter((d) => d !== day) : [...form.weekdays, day] });

  const runPreview = useMutation({
    mutationFn: async () => (await api.post<PatternPreview>('/shifts/pattern/preview', patternBody(form))).data,
    onSuccess: (data) => { setPreview(data); setDeselected(new Set()); },
  });
  const selected = (preview?.rows ?? []).filter((r) => r.outcome === 'create' && !deselected.has(r.key));
  const create = useMutation({
    mutationFn: async () => (await api.post<PatternResult>('/shifts/pattern', { ...patternBody(form), dates: selected.map((r) => r.key) })).data,
    onSuccess: async (data) => {
      setResult(data);
      await queryClient.invalidateQueries({ queryKey: ['shifts'] });
      toast.success(`${data.created.length} draft shift${data.created.length === 1 ? '' : 's'} created.`);
    },
  });

  const ready = form.venueId && form.jobRoleId && form.weekdays.length > 0 && form.startDate && form.endDate;
  const shown = result?.rows ?? preview?.rows ?? [];
  const toggleRow = (key: string) => setDeselected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return createPortal(
    <ModalFrame
      open={open}
      overlayProps={{ 'data-rab-portal': '' }}
      dialogClassName="copy-week"
      onBackdropMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'shift-pattern-title' }}
    >
      <h3 id="shift-pattern-title">Repeating shifts</h3>
      <p className="copy-week__intro">Creates a <strong>draft</strong> shift on each chosen day. Times are your organisation’s local time; an end time before the start time finishes the next day. Pay is set from the current rates.</p>
      {!result && (
        <fieldset className="shift-pattern__form" disabled={create.isPending}>
          <label>Venue
            <select value={form.venueId} onChange={(e) => update({ venueId: e.target.value })}>
              <option value="">Choose a venue</option>
              {venues.filter((v) => !v.archivedAt && v.status !== 'archived').map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <label>Job role
            <select value={form.jobRoleId} onChange={(e) => update({ jobRoleId: e.target.value })}>
              <option value="">Choose a job role</option>
              {jobRoles.filter((r) => !r.archivedAt).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label>From<input type="date" value={form.startDate} onChange={(e) => update({ startDate: e.target.value })} /></label>
          <label>Until<input type="date" value={form.endDate} onChange={(e) => update({ endDate: e.target.value })} /></label>
          <div className="shift-pattern__days" role="group" aria-label="Days">
            {WEEKDAYS.map((day) => (
              <label key={day}><input type="checkbox" checked={form.weekdays.includes(day)} onChange={() => toggleDay(day)} />{day.slice(0, 3)}</label>
            ))}
          </div>
          <label>Start time<input type="time" value={form.startTime} onChange={(e) => update({ startTime: e.target.value })} /></label>
          <label>End time<input type="time" value={form.endTime} onChange={(e) => update({ endTime: e.target.value })} /></label>
          <label>Repeat
            <select value={form.intervalWeeks} onChange={(e) => update({ intervalWeeks: Number(e.target.value) })}>
              <option value={1}>Every week</option>
              <option value={2}>Every 2 weeks</option>
              <option value={3}>Every 3 weeks</option>
              <option value={4}>Every 4 weeks</option>
            </select>
          </label>
          <label>People needed<input type="number" min={1} value={form.requiredCount} onChange={(e) => update({ requiredCount: Number(e.target.value) })} /></label>
          <label>Break (minutes)<input type="number" min={0} value={form.breakMinutes} onChange={(e) => update({ breakMinutes: Number(e.target.value) })} /></label>
          <label className="shift-pattern__notes">Notes<input type="text" value={form.notes} onChange={(e) => update({ notes: e.target.value })} /></label>
        </fieldset>
      )}
      {runPreview.isError && !preview && <p className="feedback-error copy-week__status" role="alert">{errorText(runPreview.error)}</p>}
      {preview && !result && shown.length === 0 && <p className="copy-week__status">No days in that range match the pattern.</p>}
      {shown.length > 0 && (
        <div className="copy-week__table-wrap">
          <table className="copy-week__table" aria-label={result ? 'Pattern result' : 'Shifts to create'}>
            <thead><tr><th scope="col"><span className="visually-hidden">Create</span></th><th scope="col">Shift</th><th scope="col">Venue</th><th scope="col">Staff</th><th scope="col">Result</th></tr></thead>
            <tbody>
              {shown.map((row) => {
                const created = result?.created.some((c) => c.key === row.key);
                const status = result
                  ? (created ? 'Created as draft' : SKIP_REASON_TEXT[row.reason ?? ''] ?? 'Skipped')
                  : row.outcome === 'create' ? (deselected.has(row.key) ? 'Not selected' : 'Will be created') : SKIP_REASON_TEXT[row.reason ?? ''] ?? 'Skipped';
                return (
                  <tr key={row.key} className={row.outcome === 'skip' ? 'copy-week__skip' : undefined}>
                    <td>{!result && row.outcome === 'create' && <input type="checkbox" aria-label={`Create ${when(row)}`} checked={!deselected.has(row.key)} onChange={() => toggleRow(row.key)} />}</td>
                    <td>{when(row)}</td>
                    <td>{venueName(row.venueId)}</td>
                    <td>{row.requiredCount}</td>
                    <td>{status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {create.isError && <p className="feedback-error copy-week__status" role="alert">{errorText(create.error)}</p>}
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
        {!result && !preview && (
          <button type="button" className="btn btn-dark" disabled={!ready || runPreview.isPending} onClick={() => runPreview.mutate()}>
            {runPreview.isPending ? 'Checking…' : 'Preview'}
          </button>
        )}
        {!result && preview && (
          <button type="button" className="btn btn-dark" disabled={selected.length === 0 || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : `Create ${selected.length} draft shift${selected.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
    </ModalFrame>,
    document.body,
  );
}
