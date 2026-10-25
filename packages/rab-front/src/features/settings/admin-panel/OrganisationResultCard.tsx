import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { toast } from '../../../shared/lib/toast';
import AdminActionDialog from './AdminActionDialog';
import { OrganisationAiSwitch } from './AiAdminSections';
import { ADMIN_ERROR_TEXT, adminApi, initials, shortId, type AdminOrganisation, type AdminOrganisationSummary } from './adminPanelApi';
import { openOrganisationDetailDrawer } from './OrganisationDetailHost';
import { INSPECT_OFF } from './UserResultCard';

const PENDING = new Set(['pending', 'queued', 'sending', 'delivery_failed', 'expired', 'cancelled']);

/**
 * One organisation's admin card (mockup v2 `#orgResult`): status, CEO, member/workspace COUNTS (never another
 * organisation's member list or Initial Manager — owner policy 2026-10-15), CEO 2FA state. Actions: resend the CEO
 * invitation (only while it is pending and has sends left), open the existing Members management drawer, suspend /
 * reactivate (reason + a recent step-up; suspension also needs the slug typed). Inspect stays OFF (D3).
 */
export default function OrganisationResultCard({ org }: { org: AdminOrganisation }) {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<'suspend' | 'reactivate' | 'ceoInvite' | null>(null);
  const { data: summary, isLoading } = useQuery({ queryKey: ['admin', 'org-summary', org.id], queryFn: () => adminApi.organisationSummary(org.id), staleTime: 15_000 });
  const { data: invite } = useQuery({ queryKey: ['admin', 'organisations', org.id], queryFn: () => adminApi.ceoInviteState(org.id), staleTime: 15_000 });
  const suspended = summary?.suspended ?? org.suspended;
  const ceo = summary?.ceo ?? null;
  const inviteStatus = invite?.ceo?.invitationStatus ?? null;
  const canResend = Boolean(inviteStatus && PENDING.has(inviteStatus) && (invite?.ceo?.pendingInvite?.sendNumber ?? 0) < 3);
  /** Background refresh of what this card's actions change (never awaited before the success feedback). */
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'org-summary', org.id] });
    void qc.invalidateQueries({ queryKey: ['admin', 'organisations', org.id] });
    void qc.invalidateQueries({ queryKey: ['admin', 'org-search'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
  };
  /** The confirmed server status goes on screen straight away (then the affected queries are refetched). */
  const applyStatus = (status: { suspended: boolean; suspendedAt: string | null }) =>
    qc.setQueryData<AdminOrganisationSummary>(['admin', 'org-summary', org.id], (prev) => (prev ? { ...prev, suspended: status.suspended, suspendedAt: status.suspendedAt } : prev));

  return (
    <div className="ap-card" aria-label={`Organisation ${org.name}`}>
      <div className="ap-result-head">
        <div className="ap-who">
          <div className="ap-avatar" aria-hidden="true">{initials(org.name)}</div>
          <div style={{ minWidth: 0 }}>
            <b>{org.name}</b>
            <span className="ap-muted">
              {org.slug} · <span className="ap-mono" title={org.id}>{shortId(org.id)}</span>
            </span>
          </div>
        </div>
        <div className="ap-row">
          <button
            type="button"
            className="ap-btn ap-sm"
            disabled={!canResend}
            title={canResend ? undefined : 'Available only while the CEO invitation is pending and has sends left.'}
            onClick={() => setDialog('ceoInvite')}
          >
            Resend CEO invite
          </button>
          <button type="button" className="ap-btn ap-sm" disabled title={INSPECT_OFF}>Inspect (off)</button>
          <button type="button" className="ap-btn ap-sm" title="Opens the existing management drawer from Settings → Members → Team" onClick={() => openOrganisationDetailDrawer(org.id)}>
            Open in Members
          </button>
          {suspended ? (
            <button type="button" className="ap-btn ap-sm" onClick={() => setDialog('reactivate')}>Reactivate</button>
          ) : (
            <button type="button" className="ap-btn ap-sm ap-danger" onClick={() => setDialog('suspend')}>Suspend</button>
          )}
        </div>
      </div>
      <div className="ap-grid-2" style={{ marginTop: 14 }}>
        <dl className="ap-kv">
          <dt>Status</dt>
          <dd>{suspended ? <span className="ap-pill ap-bad">Suspended</span> : <span className="ap-pill ap-ok">Active</span>}</dd>
          <dt>CEO</dt>
          <dd>{ceo ? `${ceo.name || ceo.email} (${ceo.activated ? 'activated' : 'not activated yet'})` : 'No CEO yet'}</dd>
          <dt>Members</dt>
          <dd>{isLoading ? 'Loading…' : summary ? `${summary.members.active} active` : 'Not available'}</dd>
          <dt>Workspaces</dt>
          <dd>
            {isLoading || !summary ? (isLoading ? 'Loading…' : 'Not available') : (
              <>
                {summary.workspaces.total}
                {summary.workspaces.total > 0 && (
                  <>
                    {' · schema '}
                    {summary.workspaces.failed > 0 ? <span className="ap-pill ap-bad">{summary.workspaces.failed} failed</span>
                      : summary.workspaces.creating > 0 ? <span className="ap-pill ap-info">Creating</span>
                      : <span className="ap-pill ap-ok">Ready</span>}
                  </>
                )}
              </>
            )}
          </dd>
        </dl>
        <dl className="ap-kv">
          <dt>CEO two-factor</dt>
          <dd>
            {ceo?.twoFactorEnabled === true ? <><span className="ap-pill ap-ok">On</span> <span className="ap-muted">turned on by the CEO</span></>
              : ceo?.twoFactorEnabled === false ? <><span className="ap-pill">Off</span> <span className="ap-muted">the CEO’s choice</span></>
              : '—'}
          </dd>
          <dt>Suspended</dt>
          <dd>{suspended ? `Yes${summary?.suspendedAt ? ` · since ${new Date(summary.suspendedAt).toLocaleDateString('en-GB')}` : ''}` : 'No'}</dd>
        </dl>
      </div>
      <OrganisationAiSwitch organisationId={org.id} organisationName={org.name} />

      {dialog === 'ceoInvite' && (
        <AdminActionDialog
          title="Resend the CEO invitation"
          body="Sends a new activation email and cancels the previous link."
          confirmLabel="Resend invite"
          stepUp={false}
          errorText={ADMIN_ERROR_TEXT}
          failureText="Could not resend the CEO invitation. Please try again."
          onConfirm={async ({ reason }) => {
            const result = await adminApi.resendCeoInvite(org.id, reason);
            toast.success(`Invitation ${result.queued ? 'queued for delivery' : 'sent'} (send ${result.sendNumber} of 3).`);
            setDialog(null);
            refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'suspend' && (
        <AdminActionDialog
          title={`Suspend ${org.name}`}
          body="Everyone in this organisation is signed out and cannot sign in until it is reactivated. Payroll and shift data are kept."
          confirmLabel="Suspend organisation"
          tone="danger"
          extraField={{ label: `Type the organisation slug (${org.slug}) to confirm`, placeholder: org.slug, mustEqual: org.slug }}
          errorText={ADMIN_ERROR_TEXT}
          failureText={`Could not suspend ${org.name}. Please try again.`}
          onConfirm={async ({ reason, currentPassword, code, extra }) => {
            await adminApi.stepUpIfGiven({ currentPassword, code });
            const status = await adminApi.suspendOrganisation(org.id, { reason, confirmSlug: extra });
            applyStatus(status);
            toast.success(`${org.name} is suspended. Everyone in it has been signed out.`);
            setDialog(null);
            refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'reactivate' && (
        <AdminActionDialog
          title={`Reactivate ${org.name}`}
          body="People in this organisation can sign in again."
          confirmLabel="Reactivate"
          errorText={ADMIN_ERROR_TEXT}
          failureText={`Could not reactivate ${org.name}. Please try again.`}
          onConfirm={async ({ reason, currentPassword, code }) => {
            await adminApi.stepUpIfGiven({ currentPassword, code });
            const status = await adminApi.reactivateOrganisation(org.id, { reason });
            applyStatus(status);
            toast.success(`${org.name} is active again. People can sign in.`);
            setDialog(null);
            refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
