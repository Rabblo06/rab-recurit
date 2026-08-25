import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';

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

  const update = useMutation({
    mutationFn: (patch: Partial<Preferences>) => api.patch('/profile/preferences', patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile', 'preferences'] });
      toast.success('Preference saved.');
    },
    onError: () => toast.error('Could not save that preference.'),
  });

  return (
    <>
      <div className="settings-section">
        <h3>Navigation</h3>
        <p>Choose where supported records/forms open by default.</p>
        <div className="field">
          <select value={preferences.navPreference} onChange={(e) => update.mutate({ navPreference: e.target.value })}>
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
            <select value={preferences.timezone ?? ''} onChange={(e) => update.mutate({ timezone: e.target.value })}>
              <option value="">System setting — inherit workspace timezone</option>
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Date format</label>
            <select value={preferences.dateFormat} onChange={(e) => update.mutate({ dateFormat: e.target.value })}>
              <option value="DD/MM/YYYY">DD/MM/YYYY</option>
              <option value="MM/DD/YYYY">MM/DD/YYYY</option>
              <option value="YYYY-MM-DD">YYYY-MM-DD</option>
            </select>
          </div>
          <div className="field">
            <label>Time format</label>
            <select value={preferences.timeFormat} onChange={(e) => update.mutate({ timeFormat: e.target.value })}>
              <option value="24h">24-hour</option>
              <option value="12h">12-hour</option>
            </select>
          </div>
          <div className="field">
            <label>First day of week</label>
            <select value={preferences.firstDayOfWeek} onChange={(e) => update.mutate({ firstDayOfWeek: e.target.value })}>
              <option value="monday">Monday</option>
              <option value="sunday">Sunday</option>
            </select>
          </div>
        </div>
      </div>
    </>
  );
}
