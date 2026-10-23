import { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconUserOff, IconUserCheck, IconKey, IconSend, IconMail, IconBan, IconTrash, IconDotsVertical,
  IconPencil, IconHome2, IconHistory, IconNotes, IconPhone, IconChevronDown, IconPlus,
  IconUsersGroup, IconStar,
} from '@tabler/icons-react';
import DetailTabs from './DetailTabs';
import { AnimatePresence, motion } from 'framer-motion';
import { contentSwap } from '../../shared/motion';
import StaffReviewsTab from './StaffReviewsTab';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';
import Avatar from '../../shared/components/Avatar';
import DateInput, { isoToDisplay, todayIso } from '../../shared/components/DateInput';
import { DetailSkeleton } from '../../shared/components/LoadingState';
import { timeAgo } from '../../shared/lib/timeAgo';
import { toast } from '../../shared/lib/toast';
import { getStaffDisplayStatus, type InvitationStatus } from './staffStatus';
import PhoneInput from './PhoneInput';
import AvatarUploadButton from './AvatarUploadButton';
import EmailChangeStepUpDialog from './EmailChangeStepUpDialog';
import VenueManagerTeamSection from './VenueManagerTeamSection';
import { getApiErrorCode, getApiErrorMessage } from '../../shared/lib/apiError';

type UserType = 'staff' | 'manager';
type DetailTab = 'home' | 'timeline' | 'email' | 'note' | 'staff' | 'reviews';

/** Same suggestion lists as CreateUserModal's own — kept in sync, not re-derived from a shared module (three short arrays, not worth a new shared file for). */
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Temporary', 'Casual', 'Contract'];
const SHIFT_TIMES = ['Morning', 'Afternoon', 'Evening', 'Night', 'Flexible'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

type FieldControlType = 'text' | 'date' | 'tel' | 'email' | 'phone' | 'number' | 'select' | 'multiselect' | 'tags' | 'textarea';
type SelectOption = string | { value: string; label: string };

/**
 * A single label/value row, CRM-style: read-only by default, a pencil
 * appears only on hover/focus (reserved space, no layout shift), clicking
 * the value or the pencil opens exactly one inline editor — never a
 * permanent form, never permanent save/cancel icons. Only one field across
 * the whole panel is ever in edit mode at a time, driven by the parent's
 * single `editingField` state (`editing`/`onEditStart`/`onEditEnd` here are
 * that state, lifted — this component holds no edit-mode state of its own).
 *
 * Commit model, per control type (no permanent tick/✗ anywhere):
 *  - text/tel/email/number/tags/textarea: Enter blurs (tags/text only —
 *    textarea needs real newlines so Enter is left alone there), and the
 *    single onBlur handler is what actually saves — clicking away commits,
 *    exactly like Notion/Airtable/HubSpot's inline cells. Escape reverts the
 *    draft and closes without saving.
 *  - select/date: choosing a value *is* the commit (`onChange`/pick fires
 *    the save immediately) — there is no separate draft to lose, so a click
 *    outside the row or Escape just closes the (already-consistent) row.
 *  - multiselect: each checkbox toggle persists immediately for the same
 *    reason — outside-click/Escape just close the editor.
 */
function EditableField({
  label, value, required, editable, type = 'text', options, onSave, format, wrap,
  editing, onEditStart, onEditEnd,
}: {
  label: string;
  value: string | string[] | null;
  required?: boolean;
  editable: boolean;
  type?: FieldControlType;
  options?: SelectOption[];
  onSave?: (next: string | string[]) => Promise<void>;
  format?: (v: string | string[]) => React.ReactNode;
  /** Long free text (Notes) wraps instead of truncating with an ellipsis. */
  wrap?: boolean;
  editing: boolean;
  onEditStart: () => void;
  onEditEnd: () => void;
}) {
  const toDraft = (v: string | string[] | null): string | string[] =>
    type === 'multiselect' ? (Array.isArray(v) ? v : []) : (Array.isArray(v) ? v.join(', ') : (v ?? ''));

  const [draft, setDraft] = useState<string | string[]>(() => toDraft(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!editing) { setDraft(toDraft(value)); setError(''); } }, [value, editing]);

  // Outside-click closes select/multiselect/date editors without trying to
  // commit a draft — none of them have one (see the commit-model note
  // above). Text-like controls rely on their own native onBlur instead.
  //
  // `phone` is the odd one out: it looks like a plain text-like control but
  // isn't one — `PhoneInput` wraps `react-phone-number-input`, a compound
  // country-select + number-input component, and its `onBlur` passthrough
  // (via `numberInputProps`) turned out not to fire reliably here (confirmed
  // in production: editing reverted to the original value with no error,
  // the exact symptom of `commitValue` being called with a STALE `draft`
  // captured once rather than the current one — consistent with the
  // underlying library not re-reading that prop on every render). Outside
  // click now commits the CURRENT `draft` directly from this closure,
  // sidestepping the library's prop-forwarding entirely, the same way
  // `select`/`date` already avoid relying on it.
  useEffect(() => {
    if (!editing || !(type === 'select' || type === 'multiselect' || type === 'date' || type === 'phone')) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!rowRef.current || rowRef.current.contains(e.target as Node)) return;
      if (type === 'phone') commitValue(draft);
      else onEditEnd();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `draft` intentionally included so the phone branch always commits the latest typed value, not a stale one.
  }, [editing, type, draft]);

  // `keepOpen` is for multiselect only: every checkbox toggle is its own
  // immediate commit (there's no separate "done" step), but the row itself
  // must stay open across several toggles in one sitting — closing after the
  // very first checkbox would make it impossible to select more than one day.
  const commitValue = async (next: string | string[], keepOpen = false) => {
    const isEmpty = Array.isArray(next) ? next.length === 0 : !next.trim();
    if (required && isEmpty) { setError('Required.'); return; }
    if (typeof next === 'string' && next === toDraft(value)) { onEditEnd(); return; }
    setSaving(true);
    setError('');
    try {
      await onSave?.(typeof next === 'string' ? next.trim() : next);
      if (!keepOpen) onEditEnd();
    } catch (e: unknown) {
      setError(getApiErrorMessage(e, 'Failed to save.'));
      // Revert — never leave a value on screen that the server rejected.
      setDraft(toDraft(value));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => { setDraft(toDraft(value)); setError(''); onEditEnd(); };

  if (editing) {
    let control: React.ReactNode;
    if (type === 'select') {
      const opts = (options ?? []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
      control = (
        <select
          autoFocus
          value={draft as string}
          disabled={saving}
          onChange={(e) => { if (e.target.value) commitValue(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onEditEnd(); } }}
        >
          <option value="">— Select —</option>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    } else if (type === 'multiselect') {
      const selected = Array.isArray(draft) ? draft : [];
      const opts = (options ?? []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
      control = (
        <div className="weekday-picker" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onEditEnd(); } }}>
          {opts.map((o) => (
            <label key={o.value} className="weekday-picker-option">
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                disabled={saving}
                onChange={() => {
                  const next = selected.includes(o.value) ? selected.filter((d) => d !== o.value) : [...selected, o.value];
                  setDraft(next);
                  commitValue(next, true);
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    } else if (type === 'date') {
      // DateInput's own Escape only closes its calendar popover (and only
      // swallows the keypress while that popover is open) — this wrapper
      // catches the bubbled second Escape (popover already closed) and
      // cancels the row itself, giving DOB/date fields the same two-stage
      // Escape behavior as everything else here.
      control = (
        <div onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onEditEnd(); } }}>
          <DateInput
            value={typeof draft === 'string' ? draft : ''}
            max={label === 'Date of birth' ? todayIso() : undefined}
            onChange={(v) => { setDraft(v); commitValue(v); }}
          />
        </div>
      );
    } else if (type === 'textarea') {
      control = (
        <textarea
          autoFocus
          rows={3}
          value={draft as string}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}
          onBlur={() => commitValue(draft)}
        />
      );
    } else if (type === 'phone') {
      // Matches Create Staff's own flag/dial-code UI (`PhoneInput`) rather
      // than a plain `<input type="tel">`. Commits on outside-click/Enter
      // (handled by the shared effect above + onKeyDown below), not blur —
      // `PhoneInput`'s blur passthrough was confirmed unreliable here (see
      // that effect's own comment).
      control = (
        <div
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
            if (e.key === 'Enter') { e.stopPropagation(); commitValue(draft); }
          }}
        >
          <PhoneInput
            autoFocus
            value={draft as string}
            onChange={(v) => setDraft(v)}
          />
        </div>
      );
    } else {
      control = (
        <input
          autoFocus
          type={type === 'tags' ? 'text' : type}
          value={draft as string}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Escape must cancel only this field's edit, never bubble to
            // RightSidePanel's document-level Escape-closes-the-whole-panel
            // listener (a field-edit escape hatch that used to close the
            // entire drawer out from under the user was a real bug caught
            // by Playwright verification, not a hypothetical).
            if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
            // Enter blurs; onBlur below is the single commit path for every
            // text-like control, so Enter and click-away behave identically.
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          onBlur={() => commitValue(type === 'tags' ? (draft as string).split(',').map((s) => s.trim()).filter(Boolean) : draft)}
        />
      );
    }
    return (
      <div className="detail-info-row detail-info-row-editing" ref={rowRef}>
        <span className="detail-info-label">{label}</span>
        <div className="detail-info-edit">{control}</div>
        {error && <span className="detail-info-error">{error}</span>}
      </div>
    );
  }

  const isEmpty = Array.isArray(value) ? value.length === 0 : !value;
  const display = isEmpty ? null : (format ? format(value!) : (Array.isArray(value) ? value.join(', ') : value));
  return (
    <div className={`detail-info-row${editable ? ' detail-info-row-hover' : ''}`}>
      <span className="detail-info-label">{label}{required && editable ? ' *' : ''}</span>
      <span className="detail-info-value-group">
        <span
          className={`detail-info-value-box${editable ? ' detail-info-value-box-hover' : ''}`}
          onClick={() => editable && onEditStart()}
        >
          <span className={`detail-info-value${isEmpty ? ' detail-info-value-empty' : ''}${wrap ? ' detail-info-value-wrap' : ''}`}>
            {display ?? '—'}
          </span>
        </span>
        {editable && (
          <button type="button" className="detail-info-edit-btn" aria-label={`Edit ${label}`} onClick={onEditStart}>
            <IconPencil size={12} />
          </button>
        )}
      </span>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="detail-info-row">
      <span className="detail-info-label">{label}</span>
      <span className="detail-info-value">{value ?? '—'}</span>
    </div>
  );
}

/** One titled group of rows in the Overview layout — a plain container, not an accordion: the "database form" the redesign is replacing was one chevron per group, this is one visual grouping with no toggle of its own. */
function DetailGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="detail-group">
      <div className="detail-group-title">{title}</div>
      {children}
    </div>
  );
}

