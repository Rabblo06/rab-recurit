import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import AppearanceSection from './AppearanceSection';
import FormatsSection from './FormatsSection';

interface Preferences {
  theme: string;
  navPreference: string;
  timezone: string | null;
  dateFormat: string;
  timeFormat: string;
  firstDayOfWeek: string;
}

type Scale = 'compact' | 'default' | 'comfortable';
const SCALE_KEY = 'interfaceScale';

function getScale(): Scale {
  return (localStorage.getItem(SCALE_KEY) as Scale) || 'default';
}

function applyScale(scale: Scale) {
  if (scale === 'default') document.documentElement.removeAttribute('data-scale');
  else document.documentElement.setAttribute('data-scale', scale);
  localStorage.setItem(SCALE_KEY, scale);
}

export default function ExperiencePage() {
  const { data: preferences, isLoading } = useQuery({
    queryKey: ['profile', 'preferences'],
    queryFn: async () => (await api.get<Preferences>('/profile/preferences')).data,
  });
  const [scale, setScale] = useState<Scale>(getScale());

  if (isLoading || !preferences) {
    return <div className="settings-page"><p className="muted">Loading…</p></div>;
  }

  return (
    <div className="settings-page">
      <AppearanceSection />

      <div className="settings-section">
        <h3>Interface</h3>
        <p>Select your language and adjust the size of the interface.</p>
        <div className="form-grid">
          <div className="field">
            <label>Language</label>
            <select disabled value="en">
              <option value="en">English</option>
            </select>
          </div>
          <div className="field">
            <label>Scale</label>
            <select value={scale} onChange={(e) => { const v = e.target.value as Scale; applyScale(v); setScale(v); }}>
              <option value="compact">Compact</option>
              <option value="default">Default — 100%</option>
              <option value="comfortable">Comfortable</option>
            </select>
          </div>
        </div>
      </div>

      <FormatsSection preferences={preferences} />
    </div>
  );
}
