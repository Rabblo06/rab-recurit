import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import { notifyApiError } from '../../../shared/lib/mutationFeedback';
import { EmptyState, ListSkeleton } from '../../../shared/components/LoadingState';

interface NotificationPreference {
  notificationType: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
}

type Channel = 'inAppEnabled' | 'emailEnabled';

/** One toggle: `PATCH /profile/notification-preferences` with ONLY the changed field (the server keeps the other one). */
interface PreferencePatch {
  notificationType: string;
  field: Channel;
  value: boolean;
}

const LABELS: Record<string, string> = {
  offer_sent: 'An offer is sent to me',
  offer_expired: 'An offer I sent expires unanswered',
  offer_accepted: 'A staff member accepts my offer',
  offer_declined: 'A staff member declines my offer',
  offer_confirmed: 'An offer I accepted is confirmed',
  offer_rejected: 'An offer I accepted is rejected',
};

const CHANNEL_LABEL: Record<Channel, string> = { inAppEnabled: 'In-app', emailEnabled: 'Email' };

export const NOTIFICATION_PREFERENCES_KEY = ['profile', 'notification-preferences'] as const;


/**
 * Account → Notifications. Each checkbox saves on its own:
 *  - the request carries only `{ notificationType, <changed field> }` (`UpdateNotificationPreferenceDto` makes both
 *    channels optional and the server keeps the other one), so a quick in-app toggle and email toggle on the same row can
 *    never overwrite each other with a stale copy of the row;
 *  - toggles are SERIALISED per row (synchronous guard): while one PATCH for a row is in flight, both of that row's
 *    checkboxes are disabled and the one being saved says "Saving…". The server's update is a read-modify-write of both
 *    columns, so two concurrent PATCHes for one row could otherwise still race there. A checkbox only moves when the
 *    server answers (the confirmed row is written to the cache, then refetched);
 *  - success is a short confirmation after the server's answer; a failure is one red toast with the reason and, when a
 *    retry can help, "Try again". The checkbox stays where the server has it.
 */
export default function NotificationsCard() {
  const qc = useQueryClient();
  const { data: prefs, isLoading } = useQuery({
    queryKey: NOTIFICATION_PREFERENCES_KEY,
    queryFn: async () => (await api.get<NotificationPreference[]>('/profile/notification-preferences')).data,
  });
  /** notificationType → the channel being saved for that row (at most one request per row). */
  const inFlight = useRef(new Map<string, Channel>());
  const [saving, setSaving] = useState<ReadonlyMap<string, Channel>>(new Map());

  const markSaving = (patch: PreferencePatch, on: boolean) => {
    if (on) inFlight.current.set(patch.notificationType, patch.field);
    else inFlight.current.delete(patch.notificationType);
    setSaving(new Map(inFlight.current));
  };

  const update = useMutation({
    mutationFn: async (patch: PreferencePatch) =>
      (
        await api.patch<NotificationPreference>('/profile/notification-preferences', {
          notificationType: patch.notificationType,
          [patch.field]: patch.value,
        })
      ).data,
    onSuccess: (saved, patch) => {
      // The server's confirmed row (both channels as stored) replaces the cached one; then a background refetch.
      if (saved && saved.notificationType === patch.notificationType) {
        qc.setQueryData<NotificationPreference[]>(NOTIFICATION_PREFERENCES_KEY, (rows) =>
          rows?.map((row) => (row.notificationType === saved.notificationType ? { ...row, ...saved } : row)),
        );
      }
      void qc.invalidateQueries({ queryKey: NOTIFICATION_PREFERENCES_KEY });
      toast.success('Notification preference saved.');
    },
    onError: (error, patch) => {
      notifyApiError(error, {
        fallback: 'Could not save that preference. Please try again.',
        retry: () => save(patch),
      });
    },
    onSettled: (_data, _error, patch) => markSaving(patch, false),
  });

  function save(patch: PreferencePatch): void {
    if (inFlight.current.has(patch.notificationType)) return;
    markSaving(patch, true);
    update.mutate(patch);
  }

  if (isLoading) return <ListSkeleton rows={6} />;
  if (!prefs?.length) return <EmptyState compact variant="inbox" title="No notification preferences" />;

  return (
    <div>
      {(prefs ?? []).map((p) => {
        const label = LABELS[p.notificationType] ?? p.notificationType;
        const rowSaving = saving.get(p.notificationType);
        return (
          <div key={p.notificationType} className="settings-row">
            <span>{label}</span>
            <div style={{ display: 'flex', gap: 14 }}>
              {(['inAppEnabled', 'emailEnabled'] as const).map((field) => {
                const busy = rowSaving === field;
                return (
                  <label key={field} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={p[field]}
                      disabled={rowSaving !== undefined}
                      aria-busy={busy || undefined}
                      aria-label={`${CHANNEL_LABEL[field]}: ${label}`}
                      onChange={(e) => save({ notificationType: p.notificationType, field, value: e.target.checked })}
                    />
                    {busy ? 'Saving…' : CHANNEL_LABEL[field]}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
