import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconSend, IconBan, IconUserExclamation } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import { FormSkeleton } from '../../../shared/components/LoadingState';
import InitialManagerFormFields, { type InitialManagerFormValues } from '../InitialManagerFormFields';
import { getStaffDisplayStatus, type InvitationStatus, type PendingInvite } from '../../users/staffStatus';
import { getApiErrorCode, getApiErrorMessage } from '../../../shared/lib/apiError';
import { toast } from '../../../shared/lib/toast';

interface InitialManagerSummary {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  accountStatus: string;
  invitationStatus: InvitationStatus;
  pendingInvite: PendingInvite | null;
}

/**
 * The existing Initial Manager lifecycle, reused inline by Members Add. Always the caller's OWN
 * organisation (organisation isolation, 2026-10-15): the server derives it from the session, and this
 * page never sends, chooses or accepts an organisation id. All reads and writes remain server-checked.
 *
 * "An organisation may only ever receive ONE Initial Manager invitation" (P2.9C's own rule) — so
 * once `GET /managers?type=internal&isInitialManager=true` returns a row, this page shows that
 * Manager's status with resend/revoke, never a form to invite someone else.
 *
 * P2.9 gap review, item 2 (owner-approved) — once resend is genuinely exhausted (never a shortcut
 * around a still-usable resend), "Replace Invitation" calls the new, non-destructive replace
 * endpoint: the old never-activated record is marked superseded, never deleted, and a fresh
 * invitation is created for a different person. The backend is the sole authority on WHEN this is
 * actually allowed (exhausted attempts, plus either natural expiry or a 24h post-cancellation
 * cooldown this screen does not try to replicate) — a too-early attempt simply surfaces the
 * server's own honest `REPLACE_COOLDOWN_ACTIVE` message below, never a fabricated local check.
 */
