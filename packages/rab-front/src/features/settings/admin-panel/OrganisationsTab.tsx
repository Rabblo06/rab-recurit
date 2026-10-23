import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconSearch } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import { EmptyState, ListSkeleton } from '../../../shared/components/LoadingState';
import { openNewOrganisationDrawer, openOrganisationDetailDrawer } from './AdminOrganisationDrawers';

interface CeoListInfo {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  accountStatus: string;
}

export interface OrganisationListItem {
  id: string;
  name: string;
  slug: string;
  suspended: boolean;
  createdAt: string;
  ceo: CeoListInfo | null;
}

/**
 * Only `ceo.accountStatus` is available here (`core.list_organisations_for_admin()`'s own fixed
 * column set — see `OrganisationOnboardingService.listOrganisations`'s doc comment) — never the
 * richer `invitationStatus`/`pendingInvite` breakdown (queued/sending/pending N-of-3/cancelled),
 * which only `GET /admin/organisations/:id` (the detail drawer) has. Showing that finer-grained
 * status here would mean guessing it from data this endpoint doesn't return — exactly the
 * table-vs-drawer mismatch `staffStatus.ts`'s own doc comment warns about — so the list
 * deliberately stays at this coarser, but always honest, grain.
 */
const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'suspended_org', label: 'Organisation suspended' },
  { value: 'active', label: 'Active' },
  { value: 'invited', label: 'Invited' },
  { value: 'invite_expired', label: 'Invite expired' },
] as const;

function rowStatusValue(org: OrganisationListItem): string {
  if (org.suspended) return 'suspended_org';
  return org.ceo?.accountStatus ?? 'no_ceo';
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

export default function OrganisationsTab() {
  const { data: organisations, isLoading } = useQuery({
    queryKey: ['admin', 'organisations'],
    queryFn: async () => (await api.get<OrganisationListItem[]>('/admin/organisations')).data,
  });

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (organisations ?? []).filter((org) => {
      if (statusFilter && rowStatusValue(org) !== statusFilter) return false;
      if (!q) return true;
      return (
        org.name.toLowerCase().includes(q) ||
        org.slug.toLowerCase().includes(q) ||
        (org.ceo && `${org.ceo.firstName} ${org.ceo.lastName} ${org.ceo.email}`.toLowerCase().includes(q))
      );
    });
  }, [organisations, search, statusFilter]);

  return (
    <div className="settings-page">
      <div className="settings-section" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ marginBottom: 4 }}>Organisations</h3>
            <p style={{ marginBottom: 12 }}>Create organisations and invite their CEO.</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div className="toolbar-search" style={{ flex: 1, minWidth: 220 }}>
                <IconSearch size={14} />
                <input placeholder="Search by name or CEO…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ minWidth: 170 }}>
                {STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
          </div>
          <button type="button" className="btn btn-dark" style={{ flexShrink: 0 }} onClick={openNewOrganisationDrawer}>
            + New Organisation
          </button>
        </div>

        {isLoading ? (
          <ListSkeleton rows={5} />
        ) : filtered.length === 0 ? (
          <EmptyState
            compact
            variant={search || statusFilter ? 'matches' : 'records'}
            title="No organisations found"
            description={search || statusFilter ? 'Try another search or filter.' : 'Create the first organisation to get started.'}
          />
        ) : (
          filtered.map((org) => {
            const badge = statusBadge(org);
            return (
              <div key={org.id} className="role-row" onClick={() => openOrganisationDetailDrawer(org.id)}>
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
      </div>

      {/* The drawers are mounted globally in the shell (AdminOrganisationDrawers, W6-E2E-01) — never inside this page. */}
    </div>
  );
}
