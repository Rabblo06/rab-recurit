import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconRefresh, IconX } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { TableSkeleton } from '../../../shared/components/LoadingState';
import { getApiErrorMessage } from '../../../shared/lib/apiError';
import { toast } from '../../../shared/lib/toast';

/** A custom workspace-member role the caller may assign — loaded from the server, never hardcoded here. */
export interface AssignableRole { id: string; name: string; permissionKeys: string[] }
type InvitationStatus = 'queued' | 'sending' | 'sent' | 'delivery_failed' | 'accepted' | 'expired' | 'revoked' | 'superseded';
type Outcome = 'invited' | 'already_invited' | 'already_member' | 'invalid_email' | 'unavailable';

export interface MemberInvitation {
  id: string;
  email: string;
  role: { id: string; name: string };
  status: InvitationStatus;
  sendCount: number;
  maxSends: number;
  expiresAt: string;
  lastSentAt: string;
  createdAt: string;
  invitedByName: string | null;
}

interface SendResult { email: string; outcome: Outcome }

const STATUS: Record<InvitationStatus, { label: string; tone: 'active' | 'pending' | 'inactive' }> = {
  queued: { label: 'Queued', tone: 'pending' },
  sending: { label: 'Sending', tone: 'pending' },
  sent: { label: 'Sent', tone: 'active' },
  delivery_failed: { label: 'Delivery failed', tone: 'inactive' },
  accepted: { label: 'Accepted', tone: 'active' },
  expired: { label: 'Expired', tone: 'inactive' },
  revoked: { label: 'Revoked', tone: 'inactive' },
  superseded: { label: 'Superseded', tone: 'inactive' },
};
const OUTCOME: Record<Outcome, string> = {
  invited: 'Invitation queued',
  already_invited: 'Already has a pending invitation',
  already_member: 'Already has an account in this organisation',
  invalid_email: 'Not a valid email address',
  unavailable: 'Can’t be invited right now',
};
const PERMISSION_NOUN: Record<string, string> = { 'staff.view': 'staff', 'venue.view': 'venues', 'schedule.view': 'shifts' };

/** "Members can view staff, venues and shifts." — from the role's real permissions, shown under the fields. */
export function describeRole(role: AssignableRole | undefined): string {
  if (!role) return '';
  const nouns = role.permissionKeys.map((k) => PERMISSION_NOUN[k]).filter(Boolean) as string[];
  if (nouns.length === 0) return `${role.name} has no permissions yet.`;
  const list = nouns.length === 1 ? nouns[0] : `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}`;
  return `${role.name} members can view your ${list}.`;
}
const PAGE_SIZE = 10;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Splits on commas, semicolons, spaces and new lines; lower-cases and de-duplicates. The server re-validates every address. */
export function parseEmails(input: string): { emails: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const part of input.split(/[\s,;]+/)) {
    const value = part.trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    (EMAIL_PATTERN.test(value) && value.length <= 254 ? emails : invalid).push(value);
  }
  return { emails, invalid };
}

