import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { IconSearch } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import { EmptyState, ListSkeleton } from '../../../shared/components/LoadingState';
import { RoleIcon } from './RoleEditorLayout';

interface RoleSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  assignableToMembers: boolean;
  isSystem: boolean;
  isMemberRole: boolean;
  assignedUserCount: number;
}

export default function WorkspaceRolesPage({ embedded = false }: { embedded?: boolean }) {
  const { data: roles, isLoading, isError, refetch } = useQuery({
    queryKey: ['roles'],
    queryFn: async () => (await api.get<RoleSummary[]>('/roles')).data,
  });
  const [search, setSearch] = useState('');
  const navigate = useNavigate();

  const filtered = useMemo(
    () => (roles ?? []).filter((r) => r.name.toLowerCase().includes(search.toLowerCase())),
    [roles, search],
  );

  // Each role opens in the full-page editor (Permissions | Settings); system roles open read-only.
  const openRole = (id: string) => navigate(`/settings/workspace/members/roles/${id}`);
  const openCreate = () => navigate('/settings/workspace/members/roles/new');

  return (
    <div className={embedded ? 'roles-content' : 'settings-page roles-content'}>
      {!embedded && <div className="settings-page-heading"><h2>Roles</h2><p>Manage the permissions behind each workspace role.</p></div>}
      <div>
        <div className="members-toolbar roles-toolbar">
          {embedded && <div className="member-section-heading"><h3>Workspace roles</h3><p>Keep access clear and consistent across your team.</p></div>}
          <div className="toolbar-search">
            <IconSearch size={14} />
            <input aria-label="Search roles" placeholder="Search a role…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button className="btn btn-outline" onClick={openCreate}>+ Create role</button>
        </div>

        {isLoading ? (
          <ListSkeleton rows={5} />
        ) : isError ? <div role="alert" className="member-error">Could not load roles. <button className="btn btn-outline" onClick={() => refetch()}>Retry</button></div> : filtered.length === 0 ? (
          <EmptyState compact variant={search ? 'matches' : 'access'} title="No roles found" description="Try another search or create a role." />
        ) : (
          <div className="role-card-grid">{filtered.map((role) => (
            <button type="button" key={role.id} className="role-card" onClick={() => openRole(role.id)}>
              <span className="role-card-icon"><RoleIcon name={role.icon} size={22} /></span><span className="role-card-heading"><span className="role-name">{role.name}</span></span>
              <span className="role-card-description">
                {role.isMemberRole
                  ? role.description || (role.assignableToMembers ? 'Custom workspace role — invite people with it.' : 'Custom workspace role · not assignable.')
                  : 'System role · read-only.'}
              </span>
              <span className="role-count">
                {role.assignedUserCount} member{role.assignedUserCount === 1 ? '' : 's'}
              </span>
            </button>
          ))}</div>
        )}

      </div>

    </div>
  );
}
