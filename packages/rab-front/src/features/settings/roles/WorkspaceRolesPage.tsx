import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconSearch, IconUsers } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import RolePermissionDrawer from './RolePermissionDrawer';

interface RoleSummary {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  assignedUserCount: number;
}

export default function WorkspaceRolesPage() {
  const { data: roles, isLoading } = useQuery({
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
    <div className="settings-page" style={{ maxWidth: 720 }}>
      <div className="settings-section" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border-light)' }}>
          <h3 style={{ marginBottom: 4 }}>Roles</h3>
          <p style={{ marginBottom: 12 }}>Assign roles to specify access permissions.</p>
          <div className="toolbar-search" style={{ width: '100%' }}>
            <IconSearch size={14} />
            <input placeholder="Search a role…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        {isLoading ? (
          <p className="muted" style={{ padding: 16 }}>Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="muted" style={{ padding: 16 }}>No roles found.</p>
        ) : (
          filtered.map((role) => (
            <div key={role.id} className="role-row" onClick={() => openRole(role.id)}>
              <span className="role-name">{role.name}</span>
              <span className="role-count">
                <IconUsers size={13} />
                {role.assignedUserCount}
              </span>
            </div>
          ))
        )}

        <div style={{ padding: 12, borderTop: '1px solid var(--border-light)', display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-dark" onClick={openCreate}>+ Create Role</button>
        </div>
      </div>

      <RolePermissionDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} roleId={selectedRoleId} />
    </div>
  );
}
