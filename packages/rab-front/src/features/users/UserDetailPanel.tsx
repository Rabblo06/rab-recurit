import { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconUserOff, IconUserCheck, IconKey, IconSend, IconMail, IconBan, IconTrash, IconDotsVertical,
  IconPencil, IconHome2, IconHistory, IconNotes, IconPhone, IconChevronDown, IconPlus,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';
import Avatar from '../../shared/components/Avatar';
import DateInput, { isoToDisplay, todayIso } from '../../shared/components/DateInput';
import { DetailSkeleton } from '../../shared/components/LoadingState';
import { timeAgo } from '../../shared/lib/timeAgo';

type UserType = 'staff' | 'manager';
type DetailTab = 'home' | 'timeline' | 'email' | 'note';

/** Same suggestion lists as CreateUserModal's own — kept in sync, not re-derived from a shared module (three short arrays, not worth a new shared file for). */
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Temporary', 'Casual', 'Contract'];
const SHIFT_TIMES = ['Morning', 'Afternoon', 'Evening', 'Night', 'Flexible'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

type FieldControlType = 'text' | 'date' | 'tel' | 'email' | 'number' | 'select' | 'multiselect' | 'tags' | 'textarea';
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
  useEffect(() => {
    if (!editing || !(type === 'select' || type === 'multiselect' || type === 'date')) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) onEditEnd();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [editing, type]);

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
    } catch (e: any) {
      const message = e?.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'Failed to save.');
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
export default function UserDetailPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [userType, setUserType] = useState<UserType>('staff');
  const [id, setId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('home');
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
  const [resetDone, setResetDone] = useState(false);
  const [resendDone, setResendDone] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailMessage, setEmailMessage] = useState('');
  const [emailResult, setEmailResult] = useState<{ queued: number; skipped: number } | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      if (!detail.id) return;
      setUserType(detail.type === 'manager' ? 'manager' : 'staff');
      setId(detail.id);
      setTab('home');
      setEditingField(null);
      setShowMore(false);
      setEmailComposerOpen(false);
      setNotesComposerOpen(false);
      setMenuOpen(false);
      setError('');
      setResetConfirm(false);
      setResetDone(false);
      setResendDone(false);
      setCancelConfirm(false);
      setDeleteConfirm(false);
      setDeleteConfirmText('');
      setEmailSubject('');
      setEmailMessage('');
      setEmailResult(null);
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

  const endpoint = userType === 'staff' ? 'staff' : 'managers';

  type InvitationStatus = 'pending' | 'cancelled' | 'expired' | 'queued' | 'sending' | 'delivery_failed' | null;

  const { data: record, isLoading } = useQuery({
    queryKey: [endpoint, id],
    queryFn: async () => { const { data } = await api.get(`/${endpoint}/${id}`); return data; },
    enabled: !!id && open,
    refetchInterval: (query) => {
      const status = (query.state.data as { invitationStatus?: InvitationStatus } | undefined)?.invitationStatus;
      return status === 'queued' || status === 'sending' ? 2000 : false;
    },
  });

  const { data: timeline, isLoading: timelineLoading } = useQuery({
    queryKey: [endpoint, id, 'timeline'],
    queryFn: async () => { const { data } = await api.get(`/${endpoint}/${id}/timeline`); return data; },
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

  const changeEmail = useMutation({
    mutationFn: (email: string) => api.patch(`/${endpoint}/${id}/email`, { email }),
    onSuccess: () => { invalidateRecord(); setResendDone(false); },
  });

  const setActive = useMutation({
    mutationFn: (active: boolean) => api.post(`/${endpoint}/${id}/${active ? 'reactivate' : 'deactivate'}`),
    onSuccess: () => { invalidateRecord(); setError(''); },
    onError: (e: any) => {
      const message = e?.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'Failed to update account status.');
    },
  });

  const resetPassword = useMutation({
    mutationFn: () => api.post(`/${endpoint}/${id}/reset-password`),
    onSuccess: () => { invalidateRecord(); setResetConfirm(false); setResetDone(true); },
    onError: (e: any) => { setError(e?.response?.data?.message ?? 'Failed to reset password.'); setResetConfirm(false); },
  });

  const resendInvite = useMutation({
    mutationFn: () => api.post(`/${endpoint}/${id}/resend-invite`),
    onSuccess: () => { invalidateRecord(); setResendDone(true); },
    onError: (e: any) => {
      const message = e?.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'Failed to resend invitation.');
    },
  });

  const cancelInvite = useMutation({
    mutationFn: () => api.post(`/${endpoint}/${id}/cancel-invite`),
    onSuccess: () => { invalidateRecord(); setCancelConfirm(false); },
    onError: (e: any) => { setError(e?.response?.data?.message ?? 'Failed to cancel invitation.'); setCancelConfirm(false); },
  });

  const DELETE_BLOCK_MESSAGES: Record<string, string> = {
    USER_HAS_PROTECTED_HISTORY: 'This user has historical workforce records and cannot be permanently deleted. Suspend the account instead.',
    MANAGER_OWNS_WORKSPACE: 'This manager owns a Workspace and cannot be deleted.',
    CANNOT_DELETE_SELF: 'You cannot delete your own account.',
    CANNOT_DELETE_PLATFORM_ADMIN: 'This account holds the platform administrator claim and cannot be deleted.',
  };

  const deleteUser = useMutation({
    mutationFn: () => api.delete(`/${endpoint}/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: [endpoint] }); close(); },
    onError: (e: any) => {
      const code = e?.response?.data?.code as string | undefined;
      const message = (code && DELETE_BLOCK_MESSAGES[code]) ?? e?.response?.data?.message ?? 'Failed to delete this user.';
      setError(Array.isArray(message) ? message.join(', ') : message);
      setDeleteConfirm(false);
      setDeleteConfirmText('');
    },
  });

  const sendEmail = useMutation({
    mutationFn: (): Promise<{ data: { queued: number; skipped: number } }> =>
      api.post(`/${endpoint}/bulk-email`, { userIds: [id], subject: emailSubject, message: emailMessage }),
    onSuccess: ({ data }) => { setEmailResult(data); qc.invalidateQueries({ queryKey: [endpoint, id, 'emails'] }); },
    onError: (e: any) => setError(e?.response?.data?.message ?? 'Failed to send email.'),
  });

  const addNote = useMutation({
    mutationFn: () => api.post(`/${endpoint}/${id}/notes`, { body: noteDraft.trim() }),
    onSuccess: () => { setNoteDraft(''); setNotesComposerOpen(false); qc.invalidateQueries({ queryKey: [endpoint, id, 'notes'] }); },
    onError: (e: any) => setError(e?.response?.data?.message ?? 'Failed to save note.'),
  });

  const close = () => setOpen(false);

  const isActive = userType === 'staff' ? record?.employmentStatus === 'active' : record?.accountStatus === 'active';

  const invitationStatus: InvitationStatus = record?.invitationStatus ?? null;
  const isQueued = invitationStatus === 'queued';
  const isSending = invitationStatus === 'sending';
  const isDeliveryFailed = invitationStatus === 'delivery_failed';
  const isPending = invitationStatus === 'pending' || isQueued || isSending || isDeliveryFailed;
  const isCancelled = invitationStatus === 'cancelled';
  const isExpired = invitationStatus === 'expired';
  const isInviteFamily = isPending || isCancelled || isExpired;
  const atMaxAttempts = (record?.pendingInvite?.sendNumber ?? 0) >= 3;
  const sendNumber = record?.pendingInvite?.sendNumber ?? 1;

  const name = record ? `${record.firstName} ${record.lastName}` : '';

  const fieldPatch = (key: string) => async (v: string | string[]) => { await updateField.mutateAsync({ [key]: v }); };

  // One real-lifecycle status label/class, used by both the header badge and
  // the Key Information "Status" row — never a hardcoded "Active".
  const statusLabel = isActive ? 'Active' : isPending ? 'Pending invite' : isCancelled ? 'Cancelled' : isExpired ? 'Expired' : 'Suspended';
  const statusClass = isActive ? 'active' : isPending ? 'pending' : isCancelled || isExpired ? 'cancelled' : 'inactive';

  return (
    <Drawer
      open={open}
      onClose={close}
      title={record ? name : userType === 'staff' ? 'Staff member' : 'Manager'}
      description={record ? (userType === 'staff' ? `Staff • ${record.staffRef}` : `Manager • ${record.type === 'venue' ? 'Venue' : 'Internal'}`) : undefined}
      avatar={record && <Avatar imageKey={record.avatarKey} label={name} variant="panel" />}
      icon={record && <span className={`badge badge-${statusClass}`}>{statusLabel}</span>}
      loading={isLoading}
      compactHeader
    >
      {!record ? (
        <DetailSkeleton />
      ) : (
        <div className="detail-panel-shell">
          <div className="detail-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'home'} className={`detail-tab${tab === 'home' ? ' active' : ''}`} onClick={() => setTab('home')}>
              <IconHome2 size={14} /> Overview
            </button>
            <button type="button" role="tab" aria-selected={tab === 'timeline'} className={`detail-tab${tab === 'timeline' ? ' active' : ''}`} onClick={() => setTab('timeline')}>
              <IconHistory size={14} /> Timeline
            </button>
            <button type="button" role="tab" aria-selected={tab === 'email'} className={`detail-tab${tab === 'email' ? ' active' : ''}`} onClick={() => setTab('email')}>
              <IconMail size={14} /> Email
            </button>
            <button type="button" role="tab" aria-selected={tab === 'note'} className={`detail-tab${tab === 'note' ? ' active' : ''}`} onClick={() => setTab('note')}>
              <IconNotes size={14} /> Notes
            </button>
          </div>

          <div className="detail-panel-body">
            {tab === 'home' && (
              <div>
                <div className="detail-profile-summary">
                  <Avatar imageKey={record.avatarKey} label={name} variant="panel" />
                  <div className="detail-profile-summary-text">
                    <div className="detail-profile-summary-name">{name}</div>
                    <div className="detail-profile-summary-role">
                      {userType === 'staff' ? (jobRoleName(record.jobRoleId) ?? '—') : (record.jobTitle || '—')}
                    </div>
                  </div>
                  <button type="button" className="btn btn-outline" onClick={() => setEditingField('firstName')}>
                    <IconPencil size={13} /> Edit
                  </button>
                </div>
                <div className="detail-contact-pills">
                  <span className="detail-contact-pill"><IconMail size={12} /> {record.email}</span>
                  <span className="detail-contact-pill"><IconPhone size={12} /> {record.phone || '—'}</span>
                </div>

                <DetailGroup title="Key Information">
                  {userType === 'staff' ? (
                    <>
                      <EditableField label="Staff reference" value={record.staffRef} editable onSave={fieldPatch('staffRef')} editing={editingField === 'staffRef'} onEditStart={() => setEditingField('staffRef')} onEditEnd={() => setEditingField(null)} />
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
                      <InfoRow label="Status" value={<span className={`badge badge-${statusClass}`}>{record.employmentStatus?.replace(/_/g, ' ') ?? statusLabel}</span>} />
                    </>
                  ) : (
                    <>
                      <EditableField label="Manager type" value={record.type === 'venue' ? 'Venue manager' : 'Internal manager'} editable={false} editing={false} onEditStart={() => {}} onEditEnd={() => {}} />
                      <EditableField label="Job title" value={record.jobTitle} editable onSave={fieldPatch('jobTitle')} editing={editingField === 'jobTitle'} onEditStart={() => setEditingField('jobTitle')} onEditEnd={() => setEditingField(null)} />
                      <InfoRow label="Status" value={<span className={`badge badge-${statusClass}`}>{statusLabel}</span>} />
                    </>
                  )}
                </DetailGroup>

                <DetailGroup title="Personal Details">
                  <EditableField label="First name" value={record.firstName} required editable onSave={fieldPatch('firstName')} editing={editingField === 'firstName'} onEditStart={() => setEditingField('firstName')} onEditEnd={() => setEditingField(null)} />
                  <EditableField label="Last name" value={record.lastName} required editable onSave={fieldPatch('lastName')} editing={editingField === 'lastName'} onEditStart={() => setEditingField('lastName')} onEditEnd={() => setEditingField(null)} />
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

                          <DetailGroup title="Work Information">
                            {/* Same source of truth as Key Information's "Job role" above — a read-only mirror, never a second independent value (see jobRoleName's own doc comment). */}
                            <EditableField label="Primary job role" value={record.jobRoleId} format={() => jobRoleName(record.jobRoleId)} editable={false} editing={false} onEditStart={() => {}} onEditEnd={() => {}} />
                            <EditableField label="Other roles / skills" value={record.otherSkills} editable onSave={fieldPatch('otherSkills')} editing={editingField === 'otherSkills'} onEditStart={() => setEditingField('otherSkills')} onEditEnd={() => setEditingField(null)} />
                            <EditableField
                              label="Years of experience"
                              value={record.yearsExperience != null ? String(record.yearsExperience) : null}
                              type="number"
                              editable
                              onSave={async (v) => { await updateField.mutateAsync({ yearsExperience: Number(v) }); }}
                              editing={editingField === 'yearsExperience'}
                              onEditStart={() => setEditingField('yearsExperience')}
                              onEditEnd={() => setEditingField(null)}
                            />
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

                          <DetailGroup title="Right to Work">
                            <EditableField label="Right-to-work status" value={record.rightToWorkStatus} editable onSave={fieldPatch('rightToWorkStatus')} editing={editingField === 'rightToWorkStatus'} onEditStart={() => setEditingField('rightToWorkStatus')} onEditEnd={() => setEditingField(null)} />
                            <EditableField label="Document type" value={record.documentType} editable onSave={fieldPatch('documentType')} editing={editingField === 'documentType'} onEditStart={() => setEditingField('documentType')} onEditEnd={() => setEditingField(null)} />
                            <EditableField
                              label="Expiry date"
                              value={record.expiryDate}
                              type="date"
                              editable
                              onSave={fieldPatch('expiryDate')}
                              format={(v) => isoToDisplay(v as string)}
                              editing={editingField === 'expiryDate'}
                              onEditStart={() => setEditingField('expiryDate')}
                              onEditEnd={() => setEditingField(null)}
                            />
                          </DetailGroup>

                          <DetailGroup title="Additional">
                            <EditableField
                              label="Languages"
                              value={record.languages}
                              type="tags"
                              editable
                              onSave={fieldPatch('languages')}
                              editing={editingField === 'languages'}
                              onEditStart={() => setEditingField('languages')}
                              onEditEnd={() => setEditingField(null)}
                            />
                            <EditableField
                              label="Notes / relevant work information"
                              value={record.notes}
                              type="textarea"
                              wrap
                              editable
                              onSave={fieldPatch('notes')}
                              editing={editingField === 'notes'}
                              onEditStart={() => setEditingField('notes')}
                              onEditEnd={() => setEditingField(null)}
                            />
                          </DetailGroup>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {error && <p className="error" style={{ margin: '10px 4px 0' }}>{error}</p>}
              </div>
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
                  <button type="button" className="btn-icon" aria-label="Send email" onClick={() => { setError(''); setEmailResult(null); setEmailComposerOpen(true); }}>
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
                    {emailResult && (
                      <p style={{ fontSize: 12, color: emailResult.queued > 0 ? 'var(--color-green)' : 'var(--color-red)', margin: '8px 0 0' }}>
                        {emailResult.queued > 0 ? 'Email queued for delivery.' : 'Could not send — this user may be outside your scope.'}
                      </p>
                    )}
                    {error && <p className="error" style={{ margin: '8px 0 0' }}>{error}</p>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button type="button" className="btn btn-outline" onClick={() => setEmailComposerOpen(false)}>Cancel</button>
                      <button
                        type="button"
                        className="btn btn-dark"
                        disabled={!emailSubject.trim() || !emailMessage.trim() || sendEmail.isPending}
                        onClick={() => {
                          setError('');
                          setEmailResult(null);
                          sendEmail.mutate(undefined, { onSuccess: () => { setEmailSubject(''); setEmailMessage(''); setEmailComposerOpen(false); } });
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
          </div>

          {tab === 'home' && (
            <div className="detail-bottom-bar">
              <div className="detail-more-menu" ref={menuRef}>
                <button type="button" className="btn-icon" title="More actions" aria-label="More actions" onClick={() => setMenuOpen((o) => !o)}>
                  <IconDotsVertical size={16} />
                </button>
                {menuOpen && (
                  <div className="detail-more-menu-dropdown detail-more-menu-dropdown-up">
                    {isInviteFamily ? (
                      <>
                        {(isPending || isExpired) && !atMaxAttempts && (
                          <button type="button" onClick={() => { setMenuOpen(false); setResendDone(false); resendInvite.mutate(); }} disabled={resendInvite.isPending}>
                            <IconSend size={14} />
                            <span style={{ flex: 1, textAlign: 'left' }}>{isExpired ? 'Re-invite' : 'Resend invitation'}</span>
                            <span className="cell-muted">{sendNumber} of 3</span>
                          </button>
                        )}
                        {isCancelled && !atMaxAttempts && (
                          <button type="button" onClick={() => { setMenuOpen(false); setResendDone(false); resendInvite.mutate(); }} disabled={resendInvite.isPending}>
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
                        <button type="button" onClick={() => { setMenuOpen(false); setResetDone(false); setResetConfirm(true); }}>
                          <IconKey size={14} />
                          Reset password
                        </button>
                        <button type="button" onClick={() => { setMenuOpen(false); setActive.mutate(!isActive); }}>
                          {isActive ? <IconUserOff size={14} /> : <IconUserCheck size={14} />}
                          {isActive ? (userType === 'staff' ? 'Deactivate' : 'Suspend') : 'Reactivate'}
                        </button>
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
              <button type="button" className="btn btn-outline" style={{ gap: 6 }} onClick={() => { setTab('email'); setEmailComposerOpen(true); }}>
                <IconMail size={14} />
                Send Email
              </button>
            </div>
          )}

          {resendDone && tab === 'home' && <p style={{ fontSize: 12, color: 'var(--color-green)', margin: '0 4px 8px' }}>Invitation queued.</p>}
          {resetDone && tab === 'home' && <p style={{ fontSize: 12, color: 'var(--color-green)', margin: '0 4px 8px' }}>A new setup link has been sent.</p>}

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
                <label>Type DELETE to confirm</label>
                <input value={deleteConfirmText} onChange={(e) => setDeleteConfirmText(e.target.value)} placeholder="DELETE" autoFocus />
              </div>
              <div className="modal-actions" style={{ marginTop: 8, borderTop: 'none', paddingTop: 0 }}>
                <button type="button" className="btn btn-outline" onClick={() => { setDeleteConfirm(false); setDeleteConfirmText(''); }}>Cancel</button>
                <button type="button" className="btn btn-danger" disabled={deleteConfirmText !== 'DELETE' || deleteUser.isPending} onClick={() => deleteUser.mutate()}>
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