export default function InitialManagerPage() {
  const qc = useQueryClient();
  const endpoint = '/managers/initial-manager-invite';
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['managers', 'initial-manager'] });
  };

  const existing = useQuery({
    queryKey: ['managers', 'initial-manager'],
    queryFn: async () => (await api.get<{ data: InitialManagerSummary[]; total: number }>('/managers', { params: { type: 'internal', isInitialManager: true } })).data,
  });
  const manager = existing.data?.data?.[0];

  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ email: string } | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [showReplaceForm, setShowReplaceForm] = useState(false);

  const invite = useMutation({
    mutationFn: (values: InitialManagerFormValues) => api.post(endpoint, values),
    onSuccess: (_res, values) => {
      setCreated({ email: values.email.trim() });
      setError('');
      invalidate();
    },
    onError: (e: unknown) => setError(getApiErrorMessage(e, 'Could not send this invitation.')),
  });

  const resend = useMutation({
    mutationFn: () => api.post(`${endpoint}/resend`),
    onSuccess: () => { invalidate(); setError(''); toast.success('Invitation queued for delivery.'); },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Failed to resend the invitation.')),
  });

  const revoke = useMutation({
    mutationFn: () => api.post(`${endpoint}/revoke`),
    onSuccess: () => { invalidate(); setRevokeConfirm(false); setError(''); toast.success('Invitation revoked.'); },
    onError: (e: unknown) => {
      toast.error(getApiErrorMessage(e, 'Failed to revoke the invitation.'));
      setRevokeConfirm(false);
    },
  });

  const replace = useMutation({
    mutationFn: (values: InitialManagerFormValues) => api.post(`${endpoint}/replace`, { expectedProfileId: manager!.id, ...values }),
    onSuccess: (_res, values) => {
      setShowReplaceForm(false);
      setCreated({ email: values.email.trim() });
      setError('');
      invalidate();
    },
    onError: (e: unknown) => {
      const code = getApiErrorCode(e);
      const REPLACE_ERROR_COPY: Record<string, string> = {
        STALE_INITIAL_MANAGER: 'This invitation has already moved on — reload the page for the current status.',
        ALREADY_ACTIVATED: 'This account has already been activated and can no longer be replaced.',
        RESEND_STILL_AVAILABLE: 'This invitation can still be resent — use Resend above instead.',
        REPLACE_COOLDOWN_ACTIVE: 'This invitation was recently cancelled. Replacement becomes available 24 hours after cancellation, or once it naturally expires.',
        WORKSPACE_ALREADY_PROVISIONED: 'This workspace has already been fully provisioned and cannot be replaced from here — this needs platform support.',
      };
      setError(code && REPLACE_ERROR_COPY[code] ? REPLACE_ERROR_COPY[code] : getApiErrorMessage(e, 'Could not replace this invitation.'));
    },
  });

  if (existing.isLoading) return <FormSkeleton sections={1} />;
  if (existing.isError || !Array.isArray(existing.data?.data)) {
    return <p role="alert" className="member-error feedback-error">Initial Manager details could not be loaded. <button className="btn btn-outline" onClick={() => void existing.refetch()}>Retry</button></p>;
  }

  if (manager) {
    const displayStatus = getStaffDisplayStatus({
      userType: 'manager',
      accountStatus: manager.accountStatus,
      invitationStatus: manager.invitationStatus,
      pendingInvite: manager.pendingInvite,
    });
    const isPending = manager.invitationStatus === 'pending' || manager.invitationStatus === 'queued' || manager.invitationStatus === 'sending' || manager.invitationStatus === 'delivery_failed';
    const isCancelled = manager.invitationStatus === 'cancelled';
    const isExpired = manager.invitationStatus === 'expired';
    const atMaxAttempts = (manager.pendingInvite?.sendNumber ?? 0) >= 3;
    const exhausted = !isPending && (isCancelled || isExpired) && atMaxAttempts;

    if (created) {
      return (
        <div className="settings-page" style={{ maxWidth: 560 }}>
          <div className="settings-section">
            <h3 style={{ marginBottom: 4 }}>Initial Manager</h3>
            <p role="status" style={{ fontSize: 13, color: 'var(--feedback-success)', margin: '0 0 10px' }}>Invitation created for {created.email}.</p>
            <p style={{ fontSize: 12, color: 'var(--font-tertiary)' }}>
              The invitation email has been queued for delivery — it has not necessarily been received yet.
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="settings-page" style={{ maxWidth: 560 }}>
        <div className="settings-section">
          <h3 style={{ marginBottom: 4 }}>Initial Manager</h3>
          <p style={{ marginBottom: 12 }}>An organisation may only have one Initial Manager invitation. Additional managers use the ordinary Add Manager flow.</p>

          <div className="settings-row"><span>Name</span><span style={{ color: 'var(--font-primary)' }}>{manager.firstName} {manager.lastName}</span></div>
          <div className="settings-row"><span>Email</span><span style={{ color: 'var(--font-primary)' }}>{manager.email}</span></div>
          <div className="settings-row"><span>Status</span><span className={`badge badge-${displayStatus.tone}`}>{displayStatus.label}</span></div>

          {!showReplaceForm && (isPending || isCancelled || isExpired) && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {!atMaxAttempts && (
                <button type="button" className="btn btn-outline" style={{ gap: 6 }} disabled={resend.isPending} onClick={() => resend.mutate()}>
                  <IconSend size={14} />
                  {isExpired || isCancelled ? 'Re-invite' : 'Resend invitation'}
                </button>
              )}
              {isPending && (
                <button type="button" className="btn btn-outline" style={{ gap: 6 }} onClick={() => setRevokeConfirm(true)}>
                  <IconBan size={14} />
                  Revoke invitation
                </button>
              )}
              {exhausted && (
                <button type="button" className="btn btn-outline" style={{ gap: 6 }} onClick={() => { setError(''); setShowReplaceForm(true); }}>
                  <IconUserExclamation size={14} />
                  Replace Invitation
                </button>
              )}
            </div>
          )}

          {/* While the replace form is open, `InitialManagerFormFields` below shows this SAME
              `error` string itself (passed as its own `error` prop) — showing it here too would
              render the identical message twice. */}
          {!showReplaceForm && error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}

          {revokeConfirm && (
            <div className="drawer-discard-confirm" style={{ marginTop: 12 }}>
              <p>Revoke this invitation? {manager.firstName} will no longer be able to activate this account with the link they were sent.</p>
              <div className="modal-actions" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
                <button type="button" className="btn btn-outline" onClick={() => setRevokeConfirm(false)}>Back</button>
                <button type="button" className="btn btn-dark" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
                  {revoke.isPending ? 'Revoking…' : 'Revoke invitation'}
                </button>
              </div>
            </div>
          )}

          {showReplaceForm && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-light)' }}>
              <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 4px' }}>Replace this invitation</p>
              <p style={{ fontSize: 12, color: 'var(--font-tertiary)', margin: '0 0 12px' }}>
                {manager.firstName} {manager.lastName} ({manager.email}) never activated and has used all 3 delivery attempts. Their record is kept
                for history — it is never deleted. The new recipient will choose their own workspace name and subdomain after activating.
              </p>
              <InitialManagerFormFields
                idPrefix="im-replace"
                onSubmit={(values) => { setError(''); replace.mutate(values); }}
                submitting={replace.isPending}
                submitLabel="Replace Invitation"
                error={error}
              />
              <button type="button" className="btn-link-muted" style={{ marginTop: 8 }} onClick={() => setShowReplaceForm(false)}>Cancel</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page" style={{ maxWidth: 560 }}>
      <div className="settings-section">
        <h3 style={{ marginBottom: 4 }}>Invite your Initial Manager</h3>
        <p style={{ marginBottom: 12 }}>
          They'll set up their own workspace name and subdomain after accepting the invitation.
        </p>

        {created ? (
          <div>
            <p style={{ fontSize: 13, color: 'var(--feedback-success)', margin: '0 0 10px' }}>Invitation created for {created.email}.</p>
            <p style={{ fontSize: 12, color: 'var(--font-tertiary)' }}>
              The invitation email has been queued for delivery — it has not necessarily been received yet. You can check its status and resend it below once it appears.
            </p>
          </div>
        ) : (
          <InitialManagerFormFields
            idPrefix="im"
            onSubmit={(values) => { setError(''); invite.mutate(values); }}
            submitting={invite.isPending}
            submitLabel="Send Invitation"
            error={error}
          />
        )}
      </div>
    </div>
  );
}
