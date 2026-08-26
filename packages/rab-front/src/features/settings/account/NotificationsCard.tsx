import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import { EmptyState, ListSkeleton } from '../../../shared/components/LoadingState';

interface NotificationPreference {
  notificationType: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
}

const LABELS: Record<string, string> = {
  offer_sent: 'An offer is sent to me',
  offer_expired: 'An offer I sent expires unanswered',
  offer_accepted: 'A staff member accepts my offer',
  offer_declined: 'A staff member declines my offer',
  offer_confirmed: 'An offer I accepted is confirmed',
  offer_rejected: 'An offer I accepted is rejected',
};

export default function NotificationsCard() {
  const qc = useQueryClient();
  const { data: prefs, isLoading } = useQuery({
    queryKey: ['profile', 'notification-preferences'],
    queryFn: async () => (await api.get<NotificationPreference[]>('/profile/notification-preferences')).data,
  });

  const update = useMutation({
    mutationFn: (patch: NotificationPreference) => api.patch('/profile/notification-preferences', patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile', 'notification-preferences'] }),
    onError: () => toast.error('Could not save that preference.'),
  });

  if (isLoading) return <ListSkeleton rows={6} />;
  if (!prefs?.length) return <EmptyState compact variant="inbox" title="No notification preferences" />;

  return (
    <div>
      {(prefs ?? []).map((p) => (
        <div key={p.notificationType} className="settings-row">
          <span>{LABELS[p.notificationType] ?? p.notificationType}</span>
          <div style={{ display: 'flex', gap: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={p.inAppEnabled}
                onChange={(e) => update.mutate({ ...p, inAppEnabled: e.target.checked })}
              />
              In-app
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={p.emailEnabled}
                onChange={(e) => update.mutate({ ...p, emailEnabled: e.target.checked })}
              />
              Email
            </label>
          </div>
        </div>
      ))}
    </div>
  );
}
