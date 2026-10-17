import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { IconChevronDown, IconPlus } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import { useMyWorkspace } from '../../../shared/hooks/useMyWorkspace';
import { EmptyState } from '../../../shared/components/LoadingState';
import WorkspaceRolesPage from '../roles/WorkspaceRolesPage';
import InviteMembersPanel from './InviteMembersPanel';
import LeadershipAddPanel from './LeadershipAddPanel';
import TeamMembersPanel from './TeamMembersPanel';
import { useLeadershipCapabilities } from './leadershipCapabilities';
import './invite-members.css';

interface Me { id: string; roles: string[]; isPlatformAdmin: boolean }
type Tab = 'team' | 'invite' | 'roles';
type InviteMode = 'invite' | 'add';

/**
 * Settings → Members (Team | Invite | Roles). Everything shown here is a presentation gate only — the API re-derives
 * every permission. Invite is email-first: administrators never type an invitee's name; Add is reserved for
 * organisation leadership onboarding (CEO, Initial Manager) and only appears for those who can start it.
 */
export default function MembersPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = (['team', 'invite', 'roles'] as const).find((t) => t === params.get('tab')) ?? 'team';
  // Switching tabs resets the URL to just `tab`, so Invite always opens on the member invitation form.
  const switchTab = (value: Tab) => setParams({ tab: value });
  // Add vs Invite lives ONLY in the URL (`?tab=invite&mode=add`) — never in component state, which outlived tab
  // switches and reopened leadership Add on the Invite tab (regression fix). Default and fallback: Invite.
  const mode: InviteMode = tab === 'invite' && params.get('mode') === 'add' ? 'add' : 'invite';
  const setMode = (value: InviteMode) => setParams(value === 'add' ? { tab: 'invite', mode: 'add' } : { tab: 'invite' });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get<Me>('/auth/me')).data, staleTime: 300_000 });
  const canInvite = !!me && me.roles.some((value) => ['manager', 'ceo'].includes(value));
  const { capabilities: leadership, canAdd, isLoading: capabilitiesLoading } = useLeadershipCapabilities(!!me);
  const { data: workspace } = useMyWorkspace({ enabled: canInvite });

  // A bookmarked Add URL cannot leave the location claiming Add while the capability-gated UI shows Invite.
  useEffect(() => {
    if (me && !capabilitiesLoading && mode === 'add' && !canAdd) setParams({ tab: 'invite' }, { replace: true });
  }, [me, capabilitiesLoading, mode, canAdd, setParams]);

  if (me && !canInvite && !me.isPlatformAdmin && !canAdd) {
    return <EmptyState variant="access" title="Members are managed by your workspace administrator" description="Contact your manager for invitations or access changes." />;
  }
  const effectiveMode: InviteMode = canAdd ? mode : 'invite';
  // Compact Add | Invite prefix: only explicit server capabilities expose the second mode.
  const modeSelect = canAdd ? (
    <span className="member-mode-select">
      <select aria-label="Invite or add" value={effectiveMode} onChange={(e) => setMode(e.target.value as InviteMode)}>
        <option value="add">Add</option>
        <option value="invite">Invite</option>
      </select>
      <IconChevronDown size={12} aria-hidden="true" />
    </span>
  ) : null;

  return <div className="settings-page members-page">
    <div className="settings-page-heading"><h2>Members</h2><p>The right people, with the right access.</p></div>
    <nav className="member-tabs" aria-label="Members sections">
      {([['team', 'Team'], ['invite', 'Invite'], ['roles', 'Roles']] as const).map(([value, label]) => (
        <button type="button" key={value} className={tab === value ? 'active' : ''} aria-current={tab === value ? 'page' : undefined} onClick={() => switchTab(value)}>{label}</button>
      ))}
    </nav>
    <div className="members-banner"><div><h3>A good team starts with belonging.</h3><p>Invite your people. Set their role. Build something together.</p><small>{workspace?.name || 'Your workspace'} / YOUR SHARED WORKSPACE</small></div><div aria-hidden="true"><img src="/images/placeholders/background/no_members_bg.png" alt="" /><img src="/images/placeholders/moving-image/no_members.png" alt="" /></div></div>

    {tab === 'roles' ? <WorkspaceRolesPage embedded /> : tab === 'team' ? (
      <TeamMembersPanel action={canInvite ? <button className="btn btn-dark" onClick={() => switchTab('invite')}><IconPlus size={14} />Invite member</button> : null} />
    ) : effectiveMode === 'add' ? (
      <LeadershipAddPanel capabilities={leadership} modeSelect={modeSelect} />
    ) : canInvite ? <InviteMembersPanel workspaceName={workspace?.name} modeSelect={modeSelect} onCreateRole={() => switchTab('roles')} /> : <>
      {modeSelect}
      <p className="members-scope-note">Your account has no workspace role that can invite members.{canAdd ? ' Use Add for organisation leadership.' : ''}</p>
    </>}
  </div>;
}
