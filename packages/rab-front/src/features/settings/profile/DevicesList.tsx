import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IconDeviceDesktop } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import { timeAgo } from '../../../shared/lib/timeAgo';
import { EmptyState, ListSkeleton } from '../../../shared/components/LoadingState';

interface Session {
  familyId: string;
  deviceId: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastActiveAt: string;
  isCurrentDevice: boolean;
}

function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Safari\//.test(userAgent) ? 'Safari'
    : 'Browser';
  const os = /Windows/.test(userAgent) ? 'Windows'
    : /Mac OS/.test(userAgent) ? 'macOS'
    : /Linux/.test(userAgent) ? 'Linux'
    : /Android/.test(userAgent) ? 'Android'
    : /iPhone|iPad/.test(userAgent) ? 'iOS'
    : '';
  return os ? `${browser} on ${os}` : browser;
}

export default function DevicesList() {
  const qc = useQueryClient();
  const { data: sessions, isLoading } = useQuery({
    queryKey: ['profile', 'sessions'],
    queryFn: async () => (await api.get<Session[]>('/profile/sessions')).data,
  });

  const revoke = useMutation({
    mutationFn: (familyId: string) => api.delete(`/profile/sessions/${familyId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile', 'sessions'] });
      toast.success('Session revoked.');
    },
    onError: () => toast.error('Could not revoke that session.'),
  });

  if (isLoading) return <ListSkeleton rows={3} />;
  if (!sessions?.length) return <EmptyState compact variant="access" title="No active sessions" />;

  return (
    <div>
      {sessions.map((s) => (
        <div key={s.familyId} className="device-row">
          <div className="device-info">
            <span className="device-name" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <IconDeviceDesktop size={14} />
              {describeDevice(s.userAgent)}
            </span>
            <span className="device-meta">Last active {timeAgo(s.lastActiveAt)}{s.ip ? ` · ${s.ip}` : ''}</span>
          </div>
          {s.isCurrentDevice ? (
            <span className="device-current-badge">This device</span>
          ) : (
            <button className="btn btn-outline" onClick={() => revoke.mutate(s.familyId)} disabled={revoke.isPending}>
              Revoke
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