/** "in 23 hours", "in 40 minutes", "Expired" */
export function expiresIn(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'Expired';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} hour${hours === 1 ? '' : 's'}`;
}

function describeError(err: unknown): string {
  return getApiErrorMessage(err, 'We couldn’t complete this request. Please try again.');
}

/**
 * Settings → Members → Invite → Invite. Email-first, like Twenty: the workspace owner supplies only addresses and one
 * of their custom workspace roles; each invitee sets up their own name and password after accepting and joins this
 * workspace. Role options come from the server (`/member-invitations/assignable-roles`) — never Staff, Venue Manager,
 * Manager or leadership — and every action is re-authorised by the API.
 */
export default function InviteMembersPanel({ workspaceName, modeSelect, onCreateRole }: { workspaceName?: string; modeSelect?: ReactNode; onCreateRole?: () => void }) {
  const qc = useQueryClient();
  const [raw, setRaw] = useState('');
  const [roleId, setRoleId] = useState('');
  const [page, setPage] = useState(1);
  const statusFilter = '' as InvitationStatus | '';
  const [error, setError] = useState('');
  const [results, setResults] = useState<SendResult[] | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<MemberInvitation | null>(null);

  const roles = useQuery({
    queryKey: ['member-invitations', 'assignable-roles'],
    queryFn: async () => (await api.get<AssignableRole[]>('/member-invitations/assignable-roles')).data,
  });
  const selectedRole = roles.data?.find((r) => r.id === roleId) ?? roles.data?.[0];
  const invitations = useQuery({
    queryKey: ['member-invitations', 'list', page, statusFilter],
    queryFn: async () =>
      (await api.get<{ data: MemberInvitation[]; total: number; page: number; limit: number }>(`/member-invitations?page=${page}&limit=${PAGE_SIZE}${statusFilter ? `&status=${statusFilter}` : ''}`)).data,
    // A queued email turns into Sent or Delivery failed without the admin doing anything.
    refetchInterval: (query) => (query.state.data?.data.some((i) => i.status === 'queued' || i.status === 'sending') ? 5000 : false),
  });
  const parsed = useMemo(() => parseEmails(raw), [raw]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['member-invitations', 'list'] });

  const send = useMutation({
    mutationFn: async () => (await api.post<{ results: SendResult[] }>('/member-invitations', { emails: [...parsed.emails, ...parsed.invalid], roleId: selectedRole?.id })).data,
    onSuccess: (data) => {
      setResults(data.results);
      const invited = data.results.filter((r) => r.outcome === 'invited').length;
      const failed = data.results.length - invited;
      // The per-recipient list below stays on screen; the summary is a toast (amber when only some were sent).
      const summary = `${invited} invitation${invited === 1 ? '' : 's'} queued for delivery.${failed ? ` ${failed} could not be sent — see below.` : ''}`;
      if (invited && failed) toast.warning(summary);
      else if (invited) toast.success(summary);
      else setError('No invitations were sent — see the details below.');
      setRaw(data.results.filter((r) => r.outcome !== 'invited').map((r) => r.email).join(', '));
      refresh();
    },
    onError: (err) => setError(describeError(err)),
  });
  const action = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'resend' | 'revoke' }) => api.post(`/member-invitations/${id}/${kind}`, {}),
    onSuccess: (_d, { kind }) => {
      setRevokeTarget(null);
      toast.success(kind === 'resend' ? 'A new invitation link is queued for delivery. The previous link no longer works.' : 'Invitation revoked. The link no longer works.');
      refresh();
    },
    onError: (err) => { setRevokeTarget(null); toast.error(describeError(err)); },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResults(null);
    if (!parsed.emails.length && !parsed.invalid.length) { setError('Enter at least one email address.'); return; }
    if (parsed.emails.length + parsed.invalid.length > 20) { setError('Invite up to 20 people at a time.'); return; }
    if (!selectedRole) { setError('Choose a workspace role.'); return; }
    send.mutate();
  };

  const totalPages = Math.max(1, Math.ceil((invitations.data?.total ?? 0) / PAGE_SIZE));
  const noRoles = roles.isSuccess && roles.data.length === 0;

  return <>
    <section className="member-invite-card invite-by-email" aria-labelledby="invite-heading">
      <div className="member-section-heading"><h3 id="invite-heading">Invite your team</h3><p>Send an invitation to join {workspaceName || 'your workspace'}.</p></div>
      {error && <p role="alert" className="member-error feedback-error">{error}</p>}
      {roles.isError ? (
        <p role="alert" className="member-error feedback-error">Workspace roles could not be loaded. <button type="button" className="btn btn-outline" onClick={() => roles.refetch()}>Retry</button></p>
      ) : noRoles ? (
        <div className="invite-no-roles">
          {modeSelect}
          <p className="members-scope-note">Create a workspace role first — it decides what the people you invite can see. Recruitment Staff and Venue Managers are added from Users, not here.</p>
          {onCreateRole && <button type="button" className="btn btn-dark" onClick={onCreateRole}>Create a role</button>}
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <div className="invite-row">
            <div className="invite-field">
            <label htmlFor="member-emails">Email address</label>
            <div className={`invite-email-group${modeSelect ? ' has-mode' : ''}`}>
              {modeSelect}
              <input
                id="member-emails"
                type="text"
                inputMode="email"
                autoComplete="off"
                placeholder="name@company.com"
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                aria-describedby="member-emails-help"
                aria-invalid={parsed.invalid.length > 0}
                disabled={send.isPending}
              />
            </div>
            </div>
            <div className="invite-field">
            <label htmlFor="member-role">Workspace role</label>
            <select id="member-role" className="invite-role-select" value={selectedRole?.id ?? ''} onChange={(e) => setRoleId(e.target.value)} disabled={send.isPending || !roles.data?.length}>
              {roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            </div>
          </div>
          <p id="member-emails-help" className="invite-help">
            {selectedRole ? `${describeRole(selectedRole)} ` : ''}Separate several addresses with commas. Each link works for 24 hours.
          </p>
          {parsed.invalid.length > 0 && <p className="invite-invalid feedback-error" role="status">Check {parsed.invalid.length === 1 ? 'this address' : 'these addresses'}: {parsed.invalid.join(', ')}</p>}
          <button className="btn btn-dark invite-submit" disabled={send.isPending || !roles.data?.length}>{send.isPending ? 'Sending…' : 'Send invitation'}</button>
        </form>
      )}
      {results && results.some((r) => r.outcome !== 'invited') && (
        <ul className="invite-results" aria-label="Invitation results">
          {results.map((r) => <li key={r.email} className={r.outcome === 'invited' ? 'ok feedback-success' : 'failed feedback-error'}><span>{r.email}</span><span>{OUTCOME[r.outcome]}</span></li>)}
        </ul>
      )}
    </section>

    <section className="pending-invitations" aria-labelledby="pending-heading">
      <h3 id="pending-heading">Pending invitations</h3>
      {invitations.isLoading ? <TableSkeleton columns={4} /> : invitations.isError ? (
        <p role="alert" className="member-error feedback-error">Invitations could not be loaded. <button className="btn btn-outline" onClick={() => invitations.refetch()}>Retry</button></p>
      ) : !invitations.data?.data.length ? (
        <p className="pending-empty">No invitations pending. Your next teammate is one invite away.</p>
      ) : (
        <div className="members-table-wrap">
          <table className="table invitations-table">
            <thead><tr><th>Email</th><th>Role</th><th>Expires in</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              {invitations.data.data.map((inv) => {
                const status = STATUS[inv.status];
                const canResend = inv.sendCount < inv.maxSends;
                const failed = inv.status === 'delivery_failed';
                return <tr key={inv.id}>
                  <td>{inv.email}</td>
                  <td>{inv.role.name}</td>
                  <td className={failed ? 'feedback-error' : 'cell-muted'}>
                    {failed ? status.label : <>• {expiresIn(inv.expiresAt)}</>}
                    {!failed && inv.status !== 'sent' && <span className="invite-status-note"> · {status.label}</span>}
                  </td>
                  <td className="invitation-actions">
                    <button
                      type="button"
                      className="btn-icon"
                      aria-label={`Resend invitation to ${inv.email}`}
                      disabled={action.isPending || !canResend}
                      title={canResend ? `Send again (${inv.sendCount} of ${inv.maxSends} sent)` : 'All three sends used — revoke and invite again'}
                      onClick={() => action.mutate({ id: inv.id, kind: 'resend' })}
                    ><IconRefresh size={14} /></button>
                    <button type="button" className="btn-icon" aria-label={`Revoke invitation to ${inv.email}`} disabled={action.isPending} onClick={() => setRevokeTarget(inv)}><IconX size={14} /></button>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && (
        <div className="invitations-pager">
          <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span className="cell-muted">Page {page} of {totalPages}</span>
          <button className="btn btn-outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </section>

    <ConfirmDialog
      open={!!revokeTarget}
      title="Revoke this invitation?"
      description={revokeTarget ? `The link sent to ${revokeTarget.email} will stop working immediately.` : ''}
      confirmLabel="Revoke invitation"
      destructive
      loading={action.isPending}
      onConfirm={() => { if (revokeTarget) action.mutate({ id: revokeTarget.id, kind: 'revoke' }); }}
      onCancel={() => setRevokeTarget(null)}
    />
  </>;
}
