import { useQuery } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { EmptyState, ListSkeleton } from '../../../shared/components/LoadingState';

interface HealthCheckItem {
  name: string;
  status: 'operational' | 'degraded' | 'down' | 'unknown';
  detail?: string;
}

const STATUS_LABEL: Record<HealthCheckItem['status'], string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Unknown',
};

export default function HealthTab() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'health'],
    queryFn: async () => (await api.get<HealthCheckItem[]>('/admin/health')).data,
  });

  return (
    <div className="settings-page">
      <div className="settings-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3>Health Status</h3>
            <p>Here you can view a status of every service this app depends on.</p>
          </div>
          <button className="btn btn-outline" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? 'Checking…' : 'Refresh'}
          </button>
        </div>

        {isLoading ? (
          <ListSkeleton rows={4} />
        ) : !data?.length ? (
          <EmptyState compact variant="functions" title="No service checks available" />
        ) : (
          (data ?? []).map((item) => (
            <div key={item.name} className="health-row">
              <span>{item.name}</span>
              <span className={`health-status ${item.status}`}>
                <span className={`health-dot ${item.status}`} />
                {STATUS_LABEL[item.status]}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
