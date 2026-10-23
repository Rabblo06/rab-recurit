import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconRefresh, IconX } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { TableSkeleton } from '../../../shared/components/LoadingState';
import { getApiErrorMessage } from '../../../shared/lib/apiError';
import { toast } from '../../../shared/lib/toast';
import { expiresIn, parseEmails } from './InviteMembersPanel';

export interface CeoInvitation {
  id: string;
  email: string;
  status: 'pending' | 'expired' | 'accepted' | 'revoked';
  sendCount: number;
  maxSends: number;
  expiresAt: string;
  lastSentAt: string | null;
  createdAt: string | null;
  acceptedOrganisationId: string | null;
}

type SendOutcome = 'invited' | 'already_invited';
const PAGE_SIZE = 10;

/**
 * Settings → Members → Add, CEO (Organisation) — owner correction 2026-10-23. A platform administrator enters ONLY the
 * CEO's email; the CEO names their organisation and sets up their own account from the email link (`/accept-invitation`),
 * and the organisation exists only after that. Same form, list and confirmation patterns as the member invitation form
 * (`InviteMembersPanel`). The server (`/admin/organisation-invitations`, platform administrators only) is authoritative.
 */
export default function CeoInvitationPanel({ roleControl }: { roleControl?: ReactNode }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [revokeTarget, setRevokeTarget] = useState<CeoInvitation | null>(null);

  const invitations = useQuery({
    queryKey: ['organisation-invitations', page],
    queryFn: async () => (await api.get<{ data: CeoInvitation[]; total: number }>(`/admin/organisation-invitations?page=${page}&limit=${PAGE_SIZE}`)).data,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['organisation-invitations'] });

  const send = useMutation({
    mutationFn: async (address: string) => (await api.post<{ email: string; outcome: SendOutcome }>('/admin/organisation-invitations', { email: address })).data,
    onSuccess: (data) => {
      if (data.outcome === 'invited') {
        toast.success(`Invitation sent to ${data.email}. They’ll set up their account and organisation from the email.`);
        setEmail('');
      } else {
        toast.info(`${data.email} already has a pending invitation. Resend it from the list below.`);
      }
      refresh();
    },
    onError: (err) => setError(getApiErrorMessage(err, 'We couldn’t send this invitation. Please try again.')),
  });
  const action = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'resend' | 'revoke' }) => api.post(`/admin/organisation-invitations/${id}/${kind}`, {}),
    onSuccess: (_d, { kind }) => {
      setRevokeTarget(null);
      toast.success(kind === 'resend' ? 'A new invitation link is queued for delivery. The previous link no longer works.' : 'Invitation revoked. The link no longer works.');
      refresh();
    },
    onError: (err) => {
      setRevokeTarget(null);
      toast.error(getApiErrorMessage(err, 'We couldn’t complete this request. Please try again.'));
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const parsed = parseEmails(email);
    if (parsed.emails.length + parsed.invalid.length !== 1) { setError('Enter the CEO’s email address.'); return; }
    if (parsed.invalid.length) { setError('Enter a valid email address.'); return; }
    send.mutate(parsed.emails[0]!);
  };

  const rows = (invitations.data?.data ?? []).filter((i) => i.status === 'pending' || i.status === 'expired');
  const totalPages = Math.max(1, Math.ceil((invitations.data?.total ?? 0) / PAGE_SIZE));

  return <>
    <section className="member-invite-card invite-by-email" aria-labelledby="add-organisation-heading">
      <div className="member-section-heading">
        <h3 id="add-organisation-heading">Add organisation</h3>
        <p>Invite an organisation's CEO to complete their account and workspace setup.</p>
      </div>
      {error && <p role="alert" className="member-error feedback-error">{error}</p>}
      <form onSubmit={submit} noValidate>
        <div className="invite-row">
          {roleControl}
          <div className="invite-field">
            <label htmlFor="ceo-email">CEO email</label>
            <input
              id="ceo-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              placeholder="ceo@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={send.isPending}
            />
          </div>
        </div>
        <p className="invite-help">The CEO enters their own name and organisation name. The link works for 24 hours.</p>
        <button className="btn btn-dark invite-submit" disabled={send.isPending}>{send.isPending ? 'Sending…' : 'Send invitation'}</button>
      </form>
    </section>

    <section className="pending-invitations" aria-labelledby="pending-organisations-heading">
      <h3 id="pending-organisations-heading">Pending organisation invitations</h3>
      {invitations.isLoading ? <TableSkeleton columns={3} /> : invitations.isError ? (
        <p role="alert" className="member-error feedback-error">Invitations could not be loaded. <button className="btn btn-outline" onClick={() => invitations.refetch()}>Retry</button></p>
      ) : !rows.length ? (
        <p className="pending-empty">No organisation invitations pending.</p>
      ) : (
        <div className="members-table-wrap">
          <table className="table invitations-table">
            <thead><tr><th>CEO email</th><th>Expires in</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              {rows.map((inv) => {
                const canResend = inv.sendCount < inv.maxSends;
                return <tr key={inv.id}>
                  <td>{inv.email}</td>
                  <td className={inv.status === 'expired' ? 'feedback-error' : 'cell-muted'}>{inv.status === 'expired' ? 'Expired' : <>• {expiresIn(inv.expiresAt)}</>}</td>
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
