import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBell, IconCheck } from '@tabler/icons-react';
import { api } from '../../shared/api';
import { timeAgo } from '../../shared/lib/timeAgo';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

/**
 * In-app only — polling (React Query `refetchInterval`), no push/WebSocket
 * (explicit scope decision this session). Self-contained: owns its own
 * open state and positions its dropdown relative to itself, unlike
 * `AdminDropdown` (externally controlled, positioned against `.app-layout`).
 */
export default function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: async () => { const { data } = await api.get<{ count: number }>('/notifications/unread-count'); return data; },
    refetchInterval: 30000,
  });

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: async () => { const { data } = await api.get<NotificationItem[]>('/notifications'); return data; },
    enabled: open,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const markAllRead = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const count = unread?.count ?? 0;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn btn-outline" style={{ position: 'relative', gap: 6 }} onClick={() => setOpen((v) => !v)} title="Notifications">
        <IconBell size={14} />
        {count > 0 && (
          <span
            style={{
              position: 'absolute', top: -4, right: -4, minWidth: 15, height: 15, padding: '0 3px',
              borderRadius: 999, background: 'var(--color-red)', color: '#fff', fontSize: 10, fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
            }}
          >
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="dropdown-menu" style={{ top: 'calc(100% + 6px)', left: 'auto', right: 0, minWidth: 320, padding: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid var(--border-light)' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Notifications</span>
            <div style={{ flex: 1 }} />
            {count > 0 && (
              <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 6px' }} onClick={() => markAllRead.mutate()}>
                <IconCheck size={12} />
                Mark all read
              </button>
            )}
          </div>
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {notifications.length === 0 && (
              <p className="muted" style={{ padding: 16, fontSize: 12, textAlign: 'center' }}>No notifications yet.</p>
            )}
            {notifications.map((n) => (
              <button
                key={n.id}
                className="dropdown-item"
                style={{
                  flexDirection: 'column', alignItems: 'flex-start', gap: 2, whiteSpace: 'normal', textAlign: 'left',
                  background: n.readAt ? undefined : 'var(--bg-transparent-light)',
                }}
                onClick={() => { if (!n.readAt) markRead.mutate(n.id); }}
              >
                <span style={{ fontSize: 13, fontWeight: 500 }}>{n.title}</span>
                <span style={{ fontSize: 12, color: 'var(--font-secondary)' }}>{n.message}</span>
                <span style={{ fontSize: 11, color: 'var(--font-tertiary)' }}>{timeAgo(n.createdAt)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
