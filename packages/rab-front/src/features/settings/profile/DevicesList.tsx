import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IconDeviceDesktop } from '@tabler/icons-react';
import { api, broadcastLogout, withAuthLock } from '../../../shared/api';
import { markUnauthenticated } from '../../../shared/lib/auth-session';
import { toast } from '../../../shared/lib/toast';
import { timeAgo } from '../../../shared/lib/timeAgo';
import { EmptyState, ListSkeleton } from '../../../shared/components/LoadingState';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';

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
  const nav = useNavigate();
  const [confirmOthers, setConfirmOthers] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
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

  // Keeps this device signed in — only every OTHER session is ended.
  const revokeOthers = useMutation({
    mutationFn: () => api.delete<{ revokedCount: number }>('/profile/sessions'),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: ['profile', 'sessions'] });
      toast.success(data.revokedCount > 0 ? `Signed out of ${data.revokedCount} other device${data.revokedCount === 1 ? '' : 's'}.` : 'No other sessions to sign out of.');
      setConfirmOthers(false);
    },
    onError: () => {
      toast.error('Could not sign out other devices.');
      setConfirmOthers(false);
    },
  });

  // Ends every session, including this one — same client-side cleanup as a normal logout
  // (LogoutDialog.tsx), since the server has already revoked the token this tab is using too.
  const revokeAll = useMutation({
    mutationFn: () => withAuthLock(() => api.post('/profile/sessions/logout-all')),
    onSuccess: () => {
      markUnauthenticated();
      broadcastLogout();
      qc.clear();
      nav('/login');
    },
    onError: () => {
      toast.error('Could not sign out of all devices.');
      setConfirmAll(false);
    },
  });

  if (isLoading) return <ListSkeleton rows={3} />;

  const otherCount = sessions?.filter((s) => !s.isCurrentDevice).length ?? 0;

  return (
    <div>
      {!sessions?.length ? (
        <EmptyState compact variant="access" title="No active sessions" />
      ) : (
        sessions.map((s) => (
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
        ))
      )}
      {!!sessions?.length && (
        <div className="device-list-actions" style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-outline" onClick={() => setConfirmOthers(true)} disabled={otherCount === 0}>
            Sign out of all other devices
          </button>
          <button className="btn btn-outline" onClick={() => setConfirmAll(true)}>
            Sign out everywhere
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirmOthers}
        title="Sign out of all other devices?"
        description="This device stays signed in. Every other session is ended immediately."
        confirmLabel="Sign out others"
        destructive
        loading={revokeOthers.isPending}
        onConfirm={() => revokeOthers.mutate()}
        onCancel={() => setConfirmOthers(false)}
      />
      <ConfirmDialog
        open={confirmAll}
        title="Sign out everywhere?"
        description="This also signs out this device — you'll need to log in again."
        confirmLabel="Sign out everywhere"
        destructive
        loading={revokeAll.isPending}
        onConfirm={() => revokeAll.mutate()}
        onCancel={() => setConfirmAll(false)}
      />
    </div>
  );
}
