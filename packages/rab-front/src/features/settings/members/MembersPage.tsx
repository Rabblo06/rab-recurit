import { useState } from 'react';
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
  const switchTab = (value: Tab) => setParams({ tab: value });
  const [mode, setMode] = useState<InviteMode>(params.get('mode') === 'add' ? 'add' : 'invite');
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get<Me>('/auth/me')).data, staleTime: 300_000 });
  const isCeo = !!me?.roles.includes('ceo');
  const canInvite = !!me && me.roles.some((value) => ['manager', 'ceo'].includes(value));
  const canAdd = !!me && (me.isPlatformAdmin || isCeo);
  const { data: workspace } = useMyWorkspace({ enabled: canInvite });

  if (me && !canInvite && !me.isPlatformAdmin) {
    return <EmptyState variant="access" title="Members are managed by your workspace administrator" description="Contact your manager for invitations or access changes." />;
  }
  const effectiveMode: InviteMode = canAdd ? mode : 'invite';
  // Compact Add | Invite switch, shown as a prefix on the first field. Only leadership (CEO / platform admin) gets it.
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
      <LeadershipAddPanel isPlatformAdmin={!!me?.isPlatformAdmin} isCeo={isCeo} modeSelect={modeSelect} />
    ) : canInvite ? <InviteMembersPanel workspaceName={workspace?.name} modeSelect={modeSelect} onCreateRole={() => switchTab('roles')} /> : <>
      {modeSelect}
      <p className="members-scope-note">Your account has no workspace role that can invite members. Use Add for organisation leadership.</p>
    </>}
  </div>;
}
