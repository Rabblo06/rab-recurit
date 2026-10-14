import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import Drawer from '../../../shared/components/Drawer';
import { DetailSkeleton } from '../../../shared/components/LoadingState';

interface PermissionCatalogEntry {
  key: string;
  resource: string;
  action: string;
  description: string | null;
  /** Whether a custom workspace-member role may hold this permission (decided by the server). */
  memberAssignable: boolean;
}

interface RoleDetail {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  isMemberRole: boolean;
  permissionKeys: string[];
  members: Array<{ userId: string; firstName: string; lastName: string; email: string }>;
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

/**
 * Create or edit a custom workspace-member role, or inspect any role. System roles (Manager, CEO, Staff, Venue
 * Manager, …) apply to the whole organisation and are read-only here. A custom role may only hold the permissions the
 * server marks `memberAssignable`, and never more than the editor holds — the server enforces both; this drawer only
 * offers what can succeed.
 */
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
  const { data: role, isError: roleError } = useQuery({
    queryKey: ['roles', roleId],
    queryFn: async () => (await api.get<RoleDetail>(`/roles/${roleId}`)).data,
    enabled: open && Boolean(roleId),
  });

  const readOnly = !isCreate && !role?.isMemberRole;
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setName(role?.name ?? '');
    setSelected(new Set(role?.permissionKeys ?? []));
  }, [open, role]);

  const dirty = !readOnly && (isCreate
    ? Boolean(name) || selected.size > 0
    : name !== (role?.name ?? '') || JSON.stringify([...selected].sort()) !== JSON.stringify([...(role?.permissionKeys ?? [])].sort()));

  const save = useMutation({
    mutationFn: () => {
      const permissionKeys = [...selected];
      if (isCreate) return api.post('/roles', { name: name.trim(), permissionKeys });
      return api.patch(`/roles/${roleId}`, { name: name.trim(), permissionKeys });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      qc.invalidateQueries({ queryKey: ['member-invitations', 'assignable-roles'] });
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

  // Editable roles list only member-safe permissions; read-only roles show exactly what they grant.
  const visible = (catalog ?? []).filter((p) => (readOnly ? (role?.permissionKeys ?? []).includes(p.key) : p.memberAssignable));
  const grouped = new Map<string, PermissionCatalogEntry[]>();
  for (const entry of visible) {
    if (!grouped.has(entry.resource)) grouped.set(entry.resource, []);
    grouped.get(entry.resource)!.push(entry);
  }
  const orderedGroups = [
    ...GROUP_ORDER.filter((g) => grouped.has(g)),
    ...[...grouped.keys()].filter((g) => !GROUP_ORDER.includes(g)),
  ];

  const loading = open && (!catalog || (Boolean(roleId) && !role && !roleError));

  // The shared side panel is a push-layout flex child of `.app-layout`; rendered inside Settings content it collapses
  // to zero height. Mount it where it belongs (tests and isolated renders have no `.app-layout` — render in place).
  const host = typeof document !== 'undefined' ? document.querySelector('.app-layout') : null;
  const drawer = (
    <Drawer
      open={open}
      onClose={onClose}
      title={isCreate ? 'Create role' : role?.name ?? 'Role'}
      description={
        isCreate
          ? 'A workspace role for people you invite. Choose what they can see.'
          : readOnly
            ? 'System role — it applies to the whole organisation and can’t be changed here.'
            : 'Custom workspace role.'
      }
      dirty={dirty}
      loading={save.isPending}
      footer={
        readOnly ? (
          <button className="btn btn-outline" onClick={onClose}>Close</button>
        ) : (
          <>
            <button className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button className="btn btn-dark" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </>
        )
      }
    >
      {roleError ? (
        <p role="alert" className="member-error">This role could not be loaded.</p>
      ) : loading ? (
        <DetailSkeleton />
      ) : (
        <>
          <div className="field">
            <label htmlFor="role-name">Role name</label>
            <input id="role-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={readOnly} />
          </div>

          {!readOnly && <p className="members-scope-note">Workspace roles can view information only. You can grant a permission only if you hold it yourself.</p>}

          {orderedGroups.map((resource) => (
            <div key={resource} className="perm-group">
              <p className="perm-group-title">{GROUP_LABELS[resource] ?? resource}</p>
              {grouped.get(resource)!.map((perm) => (
                <label key={perm.key} className="perm-item">
                  <input type="checkbox" checked={selected.has(perm.key)} onChange={() => toggle(perm.key)} disabled={readOnly} />
                  {perm.description ?? perm.action.replace(/_/g, ' ')}
                </label>
              ))}
            </div>
          ))}

          {!isCreate && role && (
            <div className="perm-group">
              <p className="perm-group-title">Assigned members in this workspace</p>
              {role.members.length === 0 ? (
                <p className="members-scope-note">Nobody in your workspace has this role yet.</p>
              ) : (
                <ul className="role-members">
                  {role.members.map((m) => (
                    <li key={m.userId}><span>{`${m.firstName} ${m.lastName}`.trim() || m.email}</span><span className="cell-muted">{m.email}</span></li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
  return host ? createPortal(drawer, host) : drawer;
}
