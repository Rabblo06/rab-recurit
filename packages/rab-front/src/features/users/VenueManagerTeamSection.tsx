import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconSearch, IconX } from '@tabler/icons-react';
import { api } from '../../shared/api';
import ConfirmDialog from '../../shared/components/ConfirmDialog';
import { toast } from '../../shared/lib/toast';
import VenueManagerStaffPicker from './VenueManagerStaffPicker';
import './venue-manager-team.css';

interface TeamMember {
  id: string; firstName: string; lastName: string; email: string;
  accountStatus: string; employmentStatus: string; jobRoleName: string | null; assignedAt: string;
}

const label = (s: string) => s.replace(/_/g, ' ');

/**
 * "Assigned staff" tab of a Venue Manager: which of the workspace owner's Staff this Venue Manager can see and select
 * (GET/POST/DELETE /venue-managers/:id/staff, owner-only on the server and in RLS). The panel footer's "Add Staff" opens
 * the full-page picker (`pickerOpen`). Assigning creates no account, offer or shift; removing never deletes the Staff
 * account or their history.
 */
export default function VenueManagerTeamSection({ venueManagerId, venueManagerName, pickerOpen, onPickerClose }: {
  venueManagerId: string; venueManagerName: string; pickerOpen: boolean; onPickerClose: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const key = ['venue-managers', venueManagerId, 'staff'];
  const team = useQuery({
    queryKey: key,
    queryFn: async () => (await api.get<TeamMember[]>(`/venue-managers/${venueManagerId}/staff`)).data,
  });
  const remove = useMutation({
    mutationFn: (staffId: string) => api.delete(`/venue-managers/${venueManagerId}/staff/${staffId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); toast.success('Staff member removed from this venue manager.'); setRemoving(null); },
    onError: () => toast.error('Could not remove this staff member. Try again.'),
  });

  const rows = team.data ?? [];
  const q = search.trim().toLowerCase();
  const visible = q ? rows.filter((r) => `${r.firstName} ${r.lastName} ${r.email} ${r.jobRoleName ?? ''}`.toLowerCase().includes(q)) : rows;
  const status = (team.error as { response?: { status?: number } } | null)?.response?.status;

  return (
    <div className="vm-team">
      <div className="detail-group-title">Assigned Staff{team.data ? ` · ${rows.length}` : ''}</div>
      {team.isLoading ? (
        <p className="vm-team-muted">Loading assigned staff…</p>
      ) : team.isError ? (
        <div className="vm-team-error" role="alert">
          <span>{status === 403 ? 'Only the workspace owner can manage this venue manager’s staff.' : 'Could not load assigned staff.'}</span>
          {status !== 403 && <button type="button" className="btn-link-muted" onClick={() => team.refetch()}>Retry</button>}
        </div>
      ) : (
        <>
          <label className="vm-team-search">
            <IconSearch size={13} aria-hidden="true" />
            <input aria-label="Search assigned staff" placeholder="Search assigned staff" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          {rows.length === 0 ? (
            <p className="vm-team-muted">No staff assigned yet. {venueManagerName} cannot see or select anyone until you add staff.</p>
          ) : visible.length === 0 ? (
            <p className="vm-team-muted">No assigned staff match “{search}”.</p>
          ) : (
            <ul className="vm-team-list" aria-label="Assigned staff">
              {visible.map((m) => (
                <li key={m.id}>
                  <span className="mini-avatar" aria-hidden="true">{m.firstName[0]}{m.lastName[0]}</span>
                  <span className="vm-team-text">
                    <span className="vm-team-name">{m.firstName} {m.lastName}</span>
                    <span className="vm-team-sub">{m.jobRoleName ?? 'No role'} · <span className="vm-team-cap">{label(m.employmentStatus)}</span></span>
                  </span>
                  <span className={`badge ${m.accountStatus === 'active' ? 'badge-active' : 'badge-pending'}`}>
                    {m.accountStatus === 'active' ? 'Assigned' : 'Visible after sign-in'}
                  </span>
                  <button type="button" className="btn-icon" aria-label={`Remove ${m.firstName} ${m.lastName}`} onClick={() => setRemoving(m)}>
                    <IconX size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {pickerOpen && team.data && (
        <VenueManagerStaffPicker
          venueManagerId={venueManagerId}
          venueManagerName={venueManagerName}
          assignedIds={new Set(rows.map((r) => r.id))}
          onCancel={onPickerClose}
          onConfirmed={(n) => { qc.invalidateQueries({ queryKey: key }); onPickerClose(); toast.success(`${n} staff member${n === 1 ? '' : 's'} assigned.`); }}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        title="Remove staff from this venue manager?"
        description={removing ? `${removing.firstName} ${removing.lastName} will no longer appear in ${venueManagerName}’s app or be selectable for new requests. Their account, shifts, offers and attendance are not changed.` : undefined}
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