/** Small, neutral, hand-drawn-in-code illustrations for the Email/Notes empty states — not copied from any reference system's artwork. */
function MailboxIllustration() {
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden="true">
      <rect x="10" y="24" width="52" height="34" rx="8" fill="var(--bg-secondary)" />
      <path d="M14 30 L36 46 L58 30" stroke="var(--font-tertiary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <rect x="10" y="24" width="52" height="34" rx="8" stroke="var(--border-medium)" strokeWidth="1.5" fill="none" />
      <circle cx="52" cy="20" r="8" fill="var(--color-accent, var(--font-primary))" opacity="0.15" />
      <circle cx="52" cy="20" r="4" fill="var(--color-accent, var(--font-primary))" opacity="0.5" />
    </svg>
  );
}
function NotebookIllustration() {
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden="true">
      <rect x="16" y="10" width="40" height="52" rx="4" fill="var(--bg-secondary)" stroke="var(--border-medium)" strokeWidth="1.5" />
      <line x1="24" y1="24" x2="48" y2="24" stroke="var(--font-tertiary)" strokeWidth="2" strokeLinecap="round" />
      <line x1="24" y1="32" x2="48" y2="32" stroke="var(--font-tertiary)" strokeWidth="2" strokeLinecap="round" />
      <line x1="24" y1="40" x2="40" y2="40" stroke="var(--font-tertiary)" strokeWidth="2" strokeLinecap="round" />
      <rect x="10" y="10" width="6" height="52" rx="2" fill="var(--border-medium)" />
    </svg>
  );
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  'user.created': 'Account created',
  'user.invited': 'Invitation sent',
  'user.invite_queued': 'Invitation queued',
  'user.invite_resent': 'Invitation resent',
  'user.invite_pending_email_changed': 'Pending email corrected',
  'user.invite_cancelled': 'Invitation cancelled',
  'user.invite_expired': 'Invitation expired',
  'user.activated': 'Account activated',
  'user.suspended': 'Account suspended',
  'user.reactivated': 'Account reactivated',
  'user.deleted': 'Account deleted',
  'password.admin_reset': 'Password reset by admin',
  'password.changed': 'Password changed',
  'profile.updated': 'Profile updated',
  'offer.sent': 'Offer sent',
  'offer.accepted': 'Offer accepted',
  'offer.declined': 'Offer declined',
  'offer.confirmed': 'Offer confirmed',
  'offer.rejected': 'Offer rejected',
  'offer.withdrawn': 'Offer withdrawn',
  'offer.expired': 'Offer expired',
  'attendance.clocked_in': 'Clocked in',
  'attendance.clocked_out': 'Clocked out',
  'staff.suspension_notice_sent': 'Suspension notice sent',
  'email.sent': 'Email sent',
  // Wave 5 timeline read model (GET /timeline/staff/:id): archive + the booking lifecycle.
  'staff.archived': 'Archived (leaver)',
  'staff.restored': 'Restored',
  'attendance.checked_in': 'Checked in',
  'attendance.clocked_in_on_behalf': 'Clocked in by venue manager',
  'attendance.clocked_out_on_behalf': 'Clocked out by venue manager',
  'attendance.corrected': 'Attendance corrected',
  'attendance.reviewed': 'Attendance reviewed',
  'payroll_record.approved': 'Payroll approved',
  'payroll_record.rejected': 'Payroll rejected',
};
function describeAuditAction(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action.replace(/[._]/g, ' ');
}

