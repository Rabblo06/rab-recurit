import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconSend, IconBan, IconUserExclamation } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import Drawer from '../../../shared/components/Drawer';
import { DetailSkeleton } from '../../../shared/components/LoadingState';
import InitialManagerFormFields, { type InitialManagerFormValues } from '../InitialManagerFormFields';
import { getStaffDisplayStatus, type InvitationStatus, type PendingInvite } from '../../users/staffStatus';

interface ManagerDetail {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  accountStatus: string;
  invitationStatus: InvitationStatus;
  pendingInvite: PendingInvite | null;
}

interface OrganisationDetail {
  id: string;
  name: string;
  slug: string;
  suspended: boolean;
  createdAt: string;
  ceo: ManagerDetail | null;
  /** P2.9 gap review, item 1 (owner-approved) — additive field on the existing response. */
  initialManager: ManagerDetail | null;
}

const REPLACE_ERROR_COPY: Record<string, string> = {
  STALE_INITIAL_MANAGER: 'This invitation has already moved on — reload for the current status.',
  ALREADY_ACTIVATED: 'This account has already been activated and can no longer be replaced.',
  RESEND_STILL_AVAILABLE: 'This invitation can still be resent — use Resend instead.',
  REPLACE_COOLDOWN_ACTIVE: 'This invitation was recently cancelled. Replacement becomes available 24 hours after cancellation, or once it naturally expires.',
  WORKSPACE_ALREADY_PROVISIONED: 'This workspace has already been fully provisioned and cannot be replaced from here.',
  REPLACE_LIMIT_REACHED: 'This organisation has reached its Initial Manager replacement limit via the CEO route — the Super Admin route (this one) is uncapped.',
};

/** One invite's status + resend/revoke, parametrised over which invite (`ceo` or `initial-manager`) it targets — the two sections render independently but share this exact logic and markup. */
function useInviteActions(organisationId: string | null, kind: 'ceo' | 'initial-manager', invalidate: () => void) {
  const [error, setError] = useState('');
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [resendDone, setResendDone] = useState(false);

  const resend = useMutation({
    mutationFn: () => api.post(`/admin/organisations/${organisationId}/${kind}-invite/resend`),
    onSuccess: () => { invalidate(); setResendDone(true); setError(''); },
    onError: (e: any) => {
      const message = e?.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'Failed to resend the invitation.');
    },
  });

  const revoke = useMutation({
    mutationFn: () => api.post(`/admin/organisations/${organisationId}/${kind}-invite/revoke`),
    onSuccess: () => { invalidate(); setRevokeConfirm(false); setError(''); },
    onError: (e: any) => {
      const message = e?.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'Failed to revoke the invitation.');
      setRevokeConfirm(false);
    },
  });

  function reset() {
    setError('');
    setRevokeConfirm(false);
    setResendDone(false);
  }

  return { error, setError, revokeConfirm, setRevokeConfirm, resendDone, setResendDone, resend, revoke, reset };
}

/** P2.9 gap review, item 2 (owner-approved) — Initial-Manager-only; CEO replacement was never approved/built. Uncapped on this Super-Admin route (see `OrganisationOnboardingService.replaceInitialManager`'s own doc comment). */
function useReplaceInitialManager(organisationId: string | null, invalidate: () => void) {
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [replacedWith, setReplacedWith] = useState<string | null>(null);

  const replace = useMutation({
    mutationFn: (values: InitialManagerFormValues & { expectedProfileId: string }) =>
      api.post(`/admin/organisations/${organisationId}/initial-manager-invite/replace`, values),
    onSuccess: (_res, values) => {
      setShowForm(false);
      setReplacedWith(values.email.trim());
      setError('');
      invalidate();
    },
    onError: (e: any) => {
      const code = e?.response?.data?.code;
      setError((code && REPLACE_ERROR_COPY[code]) ?? e?.response?.data?.message ?? 'Could not replace this invitation.');
    },
  });

  function reset() {
    setShowForm(false);
    setError('');
    setReplacedWith(null);
  }

  return { showForm, setShowForm, error, setError, replace, replacedWith, reset };
}

