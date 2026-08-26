import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconSearch } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { api } from '../../../shared/api';
import { EmptyState, FormSkeleton, ListSkeleton } from '../../../shared/components/LoadingState';

interface GeneralInfo {
  version: string;
  latestVersion: string | null;
}

interface RecentUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export default function GeneralTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'general'],
    queryFn: async () => (await api.get<GeneralInfo>('/admin/general')).data,
  });

  const [search, setSearch] = useState('');
  const { data: recentUsers, isLoading: usersLoading } = useQuery({
    queryKey: ['admin', 'recent-users', search],
    queryFn: async () =>
      (await api.get<RecentUser[]>('/admin/recent-users', { params: search ? { search } : undefined })).data,
  });

  if (isLoading || !data) return <FormSkeleton sections={2} />;

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3>About</h3>
        <p>Version of the application.</p>
        <div className="settings-row"><span>Current version</span><span style={{ color: 'var(--font-primary)' }}>{data.version}</span></div>
        <div className="settings-row"><span>Latest version</span><span style={{ color: 'var(--font-primary)' }}>{data.latestVersion ?? 'Unknown'}</span></div>
      </div>

      <div className="settings-section" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border-light)' }}>
          <h3 style={{ marginBottom: 4 }}>Recent Users</h3>
          <p style={{ marginBottom: 12 }}>{search ? 'Matching users.' : 'Last 10 users created.'}</p>
          <div className="toolbar-search" style={{ width: '100%' }}>
            <IconSearch size={14} />
            <input placeholder="Search by name or email…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        {usersLoading ? (
          <ListSkeleton rows={5} />
        ) : !recentUsers?.length ? (
          <EmptyState compact variant={search ? 'matches' : 'records'} title="No users found" description="Try a different name or email address." />
        ) : (
          recentUsers.map((u) => (
            <Link key={u.id} to={`/users/${u.id}`} className="role-row">
              <span className="role-name">{u.firstName} {u.lastName}</span>
              <span className="role-count">{u.email}</span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
