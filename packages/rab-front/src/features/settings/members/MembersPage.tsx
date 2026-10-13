import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconPlus, IconMail, IconUsers, IconShield } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import { useMyWorkspace } from '../../../shared/hooks/useMyWorkspace';
import { EmptyState, TableSkeleton } from '../../../shared/components/LoadingState';
import { TableSearchInput } from '../../../shared/table-toolbar/TableToolbar';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { getStaffDisplayStatus, type InvitationStatus, type PendingInvite } from '../../users/staffStatus';
import WorkspaceRolesPage from '../roles/WorkspaceRolesPage';

interface Me { id: string; roles: string[]; isPlatformAdmin: boolean }
interface Member {
  id: string; firstName: string; lastName: string; email: string; type?: string;
  accountStatus: string; employmentStatus?: string; invitationStatus: InvitationStatus;
  pendingInvite: PendingInvite | null; endpoint: 'staff' | 'managers';
}
type InviteRole = 'staff' | 'venue' | 'internal';

/** All membership/invitation state is returned by the existing staff and manager services. */
export default function MembersPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = ['team', 'invite', 'roles'].includes(params.get('tab') ?? '') ? params.get('tab')! : 'team';
  const switchTab = (value: string) => setParams({tab:value});
  const [search, setSearch] = useState('');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [role, setRole] = useState<InviteRole>('staff');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [cancelTarget, setCancelTarget] = useState<Member | null>(null);
  const {data:me} = useQuery({queryKey:['me'],queryFn:async () => (await api.get<Me>('/auth/me')).data,staleTime:300_000});
  // This is a conservative presentation gate, never authority. Every endpoint rechecks permissions.
  const canInvite = !!me && me.roles.some(value => ['manager','ceo'].includes(value));
  const canManageManagers = canInvite && !!me && (me.isPlatformAdmin || me.roles.includes('ceo'));
  const {data:workspace} = useMyWorkspace({enabled:canInvite});
  const staff = useQuery({queryKey:['staff','members'],enabled:canInvite,queryFn:async () => (await api.get<{data:Omit<Member,'endpoint'>[];total:number}>('/staff')).data});
  const managers = useQuery({queryKey:['managers','members'],enabled:canManageManagers,queryFn:async () => (await api.get<{data:Omit<Member,'endpoint'>[];total:number}>('/managers')).data});
  const members:Member[] = [...(staff.data?.data ?? []).map(row => ({...row,endpoint:'staff' as const})),...(managers.data?.data ?? []).map(row => ({...row,endpoint:'managers' as const}))];
  const matching = members.filter(row => `${row.firstName} ${row.lastName} ${row.email}`.toLowerCase().includes(search.toLowerCase()));
  const pending = members.filter(row => !!row.pendingInvite && ['invited','invite_expired'].includes(row.accountStatus));
  const invalidate = () => { qc.invalidateQueries({queryKey:['staff']});qc.invalidateQueries({queryKey:['managers']});qc.invalidateQueries({queryKey:['roles']}); };
  const describeError = (err: any) => { const message=err?.response?.data?.message;return Array.isArray(message) ? message.join(' ') : message || 'We couldn’t complete this request. Please try again.'; };
  const invite = useMutation({
    mutationFn: async () => {
      if (!canInvite || (role === 'internal' && !canManageManagers)) throw new Error('Role not available.');
      const body={email:email.trim(),firstName:firstName.trim(),lastName:lastName.trim()};
      if (role === 'staff') return api.post('/staff',body);
      if (role === 'internal') return api.post('/managers',{...body,type:'internal'});
      if (canManageManagers) {
        if (!workspace?.id) throw new Error('A workspace is required.');
        return api.post('/org-admin/venue-managers',{...body,targetWorkspaceId:workspace.id});
      }
      return api.post('/venue-managers',body);
    },
    onSuccess: ({data}) => {
      invalidate();setEmail('');setFirstName('');setLastName('');
      setNotice(data.invite?.queued || data.emailQueued || data.invitationStatus === 'queued' ? 'Invitation queued. The member will set their password using the invitation email.' : 'Account created. An invitation could not be queued; check the member’s invitation status.');
    },
    onError: err => setError(describeError(err)),
  });
  const invitationAction=useMutation({
    mutationFn: ({member,action}:{member:Member;action:'resend-invite'|'cancel-invite'}) => api.post(`/${member.endpoint}/${member.id}/${action}`),
    onSuccess: ({data},{action}) => {invalidate();setCancelTarget(null);setNotice(action === 'resend-invite' ? data?.queued || data?.invite?.queued ? 'Invitation queued for delivery.' : 'Invitation request processed. Check its delivery status in the member record.' : 'Invitation revoked.');},
    onError: err => setError(describeError(err)),
  });

  if (me && !canInvite) return <EmptyState variant="access" title="Members are managed by your workspace administrator" description="Contact your manager for invitations or access changes." />;
  return <div className="settings-page members-page">
    <div className="settings-page-heading"><h2>Members</h2><p>The right people, with the right access.</p></div>
    <nav className="member-tabs" aria-label="Members sections">{[{value:'team',label:'Team',Icon:IconUsers},{value:'invite',label:'Invite',Icon:IconMail},{value:'roles',label:'Roles',Icon:IconShield}].map(({value,label,Icon}) => <button key={value} className={tab===value ? 'active' : ''} aria-current={tab===value ? 'page' : undefined} onClick={() => switchTab(value)}>{label}</button>)}</nav>
    <div className="members-banner"><div><h3>A good team starts with belonging.</h3><p>Invite your people. Set their role. Build something together.</p><small>{workspace?.name || "Your workspace"} / YOUR SHARED WORKSPACE</small></div><div aria-hidden="true"><img src="/images/placeholders/background/no_members_bg.png" alt="" /><img src="/images/placeholders/moving-image/no_members.png" alt="" /></div></div>
    {error && <p role="alert" className="member-error">{error}</p>}{notice && <p role="status" className="member-notice">{notice}</p>}
    {tab === 'roles' ? <WorkspaceRolesPage embedded /> : tab === 'team' ? <>
      <div className="member-section-heading"><h3>Manage members</h3><p>Manage the people available to your account.</p></div>
      <div className="members-toolbar"><TableSearchInput value={search} onChange={setSearch} /><button className="btn btn-dark" onClick={() => switchTab('invite')}><IconPlus size={14} />Invite member</button></div>
      {(staff.isError || managers.isError) && <p role="alert" className="member-error">Some members could not be loaded. <button className="btn btn-outline" onClick={() => {staff.refetch();if(canManageManagers)managers.refetch();}}>Retry</button></p>}
      {staff.isLoading || (canManageManagers && managers.isLoading) ? <TableSkeleton columns={4} /> : <div className="members-table-wrap"><table className="table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>{matching.map(member => {
        const display=getStaffDisplayStatus({userType:member.endpoint==='staff'?'staff':'manager',accountStatus:member.accountStatus,employmentStatus:member.employmentStatus,invitationStatus:member.invitationStatus,pendingInvite:member.pendingInvite});
        return <tr key={`${member.endpoint}-${member.id}`}><td><button className="member-name" onClick={() => document.dispatchEvent(new CustomEvent('open-user-detail',{detail:{id:member.id,type:member.endpoint==='staff'?'staff':'manager'}}))}><span className="mini-avatar">{member.firstName?.[0]}{member.lastName?.[0]}</span>{member.firstName} {member.lastName}</button></td><td className="cell-muted">{member.email}</td><td>{member.endpoint==='staff' ? 'Staff' : member.type==='venue' ? 'Venue manager' : member.type==='ceo' ? 'CEO' : 'Manager'}</td><td><span className={`badge badge-${display.tone}`}>{display.label}</span></td></tr>;
      })}{!matching.length && !staff.isError && !managers.isError && <tr><td colSpan={4}><EmptyState compact variant="members" title={search ? 'No members match your search' : 'Your team starts here'} description="Invite a member to start working together." /></td></tr>}</tbody></table></div>}
      {(staff.data?.total ?? 0)+(managers.data?.total ?? 0)>members.length && <p className="members-scope-note">Showing the first {members.length} accessible records. Use Users for paginated staff and manager lists.</p>}
      {!canManageManagers && <p className="members-scope-note">This list shows the staff directory available to your account. Manager-directory access is restricted by the server.</p>}
    </> : <>
      <section className="member-invite-card"><div className="member-section-heading"><h3>Invite your team</h3><p>Send an invitation to join {workspace?.name || "your workspace"}.</p></div>
        <form onSubmit={e => {e.preventDefault();setNotice('');setError('');invite.mutate();}}>
          <div className="invite-primary-fields">
          <div className="field"><label htmlFor="member-email">Email address</label><input id="member-email" type="email" placeholder="colleague@company.com" value={email} onChange={e=>setEmail(e.target.value)} required /></div>
          <div className="field"><label htmlFor="member-role">Workspace role</label><select id="member-role" value={role} onChange={e=>setRole(e.target.value as InviteRole)}><option value="staff">Staff</option><option value="venue">Venue manager</option>{canManageManagers && <option value="internal">Manager</option>}</select></div>
          </div>
          <div className="form-grid"><div className="field"><label htmlFor="member-first">First name</label><input id="member-first" value={firstName} onChange={e=>setFirstName(e.target.value)} required /></div><div className="field"><label htmlFor="member-last">Last name</label><input id="member-last" value={lastName} onChange={e=>setLastName(e.target.value)} required /></div></div>
          <p>Names are required to create the member’s account. Administrative roles are restricted.</p>
          <button className="btn btn-dark" disabled={invite.isPending || !canInvite || (role==='venue' && canManageManagers && !workspace?.id)}><IconMail size={14} />{invite.isPending ? 'Sending…' : 'Send invitation'}</button>
        </form>
      </section>
      <section className="pending-invitations"><h3>Pending invitations</h3><p>People who haven’t joined your workspace yet.</p>
        {staff.isLoading || (canManageManagers && managers.isLoading) ? <p role="status">Loading invitations…</p> : staff.isError || managers.isError ? <p role="alert">Invitations could not be loaded. <button className="btn btn-outline" onClick={()=>{staff.refetch();if(canManageManagers)managers.refetch();}}>Retry</button></p> : !pending.length ? <p>No pending invitations in the loaded member records.</p> : pending.map(member=><div className="pending-invitation" key={`${member.endpoint}-${member.id}`}><div><strong>{member.firstName} {member.lastName}</strong><span>{member.email}</span></div><span className="badge badge-pending">{member.invitationStatus ?? 'Pending'}</span><button className="btn btn-outline" disabled={invitationAction.isPending} onClick={()=>invitationAction.mutate({member,action:'resend-invite'})}>Resend</button><button className="btn btn-outline" disabled={invitationAction.isPending} onClick={()=>setCancelTarget(member)}>Revoke</button></div>)}
      </section>
    </>}
    <ConfirmDialog open={!!cancelTarget} title="Revoke this invitation?" description="The invitation link will stop working. This does not delete the member’s records." confirmLabel="Revoke invitation" destructive loading={invitationAction.isPending} onConfirm={()=>{if(cancelTarget)invitationAction.mutate({member:cancelTarget,action:'cancel-invite'});}} onCancel={()=>setCancelTarget(null)} />
  </div>;
}