function InviteSection({
  title,
  manager,
  noRecordLabel,
  actions,
  replaceAction,
}: {
  title: string;
  manager: ManagerDetail | null;
  noRecordLabel: string;
  actions: ReturnType<typeof useInviteActions>;
  /** Only ever passed for the Initial Manager section — CEO replacement was never approved. */
  replaceAction?: ReturnType<typeof useReplaceInitialManager>;
}) {
  const displayStatus = manager
    ? getStaffDisplayStatus({ userType: 'manager', accountStatus: manager.accountStatus, invitationStatus: manager.invitationStatus, pendingInvite: manager.pendingInvite })
    : null;
  const invitationStatus = manager?.invitationStatus ?? null;
  const isPending = invitationStatus === 'pending' || invitationStatus === 'queued' || invitationStatus === 'sending' || invitationStatus === 'delivery_failed';
  const isCancelled = invitationStatus === 'cancelled';
  const isExpired = invitationStatus === 'expired';
  const atMaxAttempts = (manager?.pendingInvite?.sendNumber ?? 0) >= 3;
  const exhausted = !isPending && (isCancelled || isExpired) && atMaxAttempts;

  if (replaceAction?.replacedWith) {
    return (
      <div className="detail-group">
        <div className="detail-group-title">{title}</div>
        <p style={{ fontSize: 13, color: 'var(--color-green)', margin: '0 4px 4px' }}>Replacement invitation created for {replaceAction.replacedWith}.</p>
        <p className="cell-muted" style={{ margin: '0 4px' }}>The previous, never-activated invitation has been superseded, never deleted.</p>
      </div>
    );
  }

  return (
    <div className="detail-group">
      <div className="detail-group-title">{title}</div>
      {manager ? (
        <>
          <div className="detail-info-row"><span className="detail-info-label">Name</span><span className="detail-info-value">{manager.firstName} {manager.lastName}</span></div>
          <div className="detail-info-row"><span className="detail-info-label">Email</span><span className="detail-info-value">{manager.email}</span></div>
          <div className="detail-info-row">
            <span className="detail-info-label">Status</span>
            <span className="detail-info-value">
              {displayStatus && <span className={`badge badge-${displayStatus.tone}`}>{displayStatus.label}</span>}
            </span>
          </div>

          {!replaceAction?.showForm && (isPending || isCancelled || isExpired) && (
            <div style={{ display: 'flex', gap: 8, margin: '4px 4px 8px' }}>
              {!atMaxAttempts && (
                <button type="button" className="btn btn-outline" style={{ gap: 6 }} disabled={actions.resend.isPending} onClick={() => { actions.setResendDone(false); actions.resend.mutate(); }}>
                  <IconSend size={14} />
                  {isExpired || isCancelled ? 'Re-invite' : 'Resend invitation'}
                </button>
              )}
              {isPending && (
                <button type="button" className="btn btn-outline" style={{ gap: 6 }} onClick={() => actions.setRevokeConfirm(true)}>
                  <IconBan size={14} />
                  Revoke invitation
                </button>
              )}
              {exhausted && replaceAction && (
                <button type="button" className="btn btn-outline" style={{ gap: 6 }} onClick={() => { replaceAction.setError(''); replaceAction.setShowForm(true); }}>
                  <IconUserExclamation size={14} />
                  Replace Invitation
                </button>
              )}
            </div>
          )}

          {exhausted && !replaceAction && (
            <p style={{ fontSize: 12, color: 'var(--color-red)', margin: '0 4px 8px' }}>
              This invitation has used all 3 delivery attempts and cannot be resent, and this account cannot currently be
              replaced from here — this needs platform support.
            </p>
          )}

          {actions.resendDone && <p style={{ fontSize: 12, color: 'var(--color-green)', margin: '0 4px 8px' }}>Invitation queued for delivery.</p>}
          {actions.error && <p className="error" style={{ margin: '0 4px 8px' }}>{actions.error}</p>}

          {actions.revokeConfirm && (
            <div className="drawer-discard-confirm">
              <p>Revoke this invitation? {manager.firstName} will no longer be able to activate this account with the link they were sent.</p>
              <div className="modal-actions" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
                <button type="button" className="btn btn-outline" onClick={() => actions.setRevokeConfirm(false)}>Back</button>
                <button type="button" className="btn btn-dark" disabled={actions.revoke.isPending} onClick={() => actions.revoke.mutate()}>
                  {actions.revoke.isPending ? 'Revoking…' : 'Revoke invitation'}
                </button>
              </div>
            </div>
          )}

          {replaceAction?.showForm && (
            <div style={{ marginTop: 8, paddingTop: 12, borderTop: '1px solid var(--border-light)' }}>
              <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 4px' }}>Replace this invitation</p>
              <p className="cell-muted" style={{ margin: '0 0 12px' }}>
                {manager.firstName} {manager.lastName} never activated and has used all 3 delivery attempts. Their record is
                kept for history — it is never deleted. The new recipient will choose their own workspace name and subdomain after activating.
              </p>
              <InitialManagerFormFields
                idPrefix="admin-replace"
                onSubmit={(values) => { replaceAction.setError(''); replaceAction.replace.mutate({ ...values, expectedProfileId: manager.id }); }}
                submitting={replaceAction.replace.isPending}
                submitLabel="Replace Invitation"
                error={replaceAction.error}
              />
              <button type="button" className="btn-link-muted" style={{ marginTop: 8 }} onClick={() => replaceAction.setShowForm(false)}>Cancel</button>
            </div>
          )}
        </>
      ) : (
        <p className="cell-muted">{noRecordLabel}</p>
      )}
    </div>
  );
}

