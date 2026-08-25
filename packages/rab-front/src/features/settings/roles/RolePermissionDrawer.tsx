import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import Drawer from '../../../shared/components/Drawer';

interface PermissionCatalogEntry {
  key: string;
  resource: string;
  action: string;
  description: string | null;
}

interface RoleDetail {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  permissionKeys: string[];
}

const GROUP_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  staff: 'Users',
  manager: 'Managers',
  user: 'User Management',
  venue: 'Venues',
  schedule: 'Shifts & Calendar',
  offer: 'Offers',
  attendance: 'Attendance',
  payroll: 'Payroll',
  payslip: 'Payroll',
  review: 'Reviews',
  staffing_request: 'Staffing Requests',
  report: 'Reports',
  audit: 'Audit Log',
  settings: 'Settings',
  role: 'Roles',
};

const GROUP_ORDER = [
  'dashboard', 'staff', 'manager', 'user', 'schedule', 'offer', 'attendance',
  'payroll', 'payslip', 'venue', 'review', 'staffing_request', 'report', 'audit', 'settings', 'role',
];

export default function RolePermissionDrawer({
  open,
  onClose,
  roleId,
}: {
  open: boolean;
  onClose: () => void;
  roleId?: string;
}) {
  const qc = useQueryClient();
  const isCreate = !roleId;

  const { data: catalog } = useQuery({
    queryKey: ['roles', 'permissions'],
    queryFn: async () => (await api.get<PermissionCatalogEntry[]>('/roles/permissions')).data,
    enabled: open,
  });
  const { data: role } = useQuery({
    queryKey: ['roles', roleId],
    queryFn: async () => (await api.get<RoleDetail>(`/roles/${roleId}`)).data,
    enabled: open && Boolean(roleId),
  });

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setName(role?.name ?? '');
    setSelected(new Set(role?.permissionKeys ?? []));
  }, [open, role]);

  const dirty = isCreate
    ? Boolean(name) || selected.size > 0
    : name !== (role?.name ?? '') || JSON.stringify([...selected].sort()) !== JSON.stringify([...(role?.permissionKeys ?? [])].sort());

  const save = useMutation({
    mutationFn: () => {
      const permissionKeys = [...selected];
      if (isCreate) return api.post('/roles', { name, permissionKeys });
      return api.patch(`/roles/${roleId}`, { name, permissionKeys });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      toast.success(isCreate ? 'Role created.' : 'Role updated.');
      onClose();
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? 'Could not save this role.'),
  });

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const grouped = new Map<string, PermissionCatalogEntry[]>();
  for (const entry of catalog ?? []) {
    if (!grouped.has(entry.resource)) grouped.set(entry.resource, []);
    grouped.get(entry.resource)!.push(entry);
  }
  const orderedGroups = [
    ...GROUP_ORDER.filter((g) => grouped.has(g)),
    ...[...grouped.keys()].filter((g) => !GROUP_ORDER.includes(g)),
  ];

  const loading = open && !catalog;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={isCreate ? 'Create role' : role?.name ?? 'Role'}
      description={isCreate ? 'Name the role and choose its permissions.' : role?.isSystem ? 'System role — permissions are editable, the name is not.' : undefined}
      dirty={dirty}
      loading={save.isPending}
      footer={
        <>
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-dark" disabled={!name || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="field">
            <label>Role name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={role?.isSystem} />
          </div>

          {orderedGroups.map((resource) => (
            <div key={resource} className="perm-group">
              <p className="perm-group-title">{GROUP_LABELS[resource] ?? resource}</p>
              {grouped.get(resource)!.map((perm) => (
                <label key={perm.key} className="perm-item">
                  <input type="checkbox" checked={selected.has(perm.key)} onChange={() => toggle(perm.key)} />
                  {perm.description ?? perm.action.replace(/_/g, ' ')}
                </label>
              ))}
            </div>
          ))}
        </>
      )}
    </Drawer>
  );
}
