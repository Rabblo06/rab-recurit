import { useState } from 'react';
import GeneralTab from './GeneralTab';
import ConfigTab from './ConfigTab';
import HealthTab from './HealthTab';

type Tab = 'general' | 'config' | 'health';
const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'config', label: 'Config' },
  { id: 'health', label: 'Health' },
];

export default function AdminPanelPage() {
  const [tab, setTab] = useState<Tab>('general');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="viewbar" style={{ borderBottom: '1px solid var(--border-medium)' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`btn-ghost${tab === t.id ? ' active' : ''}`}
            style={tab === t.id ? { background: 'var(--bg-transparent-medium)', color: 'var(--font-primary)' } : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tab === 'general' && <GeneralTab />}
        {tab === 'config' && <ConfigTab />}
        {tab === 'health' && <HealthTab />}
      </div>
    </div>
  );
}
