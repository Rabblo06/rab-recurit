import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { EmptyState, ListSkeleton } from '../../../shared/components/LoadingState';
import { TableSearchInput } from '../../../shared/table-toolbar/TableToolbar';
import { openOrganisationDetailDrawer } from '../admin-panel/OrganisationDetailHost';

interface OrganisationListItem {
  id: string;
  name: string;
  slug: string;
  suspended: boolean;
  createdAt: string;
  ceo: { id: string; email: string; firstName: string; lastName: string; accountStatus: string } | null;
}

function statusBadge(org: OrganisationListItem): { label: string; tone: 'active' | 'pending' | 'inactive' } {
  if (org.suspended) return { label: 'Suspended', tone: 'inactive' };
  const status = org.ceo?.accountStatus;
  if (!status) return { label: 'No CEO', tone: 'inactive' };
  if (status === 'active') return { label: 'CEO active', tone: 'active' };
  if (status === 'invited') return { label: 'CEO invited', tone: 'pending' };
  if (status === 'invite_expired') return { label: 'CEO invite expired', tone: 'inactive' };
  return { label: status.replace(/_/g, ' '), tone: 'inactive' };
}

/**
 * Settings → Members → Team, platform administrators only: the organisations they manage. Moved from the retired
 * Admin Panel → Organisations tab (owner correction 2026-10-23) WITHOUT its creation form — a new organisation starts
 * only from Members → Add. A row opens the organisation drawer (settings, CEO invitation, two-factor reset), which is
 * mounted in the app shell. `GET /admin/organisations` is platform-admin only on the server.
 */
export default function OrganisationsPanel() {
  const [search, setSearch] = useState('');
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'organisations'],
    queryFn: async () => (await api.get<OrganisationListItem[]>('/admin/organisations')).data,
  });
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? []).filter((org) => !q || org.name.toLowerCase().includes(q) || org.slug.toLowerCase().includes(q) || `${org.ceo?.firstName ?? ''} ${org.ceo?.lastName ?? ''} ${org.ceo?.email ?? ''}`.toLowerCase().includes(q));
  }, [data, search]);

  return (
    <section className="pending-invitations" aria-labelledby="organisations-heading">
      <h3 id="organisations-heading">Organisations</h3>
      <div style={{ marginBottom: 8 }}>
        <TableSearchInput value={search} onChange={setSearch} />
      </div>
      {isLoading ? <ListSkeleton rows={4} /> : isError ? (
        <p role="alert" className="member-error feedback-error">Organisations could not be loaded. <button className="btn btn-outline" onClick={() => refetch()}>Retry</button></p>
      ) : filtered.length === 0 ? (
        <EmptyState compact variant={search ? 'matches' : 'records'} title="No organisations found" description={search ? 'Try another search.' : 'Organisations appear here once their invited CEO completes setup.'} />
      ) : (
        filtered.map((org) => {
          const badge = statusBadge(org);
          return (
            <div key={org.id} className="role-row" role="button" tabIndex={0} onClick={() => openOrganisationDetailDrawer(org.id)} onKeyDown={(e) => { if (e.key === 'Enter') openOrganisationDetailDrawer(org.id); }}>
              <span className="role-name">
                {org.name}
                <span className="cell-muted" style={{ marginLeft: 8, fontSize: 11 }}>{org.slug}</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="cell-muted">{org.ceo ? `${org.ceo.firstName} ${org.ceo.lastName}` : 'No CEO'}</span>
                <span className={`badge badge-${badge.tone}`}>{badge.label}</span>
              </span>
            </div>
          );
        })
      )}
    </section>
  );
}
