import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { IconBuildingSkyscraper, IconUserStar } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import NewOrganisationDrawer from '../admin-panel/NewOrganisationDrawer';
import OrganisationDetailDrawer from '../admin-panel/OrganisationDetailDrawer';
import type { OrganisationListItem } from '../admin-panel/OrganisationsTab';

/**
 * Settings → Members → Invite → Add: organisation LEADERSHIP onboarding only — never Staff or Venue Managers.
 * Reuses the existing, already-hardened flows unchanged (`OrganisationOnboardingService` and its CEO / Initial
 * Manager uniqueness, cooldown and replacement rules); nothing here re-implements them.
 *
 *  - Platform Super Admin: create an organisation and invite its CEO; invite or manage an organisation's Initial
 *    Manager (the organisation is chosen from the server's own list — never typed in).
 *  - CEO: invite their own organisation's Initial Manager (the organisation is the session's own).
 *
 * The backend still enforces every rule; this panel only shows the actions a role can legitimately start.
 */
/** Side panels are push-layout flex children of `.app-layout`; nested in Settings content they collapse to zero height. */
function inLayout(node: ReactNode) {
  const host = typeof document !== 'undefined' ? document.querySelector('.app-layout') : null;
  return host ? createPortal(node, host) : node;
}

export default function LeadershipAddPanel({ isPlatformAdmin, isCeo, modeSelect }: { isPlatformAdmin: boolean; isCeo: boolean; modeSelect?: ReactNode }) {
  const [newOrgOpen, setNewOrgOpen] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(null);
  const orgs = useQuery({
    queryKey: ['admin', 'organisations'],
    queryFn: async () => (await api.get<OrganisationListItem[]>('/admin/organisations')).data,
    enabled: isPlatformAdmin,
  });

  return <section className="member-invite-card leadership-add" aria-labelledby="add-heading">
    <div className="member-section-heading"><h3 id="add-heading">Add organisation leadership</h3><p>Start a new organisation or bring in its first manager. Staff and venue managers are invited from the Invite option.</p></div>
    {modeSelect && <div className="leadership-mode-row">{modeSelect}<span>Leadership onboarding</span></div>}
    <p className="members-scope-note" role="note">
      These leadership invitations still ask for the person’s name. Moving them to email-only is awaiting a decision because it changes how CEO and Initial Manager accounts are created.
    </p>
    <div className="leadership-actions">
      {isPlatformAdmin && <>
        <div className="leadership-action">
          <IconBuildingSkyscraper size={20} aria-hidden="true" />
          <div><strong>Create organisation and invite CEO</strong><span>Creates the organisation and emails its CEO an invitation.</span></div>
          <button className="btn btn-dark" onClick={() => setNewOrgOpen(true)}>Create organisation</button>
        </div>
        <div className="leadership-action">
          <IconUserStar size={20} aria-hidden="true" />
          <div>
            <strong>Invite Initial Manager</strong>
            <span>Choose an organisation to invite, resend or replace its Initial Manager.</span>
            {orgs.isError && <span role="alert" className="member-error">Organisations could not be loaded.</span>}
          </div>
          <div className="field leadership-org-select">
            <label htmlFor="leadership-org" className="visually-hidden">Organisation</label>
            <select id="leadership-org" value={orgId ?? ''} onChange={(e) => setOrgId(e.target.value || null)} disabled={!orgs.data?.length}>
              <option value="">{orgs.isLoading ? 'Loading organisations…' : 'Choose an organisation'}</option>
              {orgs.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
        </div>
      </>}
      {!isPlatformAdmin && isCeo && (
        <div className="leadership-action">
          <IconUserStar size={20} aria-hidden="true" />
          <div><strong>Invite Initial Manager</strong><span>Invite the first manager of your organisation. They set up their own workspace after accepting.</span></div>
          <Link className="btn btn-dark" to="/settings/workspace/team">Invite Initial Manager</Link>
        </div>
      )}
    </div>
    {isPlatformAdmin && inLayout(<>
      <NewOrganisationDrawer open={newOrgOpen} onClose={() => setNewOrgOpen(false)} onCreated={(id) => { setNewOrgOpen(false); setOrgId(id); }} />
      <OrganisationDetailDrawer open={Boolean(orgId)} organisationId={orgId} onClose={() => setOrgId(null)} />
    </>)}
  </section>;
}