/** Shown only when `organisation.initialManager === null` — same shared fields/contract as `InitialManagerPage.tsx`'s CEO-facing form, reused here for the Super-Admin side of the same write endpoint. */
function InviteInitialManagerForm({ organisationId, onCreated }: { organisationId: string; onCreated: () => void }) {
  const [error, setError] = useState('');
  const invite = useMutation({
    mutationFn: (values: InitialManagerFormValues) => api.post(`/admin/organisations/${organisationId}/initial-manager-invite`, values),
    onSuccess: () => { setError(''); onCreated(); },
    onError: (e: any) => {
      const message = e?.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'Could not send this invitation.');
    },
  });

  return (
    <div className="detail-group">
      <div className="detail-group-title">Initial Manager</div>
      <p className="cell-muted" style={{ margin: '0 4px 10px' }}>No Initial Manager yet. They'll set up their own workspace name and subdomain after accepting the invitation.</p>
      <InitialManagerFormFields
        idPrefix="admin-im"
        onSubmit={(values) => { setError(''); invite.mutate(values); }}
        submitting={invite.isPending}
        submitLabel="Send Invitation"
        error={error}
      />
    </div>
  );
}

/** Super-Admin-only (`PlatformAdminGuard`, re-checked service-side). Shows exactly what `GET /admin/organisations/:id` (`OrganisationOnboardingService.getOrganisation`) returns — organisation, CEO, and (P2.9 gap review, item 1) the Initial Manager, resolved through the same cross-organisation read path the CEO lookup already used. */
export default function OrganisationDetailDrawer({
  open,
  onClose,
  organisationId,
}: {
  open: boolean;
  onClose: () => void;
  organisationId: string | null;
}) {
  const qc = useQueryClient();

  const { data: org, isLoading } = useQuery({
    queryKey: ['admin', 'organisations', organisationId],
    queryFn: async () => (await api.get<OrganisationDetail>(`/admin/organisations/${organisationId}`)).data,
    enabled: open && Boolean(organisationId),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'organisations'] });
    qc.invalidateQueries({ queryKey: ['admin', 'organisations', organisationId] });
  };

  const ceoActions = useInviteActions(organisationId, 'ceo', invalidate);
  const initialManagerActions = useInviteActions(organisationId, 'initial-manager', invalidate);
  const replaceInitialManager = useReplaceInitialManager(organisationId, invalidate);

  function close() {
    ceoActions.reset();
    initialManagerActions.reset();
    replaceInitialManager.reset();
    onClose();
  }

  return (
    <Drawer
      open={open}
      onClose={close}
      title={org?.name ?? 'Organisation'}
      description={org ? `Organisation • ${org.slug}` : undefined}
      icon={org && <span className={`badge badge-${org.suspended ? 'inactive' : 'active'}`}>{org.suspended ? 'Suspended' : 'Active'}</span>}
      loading={isLoading}
      compactHeader
    >
      {!org ? (
        <DetailSkeleton />
      ) : (
        <div className="detail-panel-shell">
          <div className="detail-panel-body">
            <div className="detail-group">
              <div className="detail-group-title">Organisation</div>
              <div className="detail-info-row"><span className="detail-info-label">Name</span><span className="detail-info-value">{org.name}</span></div>
              <div className="detail-info-row"><span className="detail-info-label">Slug</span><span className="detail-info-value">{org.slug}</span></div>
              <div className="detail-info-row"><span className="detail-info-label">Created</span><span className="detail-info-value">{new Date(org.createdAt).toLocaleDateString()}</span></div>
            </div>

            <InviteSection title="CEO" manager={org.ceo} noRecordLabel="No CEO record found for this organisation." actions={ceoActions} />

            {org.initialManager || replaceInitialManager.replacedWith ? (
              <InviteSection
                title="Initial Manager"
                manager={org.initialManager}
                noRecordLabel="No Initial Manager yet."
                actions={initialManagerActions}
                replaceAction={replaceInitialManager}
              />
            ) : (
              <InviteInitialManagerForm organisationId={org.id} onCreated={invalidate} />
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
