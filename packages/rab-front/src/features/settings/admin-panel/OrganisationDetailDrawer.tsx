import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconSend, IconBan } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import Drawer from '../../../shared/components/Drawer';
import { DetailSkeleton } from '../../../shared/components/LoadingState';
import { getStaffDisplayStatus, type InvitationStatus, type PendingInvite } from '../../users/staffStatus';
import { getApiErrorMessage } from '../../../shared/lib/apiError';
import { toast } from '../../../shared/lib/toast';
import ResetTwoFactorDialog from './ResetTwoFactorDialog';
import OrganisationSettingsSection from './OrganisationSettingsSection';

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
}

/** The CEO invite's status + resend/revoke — platform-level organisation onboarding (unchanged). */
function useCeoInviteActions(organisationId: string | null, invalidate: () => void) {
  const [revokeConfirm, setRevokeConfirm] = useState(false);

  const resend = useMutation({
    mutationFn: () => api.post(`/admin/organisations/${organisationId}/ceo-invite/resend`),
    onSuccess: () => { invalidate(); toast.success('Invitation queued for delivery.'); },
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Failed to resend the invitation.')),
  });

  const revoke = useMutation({
    mutationFn: () => api.post(`/admin/organisations/${organisationId}/ceo-invite/revoke`),
    onSuccess: () => { invalidate(); setRevokeConfirm(false); toast.success('Invitation revoked.'); },
    onError: (e: unknown) => {
      toast.error(getApiErrorMessage(e, 'Failed to revoke the invitation.'));
      setRevokeConfirm(false);
    },
  });

  function reset() {
    setRevokeConfirm(false);
  }

  return { revokeConfirm, setRevokeConfirm, resend, revoke, reset };
}

function CeoInviteSection({ manager, actions }: { manager: ManagerDetail | null; actions: ReturnType<typeof useCeoInviteActions> }) {
  const displayStatus = manager
    ? getStaffDisplayStatus({ userType: 'manager', accountStatus: manager.accountStatus, invitationStatus: manager.invitationStatus, pendingInvite: manager.pendingInvite })
    : null;
  const invitationStatus = manager?.invitationStatus ?? null;
  const isPending = invitationStatus === 'pending' || invitationStatus === 'queued' || invitationStatus === 'sending' || invitationStatus === 'delivery_failed';
  const isCancelled = invitationStatus === 'cancelled';
  const isExpired = invitationStatus === 'expired';
  const atMaxAttempts = (manager?.pendingInvite?.sendNumber ?? 0) >= 3;
  const exhausted = !isPending && (isCancelled || isExpired) && atMaxAttempts;

  return (
    <div className="detail-group">
      <div className="detail-group-title">CEO</div>
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

          {(isPending || isCancelled || isExpired) && (
            <div style={{ display: 'flex', gap: 8, margin: '4px 4px 8px' }}>
              {!atMaxAttempts && (
                <button type="button" className="btn btn-outline" style={{ gap: 6 }} disabled={actions.resend.isPending} onClick={() => actions.resend.mutate()}>
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
            </div>
          )}

          {exhausted && (
            <p style={{ fontSize: 12, color: 'var(--feedback-error)', margin: '0 4px 8px' }}>
              This invitation has used all 3 delivery attempts and cannot be resent — this needs platform support.
            </p>
          )}


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
        </>
      ) : (
        <p className="cell-muted">No CEO record found for this organisation.</p>
      )}
    </div>
  );
}

/**
 * Super-Admin-only (`PlatformAdminGuard`, re-checked service-side). Shows exactly what `GET /admin/organisations/:id`
 * (`OrganisationOnboardingService.getOrganisation`) returns — the organisation and its CEO invitation, the platform-level
 * onboarding a platform administrator owns.
 *
 * Organisation isolation (owner policy, 2026-10-15): this drawer no longer invites, resends, revokes or replaces another
 * organisation's Initial Manager — those platform routes were removed server-side. The Initial Manager is onboarded by that
 * organisation's own CEO (Settings → Members → Add); the API no longer returns another organisation's Initial Manager at all.
 */
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

  const ceoActions = useCeoInviteActions(organisationId, invalidate);
  const [resetCeo, setResetCeo] = useState(false);

  function close() {
    ceoActions.reset();
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

            <OrganisationSettingsSection organisationId={org.id} />

            <CeoInviteSection manager={org.ceo} actions={ceoActions} />

            {org.ceo && org.ceo.accountStatus === 'active' && (
              <div className="detail-group">
                <div className="detail-group-title">Two-factor authentication</div>
                <p className="cell-muted" style={{ margin: '0 4px 8px' }}>If the CEO lost their authenticator, reset it after confirming their identity out of band. They’ll be signed out and can set it up again.</p>
                <button type="button" className="btn btn-outline" style={{ margin: '0 4px' }} onClick={() => setResetCeo(true)}>Reset two-factor authentication</button>
              </div>
            )}
            {resetCeo && org.ceo && <ResetTwoFactorDialog userId={org.ceo.id} userLabel={`${org.ceo.firstName} ${org.ceo.lastName}`.trim() || org.ceo.email} onClose={() => setResetCeo(false)} />}

            <div className="detail-group">
              <div className="detail-group-title">Initial Manager</div>
              <p className="cell-muted" style={{ margin: '0 4px' }}>
                Managed by this organisation’s CEO in Settings → Members → Add. Platform administrators can’t invite or replace another organisation’s Initial Manager.
              </p>
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}
