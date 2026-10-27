import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import { notifyApiError } from '../../../shared/lib/mutationFeedback';

interface Preferences {
  navPreference: string;
  timezone: string | null;
  dateFormat: string;
  timeFormat: string;
  firstDayOfWeek: string;
}

const TIMEZONES = [
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago',
  'America/Denver', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
  'Asia/Tokyo', 'Australia/Sydney', 'UTC',
];

export default function FormatsSection({ preferences }: { preferences: Preferences }) {
  const qc = useQueryClient();

  // One preference save at a time: the selects are disabled while a PATCH is in flight, so quick successive changes can
  // never land out of order. The select shows the server's value again after a failure (nothing was saved).
  const update = useMutation({
    mutationFn: (patch: Partial<Preferences>) => api.patch('/profile/preferences', patch),
    onSuccess: () => {
      toast.success('Preference saved.');
    },
    onError: (e) => { notifyApiError(e, { fallback: 'Could not save that preference. Please try again.' }); },
    onSettled: () => qc.invalidateQueries({ queryKey: ['profile', 'preferences'] }),
  });
  const saving = update.isPending;
  const change = (patch: Partial<Preferences>) => { if (!update.isPending) update.mutate(patch); };

  return (
    <>
      <div className="settings-section">
        <h3>Navigation</h3>
        <p>Choose where supported records/forms open by default.</p>
        <div className="field">
          <select aria-label="Navigation" disabled={saving} value={preferences.navPreference} onChange={(e) => change({ navPreference: e.target.value })}>
            <option value="side_panel">Side panel — open alongside the current page</option>
            <option value="full_page">Full page — open records on a dedicated page</option>
          </select>
        </div>
      </div>

      <div className="settings-section">
        <h3>Formats</h3>
        <p>Configure date, time, timezone and calendar start day.</p>
        <div className="form-grid">
          <div className="field">
            <label>Timezone</label>
            <select aria-label="Timezone" disabled={saving} value={preferences.timezone ?? ''} onChange={(e) => change({ timezone: e.target.value })}>
              <option value="">System setting — inherit workspace timezone</option>
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Date format</label>
            <select aria-label="Date format" disabled={saving} value={preferences.dateFormat} onChange={(e) => change({ dateFormat: e.target.value })}>
              <option value="DD/MM/YYYY">DD/MM/YYYY</option>
              <option value="MM/DD/YYYY">MM/DD/YYYY</option>
              <option value="YYYY-MM-DD">YYYY-MM-DD</option>
            </select>
          </div>
          <div className="field">
            <label>Time format</label>
            <select aria-label="Time format" disabled={saving} value={preferences.timeFormat} onChange={(e) => change({ timeFormat: e.target.value })}>
              <option value="24h">24-hour</option>
              <option value="12h">12-hour</option>
            </select>
          </div>
          <div className="field">
            <label>First day of week</label>
            <select aria-label="First day of week" disabled={saving} value={preferences.firstDayOfWeek} onChange={(e) => change({ firstDayOfWeek: e.target.value })}>
              <option value="monday">Monday</option>
              <option value="sunday">Sunday</option>
            </select>
          </div>
        </div>
      </div>
    </>
  );
}