/**
 * Opened globally via:
 *   document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id, type: 'staff' | 'manager' } }))
 *
 * Home tab is a readable profile made of small collapsible field groups,
 * each field independently hover-editable where a real backend mutation
 * exists — never a whole-record edit form. Timeline reuses `audit_log`
 * (via `GET /:id/timeline`, entity-scoped rather than actor-scoped — see
 * `AuditService.listForUser`'s own doc comment for why the general Audit
 * Log page's actor-scoping doesn't apply here). Email reuses the exact
 * same durable-outbox bulk-email endpoint as the Users-table selection
 * action (`POST /staff/bulk-email` with a single id) — one send workflow,
 * not two. Note is a small new `user_note` table shared by both the Staff
 * and Manager panels (see its own entity doc comment).
 */
/** Manager type from the server record — a CEO is not an internal manager, and the current Initial Manager is named as such. */
function managerTypeLabel(record: { type?: string; isInitialManager?: boolean }): string {
  if (record.type === 'venue') return 'Venue manager';
  if (record.type === 'ceo') return 'CEO';
  return record.isInitialManager ? 'Initial Manager' : 'Internal manager';
}

export default function UserDetailPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [userType, setUserType] = useState<UserType>('staff');
  // 'workspace' = a Manager viewing their own workspace's Venue Manager: same panel, server routes under /venue-managers
  // (scoped to the caller's workspace on the server). 'org' = the CEO roster (/managers) or staff.
  const [scope, setScope] = useState<'org' | 'workspace'>('org');
  const [id, setId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('home');
  // Workspace Venue Manager only: the full-page staff picker opened from the footer.
  const [teamPickerOpen, setTeamPickerOpen] = useState(false);
  // One field in edit mode at a time across the whole panel — see
  // EditableField's own doc comment for why this is lifted here rather than
  // each row owning its own boolean.
  const [editingField, setEditingField] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [emailComposerOpen, setEmailComposerOpen] = useState(false);
  const [notesComposerOpen, setNotesComposerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState('');
  const [resetConfirm, setResetConfirm] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailMessage, setEmailMessage] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      if (!detail.id) return;
      setUserType(detail.type === 'manager' || detail.type === 'venueManager' ? 'manager' : 'staff');
      setScope(detail.type === 'venueManager' ? 'workspace' : 'org');
      setId(detail.id);
      setTab(detail.tab === 'notes' ? 'note' : detail.tab === 'reviews' && detail.type === 'staff' ? 'reviews' : 'home');
      setTeamPickerOpen(false);
      setEditingField(null);
      setShowMore(false);
      setEmailComposerOpen(false);
      setNotesComposerOpen(false);
      setMenuOpen(false);
      setError('');
      setResetConfirm(false);
      setCancelConfirm(false);
      setDeleteConfirm(false);
      setDeleteConfirmText('');
      setEmailSubject('');
      setEmailMessage('');
      setNoteDraft('');
      setOpen(true);
    };
    document.addEventListener('open-user-detail', handler);
    return () => document.removeEventListener('open-user-detail', handler);
  }, []);

  useEffect(() => {
    const closeOnOtherPanel = () => setOpen(false);
    document.addEventListener('open-create-user', closeOnOtherPanel);
    document.addEventListener('open-bulk-email', closeOnOtherPanel);
    return () => {
      document.removeEventListener('open-create-user', closeOnOtherPanel);
      document.removeEventListener('open-bulk-email', closeOnOtherPanel);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  // Leaving Home unmounts every field row anyway, but without this a stale
  // `editingField` would silently reopen that same row's editor the instant
  // the manager switches back — not a crash, just surprising.
  useEffect(() => { setEditingField(null); }, [tab]);

  const endpoint = userType === 'staff' ? 'staff' : scope === 'workspace' ? 'venue-managers' : 'managers';

  const { data: record, isLoading } = useQuery({
    queryKey: [endpoint, id],
    queryFn: async () => { const { data } = await api.get(`/${endpoint}/${id}`); return data; },
    enabled: !!id && open,
    refetchInterval: (query) => {
      const status = (query.state.data as { invitationStatus?: InvitationStatus } | undefined)?.invitationStatus;
      return status === 'queued' || status === 'sending' ? 2000 : false;
    },
  });
  // A workspace Venue Manager opened by their own Manager (reference layout: More tabs, Assigned staff tab, photo tile).
  const vmScope = userType === 'manager' && scope === 'workspace' && record?.type === 'venue';

  const { data: timeline, isLoading: timelineLoading } = useQuery({
    queryKey: [endpoint, id, 'timeline'],
    queryFn: async () => {
      // Staff: the wave-5 per-entity timeline (offers, bookings, attendance, payroll — scope and money decided server-side).
      if (userType === 'staff') {
        const { data } = await api.get<{ items: unknown[] }>(`/timeline/staff/${id}`, { params: { limit: 100 } });
        return data.items;
      }
      const { data } = await api.get(`/${endpoint}/${id}/timeline`);
      return data;
    },
    enabled: !!id && open && tab === 'timeline',
  });

  // Same source of truth Create Staff's own "Job role" field reads
  // (`GET /job-roles`) — never a second, independent job-role value. "Job
  // role" (Employment) and "Primary job role" (Work Information) both
  // resolve a name from this one list against the one `record.jobRoleId`.
  const { data: jobRoles = [] } = useQuery({
    queryKey: ['job-roles'],
    queryFn: async () => { const { data } = await api.get('/job-roles'); return data; },
    enabled: open && userType === 'staff',
  });
  const jobRoleName = (jobRoleId: string | null) => jobRoles.find((r: any) => r.id === jobRoleId)?.name ?? null;

  const { data: notes, isLoading: notesLoading } = useQuery({
    queryKey: [endpoint, id, 'notes'],
    queryFn: async () => { const { data } = await api.get(`/${endpoint}/${id}/notes`); return data; },
    enabled: !!id && open && tab === 'note',
  });

  // Real outbound history only — never a fabricated inbox. `status` is
  // rendered as-is from the real EmailOutboxStatus value; nothing here ever
  // claims "Sent" for anything but a genuine SENT row.
  const { data: emails, isLoading: emailsLoading } = useQuery({
    queryKey: [endpoint, id, 'emails'],
    queryFn: async () => { const { data } = await api.get(`/${endpoint}/${id}/emails`); return data; },
    enabled: !!id && open && tab === 'email',
  });

  const invalidateRecord = () => {
    qc.invalidateQueries({ queryKey: [endpoint] });
    qc.invalidateQueries({ queryKey: [endpoint, id] });
  };

  const updateField = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/${endpoint}/${id}`, patch),
    onSuccess: invalidateRecord,
  });

  // CF-04: for an account that can already sign in, the server answers STEP_UP_REQUIRED; the change then needs the
  // administrator's own password and only applies once the new address confirms it (`pending_verification`).
  const changeEmail = useMutation({
    mutationFn: (body: { email: string; currentPassword?: string }) => api.patch(`/${endpoint}/${id}/email`, body),
    onSuccess: (res) => {
      invalidateRecord();
      if (res?.data?.status === 'pending_verification') setEmailStepUp(null);
    },
  });
  const [emailStepUp, setEmailStepUp] = useState<string | null>(null);
  const [emailPending, setEmailPending] = useState<string | null>(null);
  async function saveEmail(email: string) {
    try {
      const res = await changeEmail.mutateAsync({ email });
      if (res?.data?.status === 'pending_verification') setEmailPending(email);
    } catch (e: any) {
      if (e?.response?.data?.code === 'STEP_UP_REQUIRED') { setEmailStepUp(email); return; }
      throw e;
    }
  }

  const setActive = useMutation({
    mutationFn: (active: boolean) => api.post(`/${endpoint}/${id}/${active ? 'reactivate' : 'deactivate'}`),
    onSuccess: (_res, active) => { invalidateRecord(); setError(''); toast.success(active ? 'Account reactivated.' : 'Account deactivated.'); },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Failed to update account status.')),
  });

  const resetPassword = useMutation({
    mutationFn: () => api.post(`/${endpoint}/${id}/reset-password`),
    onSuccess: () => { invalidateRecord(); setResetConfirm(false); toast.success('A new setup link has been sent.'); },
    onError: (e: unknown) => { toast.error(getApiErrorMessage(e, 'Failed to reset password.')); setResetConfirm(false); },
  });

  const resendInvite = useMutation({
    mutationFn: () => api.post(`/${endpoint}/${id}/resend-invite`),
    onSuccess: () => { invalidateRecord(); toast.success('Invitation queued.'); },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Failed to resend invitation.')),
  });

  const cancelInvite = useMutation({
    mutationFn: () => api.post(`/${endpoint}/${id}/cancel-invite`),
    onSuccess: () => { invalidateRecord(); setCancelConfirm(false); toast.success('Invitation cancelled.'); },
    onError: (e: unknown) => { toast.error(getApiErrorMessage(e, 'Failed to cancel invitation.')); setCancelConfirm(false); },
  });

  const DELETE_BLOCK_MESSAGES: Record<string, string> = {
    USER_HAS_PROTECTED_HISTORY: 'This user has historical workforce records and cannot be permanently deleted. Suspend the account instead.',
    MANAGER_OWNS_WORKSPACE: 'This manager owns a Workspace and cannot be deleted.',
    CANNOT_DELETE_SELF: 'You cannot delete your own account.',
    CANNOT_DELETE_PLATFORM_ADMIN: 'This account holds the platform administrator claim and cannot be deleted.',
  };

  const deleteUser = useMutation({
    // DELETE is a step-up action: the server re-verifies the ACTOR's own current password (StepUpReauthDto). Sending no
    // body made every delete a 400 validation failure.
    mutationFn: (currentPassword: string) => api.delete(`/${endpoint}/${id}`, { data: { currentPassword } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: [endpoint] }); close(); },
    onError: (e: unknown) => {
      const code = getApiErrorCode(e);
      toast.error((code && DELETE_BLOCK_MESSAGES[code]) ?? getApiErrorMessage(e, 'Failed to delete this user.'));
      setDeleteConfirm(false);
      setDeleteConfirmText('');
      setDeletePassword('');
    },
  });

  const sendEmail = useMutation({
    mutationFn: (): Promise<{ data: { queued: number; skipped: number } }> =>
      api.post(`/${endpoint}/bulk-email`, { userIds: [id], subject: emailSubject, message: emailMessage }),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: [endpoint, id, 'emails'] });
      if (data.queued > 0) toast.success('Email queued for delivery.');
      else toast.error('Could not send — this user may be outside your scope.');
    },
    onError: (e: unknown) => setError(getApiErrorMessage(e, 'Failed to send email.')),
  });

  const addNote = useMutation({
    mutationFn: () => api.post(`/${endpoint}/${id}/notes`, { body: noteDraft.trim() }),
    onSuccess: () => { setNoteDraft(''); setNotesComposerOpen(false); qc.invalidateQueries({ queryKey: [endpoint, id, 'notes'] }); },
    onError: (e: unknown) => setError(getApiErrorMessage(e, 'Failed to save note.')),
  });

  // Staff-only — there is no equivalent Manager-avatar endpoint (out of
  // scope for this change; Managers keep their existing, non-interactive
  // avatar below unchanged). Immediate upload: unlike Create Staff's
  // deferred preview, the record already exists here, so there's no reason
  // to hold the file client-side first.
  const uploadAvatar = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.post(`/${userType === 'staff' ? 'staff' : endpoint}/${id}/avatar`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
    },
    onSuccess: () => { invalidateRecord(); toast.success('Picture updated.'); },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Could not upload that file.')),
  });

  const removeAvatar = useMutation({
    mutationFn: () => api.delete(`/${userType === 'staff' ? 'staff' : endpoint}/${id}/avatar`),
    onSuccess: () => { invalidateRecord(); toast.success('Picture removed.'); },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Could not remove that picture.')),
  });

  const close = () => setOpen(false);

  const invitationStatus: InvitationStatus = record?.invitationStatus ?? null;
  const isQueued = invitationStatus === 'queued';
  const isSending = invitationStatus === 'sending';
  const isDeliveryFailed = invitationStatus === 'delivery_failed';
  const isPending = invitationStatus === 'pending' || isQueued || isSending || isDeliveryFailed;
  const isCancelled = invitationStatus === 'cancelled';
  const isExpired = invitationStatus === 'expired';
  const isAccepted = invitationStatus === 'accepted';
  const accountStatus = record?.accountStatus;
  // INVITED / INVITE_EXPIRED never accept suspend, reactivate or reset-password (409 on the server): only invitation
  // actions apply — including when no invitation row exists yet ("invite not sent") and when the link was used but the
  // person has not signed in yet ("accepted").
  const neverSignedIn = accountStatus === 'invited' || accountStatus === 'invite_expired';
  const noInviteSent = neverSignedIn && invitationStatus === null && !record?.pendingInvite;
  const isInviteFamily = isPending || isCancelled || isExpired || isAccepted || neverSignedIn;
  const isSuspended = accountStatus === 'suspended';
  const signsInOnMobile = userType === 'staff' || record?.type === 'venue';
  const atMaxAttempts = (record?.pendingInvite?.sendNumber ?? 0) >= 3;
  const sendNumber = record?.pendingInvite?.sendNumber ?? 1;
  // Real account-activation state, not `employmentStatus` — see
  // `isActive`'s old definition in git history for why that was wrong: a
  // staff member can have `employmentStatus === 'active'` by default while
  // their account has never been activated, which showed "Active" here
  // while the Users table (correctly gated on `accountStatus`) showed
  // "Pending invite".
  const isActive = record?.accountStatus === 'active';

  const name = record ? `${record.firstName} ${record.lastName}` : '';

  const fieldPatch = (key: string) => async (v: string | string[]) => { await updateField.mutateAsync({ [key]: v }); };

  // The ONE canonical status derivation, shared with the Users table
  // (`getStaffDisplayStatus` in `staffStatus.ts`) — used for both the header
  // badge and the Key Information "Status" row so this drawer can never
  // disagree with the table it was opened from.
  const displayStatus = record
    ? getStaffDisplayStatus({
        userType,
        accountStatus: record.accountStatus,
        employmentStatus: record.employmentStatus,
        invitationStatus,
        pendingInvite: record.pendingInvite ?? null,
      })
    : null;
  const statusLabel = displayStatus?.label ?? '';
  const statusClass = displayStatus?.tone ?? 'inactive';

  // Email + phone fields: pills under the name for staff / the CEO roster; inside Personal Details for the workspace
  // Venue Manager layout (reference design).
  const contactFields = record ? (
    <>
        {/* Reuses the exact same hover-to-edit interaction as every
            other field in this panel — see `EditableField`'s own
            doc comment. Email goes through the separate
            uniqueness-checked `changeEmail` endpoint (no `email`
            field exists on `UpdateStaffDto`, by design); phone goes
            through the ordinary `PATCH /staff/:id` path like any
            other profile field. */}
        <EditableField
          label="Email"
          value={record.email}
          type="email"
          required
          editable
          format={(v) => <span className="detail-contact-value"><IconMail size={12} /> {v as string}</span>}
          onSave={async (v) => { await saveEmail(v as string); }}
          editing={editingField === 'email'}
          onEditStart={() => setEditingField('email')}
          onEditEnd={() => setEditingField(null)}
        />
        {emailPending && (
          <p role="status" className="detail-contact-value" style={{ fontSize: 12, color: 'var(--font-secondary)' }}>
            Confirmation link sent to {emailPending}. The current email stays until it is confirmed.
          </p>
        )}
        {emailStepUp && (
          <EmailChangeStepUpDialog
            newEmail={emailStepUp}
            onCancel={() => setEmailStepUp(null)}
            onSubmit={async (currentPassword) => {
              const pending = emailStepUp;
              await changeEmail.mutateAsync({ email: pending, currentPassword });
              setEmailPending(pending);
              setEmailStepUp(null);
            }}
          />
        )}
        <EditableField
          label="Phone"
          value={record.phone}
          type="phone"
          editable
          format={(v) => <span className="detail-contact-value"><IconPhone size={12} /> {v as string}</span>}
          onSave={fieldPatch('phone')}
          editing={editingField === 'phone'}
          onEditStart={() => setEditingField('phone')}
          onEditEnd={() => setEditingField(null)}
        />
    </>
  ) : null;

  return (
    <Drawer
      open={open}
      onClose={close}
      title={record ? name : userType === 'staff' ? 'Staff member' : 'Manager'}
      description={record ? (userType === 'staff' ? `Staff • ${record.staffRef}` : scope === 'workspace' && Array.isArray(record.venues) ? `Venue manager • ${record.venues.map((v: { name: string }) => v.name).join(', ') || 'No venue'}` : `Manager • ${managerTypeLabel(record).replace(/ manager$/, '')}`) : undefined}
      avatar={record && <Avatar imageKey={record.avatarKey} label={name} variant="panel" />}
      icon={record && <span className={`badge badge-${statusClass}`}>{statusLabel}</span>}
      loading={isLoading}
      compactHeader
      contentKey={id ? `${userType}:${id}` : undefined}
    >
      {!record ? (
        <DetailSkeleton />
      ) : (
        <div className="detail-panel-shell">
          {/* Compact tabs + overflow menu. VM: Notes and Assigned staff (owner-assigned team only); Staff: Notes and Staff reviews. */}
          <DetailTabs<DetailTab>
            primary={[
              { id: 'home', label: 'Overview', icon: <IconHome2 size={14} /> },
              { id: 'timeline', label: 'Timeline', icon: <IconHistory size={14} /> },
              { id: 'email', label: 'Email', icon: <IconMail size={14} /> },
            ]}
            overflow={[
              { id: 'note', label: 'Notes', icon: <IconNotes size={14} /> },
              ...(vmScope ? [{ id: 'staff' as const, label: 'Assigned staff', icon: <IconUsersGroup size={14} /> }] : []),
              ...(userType === 'staff' ? [{ id: 'reviews' as const, label: 'Staff reviews', icon: <IconStar size={14} /> }] : []),
            ]}
            value={tab}
            onChange={setTab}
          />

          <AnimatePresence mode="wait" initial={false}>
          {/* Tab content cross-fades (each tab already renders its own content; no extra remount). */}
          <motion.div className="detail-panel-body" key={tab} variants={contentSwap} initial="hidden" animate="visible" exit="exit">
            {tab === 'home' && (
              <div>
                <div className="detail-profile-summary">
                  {userType === 'staff' || vmScope ? (
                    <AvatarUploadButton
                      imageKey={record.avatarKey}
                      label={name}
                      onFileSelected={(file) => uploadAvatar.mutate(file)}
                      disabled={uploadAvatar.isPending}
                    />
                  ) : (
                    <Avatar imageKey={record.avatarKey} label={name} variant="panel" />
                  )}
                  <div className="detail-profile-summary-text">
                    <div className="detail-profile-summary-name">{name}</div>
                    {!(vmScope && !record.jobTitle) && (
                      <div className="detail-profile-summary-role">
                        {userType === 'staff' ? (jobRoleName(record.jobRoleId) ?? '—') : (record.jobTitle || '—')}
                      </div>
                    )}
                    {(userType === 'staff' || vmScope) && record.avatarKey && (
                      <button
                        type="button"
                        className="btn-link-muted"
                        onClick={() => removeAvatar.mutate()}
                        disabled={removeAvatar.isPending}
                      >
                        Remove photo
                      </button>
                    )}
                  </div>
                  {!vmScope && (
                    <button type="button" className="btn btn-outline" onClick={() => setEditingField('firstName')}>
                      <IconPencil size={13} /> Edit
                    </button>
                  )}
                </div>
                {!vmScope && <div className="detail-contact-pills">{contactFields}</div>}

                <DetailGroup title="Key Information">
                  {userType === 'staff' ? (
                    <>
                      {/* Server-generated and permanent (see StaffService.generateStaffRef) — never editable, not even via a hover pencil. */}
                      <EditableField label="Staff reference" value={record.staffRef} editable={false} editing={false} onEditStart={() => {}} onEditEnd={() => {}} />
                      <EditableField
                        label="Job role"
                        value={record.jobRoleId}
                        type="select"
                        options={jobRoles.map((r: any) => ({ value: r.id, label: r.name }))}
                        editable
                        onSave={fieldPatch('jobRoleId')}
                        format={(v) => jobRoleName(v as string)}
                        editing={editingField === 'jobRoleId'}
                        onEditStart={() => setEditingField('jobRoleId')}
                        onEditEnd={() => setEditingField(null)}
                      />
                      <EditableField
                        label="Employment type"
                        value={record.employmentType}
                        type="select"
                        options={EMPLOYMENT_TYPES}
                        editable
                        onSave={fieldPatch('employmentType')}
                        editing={editingField === 'employmentType'}
                        onEditStart={() => setEditingField('employmentType')}
                        onEditEnd={() => setEditingField(null)}
                      />
                      <EditableField
                        label="Start date"
                        value={record.startDate}
                        type="date"
                        editable
                        onSave={fieldPatch('startDate')}
                        format={(v) => isoToDisplay(v as string)}
                        editing={editingField === 'startDate'}
                        onEditStart={() => setEditingField('startDate')}
                        onEditEnd={() => setEditingField(null)}
                      />
                      <EditableField
                        label="Default rate"
                        value={record.defaultPayRatePence ? (record.defaultPayRatePence / 100).toFixed(2) : ''}
                        type="number"
                        editable
                        onSave={async (v) => { await updateField.mutateAsync({ defaultPayRatePence: Math.round(Number(v) * 100) }); }}
                        format={(v) => `£${Number(v).toFixed(2)}/hr`}
                        editing={editingField === 'defaultPayRatePence'}
                        onEditStart={() => setEditingField('defaultPayRatePence')}
                        onEditEnd={() => setEditingField(null)}
                      />
                      <InfoRow label="Status" value={<span className={`badge badge-${statusClass}`}>{statusLabel}</span>} />
                    </>
                  ) : (
                    <>
                      <EditableField label="Manager type" value={managerTypeLabel(record)} editable={false} editing={false} onEditStart={() => {}} onEditEnd={() => {}} />
                      {Array.isArray(record.venues) && (
                        <InfoRow label="Venue" value={record.venues.length ? record.venues.map((v: { name: string }) => v.name).join(', ') : 'No venue assigned'} />
                      )}
                      <EditableField label="Job title" value={record.jobTitle} editable onSave={fieldPatch('jobTitle')} editing={editingField === 'jobTitle'} onEditStart={() => setEditingField('jobTitle')} onEditEnd={() => setEditingField(null)} />
                      <InfoRow label="Status" value={<span className={`badge badge-${statusClass}`}>{statusLabel}</span>} />
                    </>
                  )}
                </DetailGroup>

                <DetailGroup title="Personal Details">
                  <EditableField label="First name" value={record.firstName} required editable onSave={fieldPatch('firstName')} editing={editingField === 'firstName'} onEditStart={() => setEditingField('firstName')} onEditEnd={() => setEditingField(null)} />
                  <EditableField label="Last name" value={record.lastName} required editable onSave={fieldPatch('lastName')} editing={editingField === 'lastName'} onEditStart={() => setEditingField('lastName')} onEditEnd={() => setEditingField(null)} />
                  {vmScope && contactFields}

                  {userType === 'staff' && (
                    <>
                      <EditableField label="Preferred name" value={record.preferredName} editable onSave={fieldPatch('preferredName')} editing={editingField === 'preferredName'} onEditStart={() => setEditingField('preferredName')} onEditEnd={() => setEditingField(null)} />
                      <EditableField
                        label="Date of birth"
                        value={record.dateOfBirth}
                        type="date"
                        editable
                        onSave={fieldPatch('dateOfBirth')}
                        format={(v) => isoToDisplay(v as string)}
                        editing={editingField === 'dateOfBirth'}
                        onEditStart={() => setEditingField('dateOfBirth')}
                        onEditEnd={() => setEditingField(null)}
                      />
                    </>
                  )}
                </DetailGroup>


                {userType === 'staff' && (
                  <>
                    <DetailGroup title="Additional Information">
                      <EditableField label="Address" value={record.address} editable onSave={fieldPatch('address')} editing={editingField === 'address'} onEditStart={() => setEditingField('address')} onEditEnd={() => setEditingField(null)} />
                      <EditableField label="City" value={record.city} editable onSave={fieldPatch('city')} editing={editingField === 'city'} onEditStart={() => setEditingField('city')} onEditEnd={() => setEditingField(null)} />
                      <EditableField label="Postcode" value={record.postcode} editable onSave={fieldPatch('postcode')} editing={editingField === 'postcode'} onEditStart={() => setEditingField('postcode')} onEditEnd={() => setEditingField(null)} />
                    </DetailGroup>

                    <button type="button" className="detail-show-more-toggle" onClick={() => setShowMore((v) => !v)}>
                      {showMore ? 'Show less details' : 'Show more details'}
                      <IconChevronDown size={14} className={`detail-accordion-chevron${showMore ? ' open' : ''}`} />
                    </button>
                    <div className={`detail-accordion-body-wrap${showMore ? ' open' : ''}`}>
                      <div className="detail-accordion-body-inner">
                        <div className="detail-accordion-body">
                          <DetailGroup title="Emergency Contact">
                            <EditableField label="Full name" value={record.emergencyContactName} required editable onSave={fieldPatch('emergencyContactName')} editing={editingField === 'emergencyContactName'} onEditStart={() => setEditingField('emergencyContactName')} onEditEnd={() => setEditingField(null)} />
                            <EditableField label="Relationship" value={record.emergencyContactRelationship} required editable onSave={fieldPatch('emergencyContactRelationship')} editing={editingField === 'emergencyContactRelationship'} onEditStart={() => setEditingField('emergencyContactRelationship')} onEditEnd={() => setEditingField(null)} />
                            <EditableField label="Phone number" value={record.emergencyContactPhone} required editable onSave={fieldPatch('emergencyContactPhone')} type="tel" editing={editingField === 'emergencyContactPhone'} onEditStart={() => setEditingField('emergencyContactPhone')} onEditEnd={() => setEditingField(null)} />
                          </DetailGroup>

                          <DetailGroup title="Availability">
                            <EditableField
                              label="Available days"
                              value={record.availableDays}
                              type="multiselect"
                              options={WEEKDAYS.map((d) => ({ value: d, label: d.slice(0, 3) }))}
                              editable
                              onSave={fieldPatch('availableDays')}
                              editing={editingField === 'availableDays'}
                              onEditStart={() => setEditingField('availableDays')}
                              onEditEnd={() => setEditingField(null)}
                            />
                            <EditableField
                              label="Preferred shift times"
                              value={record.preferredShiftTimes}
                              type="select"
                              options={SHIFT_TIMES}
                              editable
                              onSave={fieldPatch('preferredShiftTimes')}
                              editing={editingField === 'preferredShiftTimes'}
                              onEditStart={() => setEditingField('preferredShiftTimes')}
                              onEditEnd={() => setEditingField(null)}
                            />
                            <EditableField
                              label="Maximum hours per week"
                              value={record.maxHoursPerWeek != null ? String(record.maxHoursPerWeek) : null}
                              type="number"
                              editable
                              onSave={async (v) => { await updateField.mutateAsync({ maxHoursPerWeek: Number(v) }); }}
                              editing={editingField === 'maxHoursPerWeek'}
                              onEditStart={() => setEditingField('maxHoursPerWeek')}
                              onEditEnd={() => setEditingField(null)}
                            />
                          </DetailGroup>

                        </div>
                      </div>
                    </div>
                  </>
                )}

              </div>
            )}

            {tab === 'reviews' && userType === 'staff' && id && <StaffReviewsTab staffId={id} staffName={name} />}
            {tab === 'staff' && vmScope && id && (
              <VenueManagerTeamSection venueManagerId={id} venueManagerName={name} pickerOpen={teamPickerOpen} onPickerClose={() => setTeamPickerOpen(false)} />
            )}

            {tab === 'timeline' && (
              <div className="detail-timeline">
                {timelineLoading ? (
                  <p className="cell-muted" style={{ padding: 8 }}>Loading…</p>
                ) : !timeline?.length ? (
                  <p className="cell-muted" style={{ padding: 8 }}>No activity recorded yet.</p>
                ) : (
                  timeline.map((item: any) => (
                    <div key={item.id} className="detail-timeline-item">
                      <div className="detail-timeline-dot" />
                      <div className="detail-timeline-content">
                        <span className="detail-timeline-action">{describeAuditAction(item.action)}</span>
                        <span className="detail-timeline-meta">
                          {item.actor?.fullName ? `${item.actor.fullName} · ` : ''}{timeAgo(item.createdAt)}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {tab === 'email' && (
              <div className="detail-panel-tab-list">
                <div className="detail-panel-tab-header">
                  <span>Emails {emailsLoading ? '' : (emails?.length ?? 0)}</span>
                  <button type="button" className="btn-icon" aria-label="Send email" onClick={() => { setError(''); setEmailComposerOpen(true); }}>
                    <IconPlus size={16} />
                  </button>
                </div>

                {emailComposerOpen ? (
                  <div className="detail-email-compose">
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label>To</label>
                      <input readOnly value={record.email} style={{ background: 'var(--bg-secondary)', cursor: 'not-allowed' }} />
                    </div>
                    <div className="field">
                      <label>Subject</label>
                      <input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} placeholder="Subject" autoFocus />
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label>Message</label>
                      <textarea value={emailMessage} onChange={(e) => setEmailMessage(e.target.value)} placeholder="Write your message…" rows={8} />
                    </div>
                    {error && <p className="error" style={{ margin: '8px 0 0' }}>{error}</p>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button type="button" className="btn btn-outline" onClick={() => setEmailComposerOpen(false)}>Cancel</button>
                      <button
                        type="button"
                        className="btn btn-dark"
                        disabled={!emailSubject.trim() || !emailMessage.trim() || sendEmail.isPending}
                        onClick={() => {
                          setError('');
                          sendEmail.mutate(undefined, { onSuccess: ({ data }) => { if (data.queued > 0) { setEmailSubject(''); setEmailMessage(''); setEmailComposerOpen(false); } } });
                        }}
                      >
                        {sendEmail.isPending ? 'Sending…' : 'Send Email'}
                      </button>
                    </div>
                  </div>
                ) : emailsLoading ? (
                  <p className="cell-muted" style={{ padding: 8 }}>Loading…</p>
                ) : !emails?.length ? (
                  <div className="detail-empty-state">
                    <MailboxIllustration />
                    <p className="detail-empty-state-title">Empty Inbox</p>
                    <p className="detail-empty-state-subtitle">No email exchange has occurred with this staff yet.</p>
                    <button type="button" className="btn btn-dark" onClick={() => setEmailComposerOpen(true)}>Send Email</button>
                  </div>
                ) : (
                  <>
                    {emails.map((e: any) => (
                      <div key={e.id} className="detail-note-item">
                        <div className="detail-note-meta">
                          <span>{e.subject}</span>
                          <span className={`badge badge-${e.status === 'SENT' ? 'active' : e.status === 'FAILED' || e.status === 'CANCELLED' ? 'cancelled' : 'pending'}`}>{e.status}</span>
                        </div>
                        <p className="cell-muted" style={{ margin: '2px 0 0', fontSize: 11 }}>{timeAgo(e.createdAt)}</p>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {tab === 'note' && (
              <div className="detail-panel-tab-list">
                <div className="detail-panel-tab-header">
                  <span>Notes {notesLoading ? '' : (notes?.length ?? 0)}</span>
                  <button type="button" className="btn-icon" aria-label="New note" onClick={() => { setError(''); setNotesComposerOpen(true); }}>
                    <IconPlus size={16} />
                  </button>
                </div>

                {notesComposerOpen && (
                  <div className="field" style={{ marginBottom: 8 }}>
                    <label>Add note</label>
                    <textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Write a note about this person…" rows={4} autoFocus />
                    {error && <p className="error" style={{ margin: '6px 0 0' }}>{error}</p>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button type="button" className="btn btn-outline" onClick={() => { setNotesComposerOpen(false); setNoteDraft(''); setError(''); }}>Cancel</button>
                      <button
                        type="button"
                        className="btn btn-dark"
                        disabled={!noteDraft.trim() || addNote.isPending}
                        onClick={() => { setError(''); addNote.mutate(); }}
                      >
                        {addNote.isPending ? 'Saving…' : 'Save note'}
                      </button>
                    </div>
                  </div>
                )}

                {!notesComposerOpen && (notesLoading ? (
                  <p className="cell-muted" style={{ padding: 8 }}>Loading…</p>
                ) : !notes?.length ? (
                  <div className="detail-empty-state">
                    <NotebookIllustration />
                    <p className="detail-empty-state-title">No notes</p>
                    <p className="detail-empty-state-subtitle">There are no associated notes with this staff record.</p>
                    <button type="button" className="btn btn-dark" onClick={() => setNotesComposerOpen(true)}>+ New note</button>
                  </div>
                ) : (
                  notes.map((n: any) => (
                    <div key={n.id} className="detail-note-item">
                      <div className="detail-note-meta">
                        <span>{n.authorName ?? 'Unknown'}</span>
                        <span className="cell-muted">{timeAgo(n.createdAt)}</span>
                      </div>
                      <p className="detail-note-body">{n.body}</p>
                    </div>
                  ))
                ))}
              </div>
            )}
          </motion.div>
          </AnimatePresence>

          {(tab === 'home' || (tab === 'staff' && vmScope)) && (
            <div className="detail-bottom-bar">
              <div className="detail-more-menu" ref={menuRef}>
                <button type="button" className="btn-icon" title="More actions" aria-label="More actions" onClick={() => setMenuOpen((o) => !o)}>
                  <IconDotsVertical size={16} />
                </button>
                {menuOpen && (
                  <div className="detail-more-menu-dropdown detail-more-menu-dropdown-up">
                    {isInviteFamily ? (
                      <>
                        {(isPending || isExpired || isAccepted || noInviteSent) && !atMaxAttempts && (
                          <button type="button" onClick={() => { setMenuOpen(false); resendInvite.mutate(); }} disabled={resendInvite.isPending}>
                            <IconSend size={14} />
                            <span style={{ flex: 1, textAlign: 'left' }}>{isExpired ? 'Re-invite' : noInviteSent ? 'Send invitation' : isAccepted ? 'Send a new setup link' : 'Resend invitation'}</span>
                            {!noInviteSent && <span className="cell-muted">{sendNumber} of 3</span>}
                          </button>
                        )}
                        {isCancelled && !atMaxAttempts && (
                          <button type="button" onClick={() => { setMenuOpen(false); resendInvite.mutate(); }} disabled={resendInvite.isPending}>
                            <IconSend size={14} />
                            <span style={{ flex: 1, textAlign: 'left' }}>Re-invite</span>
                            <span className="cell-muted">{sendNumber} of 3</span>
                          </button>
                        )}
                        {isPending && (
                          <button type="button" onClick={() => { setMenuOpen(false); setCancelConfirm(true); }}>
                            <IconBan size={14} />
                            Cancel invitation
                          </button>
                        )}
                        <div className="detail-more-menu-divider" />
                        <button type="button" className="danger" onClick={() => { setMenuOpen(false); setDeleteConfirm(true); }}>
                          <IconTrash size={14} />
                          Delete user
                        </button>
                      </>
                    ) : (
                      <>
                        {(isActive || isSuspended) && (
                          <button type="button" onClick={() => { setMenuOpen(false); setResetConfirm(true); }}>
                            <IconKey size={14} />
                            Reset password
                          </button>
                        )}
                        {(isActive || isSuspended) && (
                          <button type="button" onClick={() => { setMenuOpen(false); setActive.mutate(!isActive); }}>
                            {isActive ? <IconUserOff size={14} /> : <IconUserCheck size={14} />}
                            {isActive ? (userType === 'staff' ? 'Deactivate' : 'Suspend') : 'Reactivate'}
                          </button>
                        )}
                        <div className="detail-more-menu-divider" />
                        <button type="button" className="danger" onClick={() => { setMenuOpen(false); setDeleteConfirm(true); }}>
                          <IconTrash size={14} />
                          Delete user
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {tab === 'staff' && vmScope ? (
                <button type="button" className="btn btn-outline" style={{ gap: 6 }} onClick={() => setTeamPickerOpen(true)}>
                  <IconPlus size={14} />
                  Add Staff
                </button>
              ) : (
                <button type="button" className="btn btn-outline" style={{ gap: 6 }} onClick={() => { setTab('email'); setEmailComposerOpen(true); }}>
                  <IconMail size={14} />
                  Send Email
                </button>
              )}
            </div>
          )}

          {isAccepted && tab === 'home' && (
            <p className="cell-muted" style={{ fontSize: 12, margin: '0 4px 8px' }}>
              {record.firstName} has set a password. The account becomes active the first time they sign in to the {signsInOnMobile ? 'ADOLPHUS mobile app' : 'Manager Portal'}.
            </p>
          )}

          {resetConfirm && (
            <div className="drawer-discard-confirm">
              <p>Reset {record.firstName}'s password? They'll be emailed a new one-time setup link and any active sessions will be signed out.</p>
              <div className="modal-actions" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
                <button type="button" className="btn btn-outline" onClick={() => setResetConfirm(false)}>Cancel</button>
                <button type="button" className="btn btn-dark" disabled={resetPassword.isPending} onClick={() => resetPassword.mutate()}>
                  {resetPassword.isPending ? 'Resetting…' : 'Reset password'}
                </button>
              </div>
            </div>
          )}

          {cancelConfirm && (
            <div className="drawer-discard-confirm">
              <p>Cancel this invitation? {record.firstName} will no longer be able to activate this account with the link they were sent.</p>
              <div className="modal-actions" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
                <button type="button" className="btn btn-outline" onClick={() => setCancelConfirm(false)}>Back</button>
                <button type="button" className="btn btn-dark" disabled={cancelInvite.isPending} onClick={() => cancelInvite.mutate()}>
                  {cancelInvite.isPending ? 'Cancelling…' : 'Cancel invitation'}
                </button>
              </div>
            </div>
          )}

          {deleteConfirm && (
            <div className="drawer-discard-confirm">
              <p>Delete {record.firstName} {record.lastName}? This permanently removes this account where deletion is permitted. This cannot be undone.</p>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="delete-user-confirm">Type DELETE to confirm</label>
                <input id="delete-user-confirm" value={deleteConfirmText} onChange={(e) => setDeleteConfirmText(e.target.value)} placeholder="DELETE" autoFocus />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="delete-user-password">Your current password</label>
                <input id="delete-user-password" type="password" autoComplete="current-password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} />
              </div>
              <div className="modal-actions" style={{ marginTop: 8, borderTop: 'none', paddingTop: 0 }}>
                <button type="button" className="btn btn-outline" onClick={() => { setDeleteConfirm(false); setDeleteConfirmText(''); setDeletePassword(''); }}>Cancel</button>
                <button type="button" className="btn btn-danger" disabled={deleteConfirmText !== 'DELETE' || !deletePassword || deleteUser.isPending} onClick={() => deleteUser.mutate(deletePassword)}>
                  {deleteUser.isPending ? 'Deleting…' : 'Delete user'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
