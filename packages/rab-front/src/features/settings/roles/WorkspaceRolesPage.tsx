import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconSearch, IconUsers, IconShieldLock } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import RolePermissionDrawer from './RolePermissionDrawer';
import { EmptyState, ListSkeleton } from '../../../shared/components/LoadingState';

interface RoleSummary {
  id: string;
  key: string;
  name: string;
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState<string | undefined>(undefined);

  const filtered = useMemo(
    () => (roles ?? []).filter((r) => r.name.toLowerCase().includes(search.toLowerCase())),
    [roles, search],
  );

  function openRole(id: string) {
    setSelectedRoleId(id);
    setDrawerOpen(true);
  }

  function openCreate() {
    setSelectedRoleId(undefined);
    setDrawerOpen(true);
  }

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
              <IconShieldLock className="role-card-icon" size={22} stroke={1.5} /><span className="role-card-heading"><span className="role-name">{role.name}</span></span>
              <span className="role-card-description">{role.isMemberRole ? 'Custom workspace role — invite people with it.' : 'System role · read-only.'}</span>
              <span className="role-count">
                {role.assignedUserCount} member{role.assignedUserCount === 1 ? '' : 's'}
              </span>
            </button>
          ))}</div>
        )}

      </div>

      <RolePermissionDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} roleId={selectedRoleId} />
    </div>
  );
}
