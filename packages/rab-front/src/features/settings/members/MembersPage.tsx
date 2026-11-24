import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { IconChevronDown, IconUsers, IconUserPlus, IconLock, IconLink } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import { useMyWorkspace } from '../../../shared/hooks/useMyWorkspace';
import { EmptyState } from '../../../shared/components/LoadingState';
import WorkspaceRolesPage from '../roles/WorkspaceRolesPage';
import InviteMembersPanel from './InviteMembersPanel';
import LeadershipAddPanel from './LeadershipAddPanel';
import MembersBreadcrumb from './MembersBreadcrumb';
import TeamMembersPanel from './TeamMembersPanel';
import { useLeadershipCapabilities } from './leadershipCapabilities';
import StaffSelect from '../../users/StaffSelect';
import './invite-members.css';

interface Me { id: string; roles: string[]; isPlatformAdmin: boolean; workspaceId?: string }
type Tab = 'team' | 'add' | 'roles';
type InviteMode = 'invite' | 'add';

/**
 * Settings → Members (Team | Add | Roles — owner correction 2026-10-23: the former Invite tab is the Add tab). Everything
 * shown here is a presentation gate only — the API re-derives every permission. Member invitations are email-first:
 * administrators never type an invitee's name. Leadership Add (CEO / Initial Manager) only appears for those who can
 * start it; for a platform administrator it is the ONE place a new organisation starts (email-only CEO invitation).
 * `?tab=invite` (old links and bookmarks) opens Add.
 */
export default function MembersPage() {
  const [params, setParams] = useSearchParams();
  const [memberOpen, setMemberOpen] = useState(false);
  const rawTab = params.get('tab') === 'invite' ? 'add' : params.get('tab');
  const tab: Tab = (['team', 'add', 'roles'] as const).find((t) => t === rawTab) ?? 'team';
  // Switching tabs resets the URL to just `tab`, so Invite always opens on the member invitation form.
  const switchTab = (value: Tab) => setParams({ tab: value });
  // Add vs Invite lives ONLY in the URL (`?tab=add&mode=add`) — never in component state, which outlived tab
  // switches and reopened leadership Add on the member form (regression fix). Default and fallback: Invite.
  const urlMode = tab === 'add' ? params.get('mode') : null;
  const setMode = (value: InviteMode) => setParams({ tab: 'add', mode: value });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get<Me>('/auth/me')).data, staleTime: 300_000 });
  const canInvite = !!me && me.roles.some((value) => ['manager', 'ceo'].includes(value));
  const { capabilities: leadership, canAdd, isLoading: capabilitiesLoading } = useLeadershipCapabilities(!!me);
  // Owner correction 2026-10-23: for a platform administrator, Add opens on "Add organisation" (the one place a new
  // organisation starts); everyone else keeps the member invitation as the default. An explicit `mode` always wins.
  const defaultMode: InviteMode = me?.isPlatformAdmin && leadership.canCreateOrganisation ? 'add' : 'invite';
  const mode: InviteMode = urlMode === 'add' ? 'add' : urlMode === 'invite' ? 'invite' : defaultMode;
  const { data: workspace } = useMyWorkspace({ enabled: canInvite });

  // A bookmarked Add URL cannot leave the location claiming Add while the capability-gated UI shows Invite.
  useEffect(() => {
    if (me && !capabilitiesLoading && urlMode === 'add' && !canAdd) setParams({ tab: 'add' }, { replace: true });
  }, [me, capabilitiesLoading, urlMode, canAdd, setParams]);

  if (tab !== "team" && me && !canInvite && !me.isPlatformAdmin && !canAdd) {
    return <EmptyState variant="access" title="Members are managed by your workspace administrator" description="Contact your manager for invitations or access changes." />;
  }
  if (!me || capabilitiesLoading) return <p role="status">Loading members…</p>;
  // A platform administrator with no workspace role can only Add (one permitted action: no Add | Invite selector).
  const effectiveMode: InviteMode = canAdd && (!canInvite || mode === 'add') ? 'add' : 'invite';
  // Compact Add | Invite prefix: only explicit server capabilities expose the second mode.
  const modeSelect = canAdd && canInvite ? (
    <span className="member-mode-select">
      <label className="invite-mode-label" htmlFor="member-invite-mode">Invite or add</label>
      <StaffSelect id="member-invite-mode" label="Invite or add" value={effectiveMode} onChange={(value) => setMode(value as InviteMode)}
        options={[{ value: 'add', label: 'Add' }, { value: 'invite', label: 'Invite' }]} placeholder="Invite" searchable={false} compact />
    </span>
  ) : null;

  return <div className="settings-page members-page">
    {tab !== 'team' && <MembersBreadcrumb title="Members" current={tab === 'roles' ? 'Roles' : effectiveMode === 'add' ? 'Add' : 'Invite'} />}
    {!memberOpen && <nav className="member-tabs members-section-switcher" aria-label="Members sections">
      {([['team', 'Team'], ['add', 'Invite'], ['roles', 'Roles']] as const).filter(([value]) => value === 'team' || canInvite || me.isPlatformAdmin || canAdd).map(([value, label]) => (
        <button type="button" key={value} className={tab === value ? 'active' : ''} aria-current={tab === value ? 'page' : undefined} onClick={() => switchTab(value)}>{value === 'team' ? <IconUsers size={14} aria-hidden="true" /> : value === 'add' ? <IconUserPlus size={14} aria-hidden="true" /> : <IconLock size={14} aria-hidden="true" />}{label}</button>
      ))}
    </nav>}

    {tab === 'add' && <section className="member-link-invite" aria-labelledby="member-link-heading">
      <div className="member-section-heading">
        <h3 id="member-link-heading">{effectiveMode === 'add' ? 'Add the User' : 'Invite by link'}</h3>
        <p>{effectiveMode === 'add'
          ? 'Invite organisation leadership to complete their account setup.'
          : 'Share a link to invite people to your workspace.'}</p>
      </div>
      <div className="member-link-row">
        {modeSelect || <span className="btn btn-outline" aria-disabled="true">{effectiveMode === 'add' ? 'Add' : 'Invite'}<IconChevronDown size={12} aria-hidden="true" /></span>}
        <input aria-label="Invitation link" placeholder="Invitation link unavailable" readOnly disabled aria-describedby="member-link-unavailable" />
        <button type="button" className="btn btn-primary" disabled aria-describedby="member-link-unavailable"><IconLink size={14} aria-hidden="true" />{effectiveMode === 'add' ? 'Send link' : 'Copy link'}</button>
      </div>
      <p id="member-link-unavailable" className="member-link-unavailable">Link invitations are not available yet. Use email below.</p>
    </section>}

    {tab === 'roles' ? <WorkspaceRolesPage embedded /> : tab === 'team' ? (
      <TeamMembersPanel key={`${me.id}:${me.workspaceId ?? ""}`} identity={`${me.id}:${me.workspaceId ?? ""}`} platformAdmin={me.isPlatformAdmin} action={null} onDetailChange={setMemberOpen} />
    ) : effectiveMode === 'add' ? (
      <LeadershipAddPanel capabilities={leadership} />
    ) : canInvite ? <InviteMembersPanel workspaceName={workspace?.name} onCreateRole={() => switchTab('roles')} /> : <>
      <p className="members-scope-note">Your account has no workspace role that can invite members.{canAdd ? ' Use Add for organisation leadership.' : ''}</p>
    </>}
  </div>;
}
