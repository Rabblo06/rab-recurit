import { useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '../../../shared/api';
import { adminApi, type AdminTab } from './adminPanelApi';
import AuditTab from './AuditTab';
import ConfigTab from './ConfigTab';
import GeneralTab from './GeneralTab';
import HealthTab, { HEALTH_REFETCH_MS } from './HealthTab';
import SecurityTab from './SecurityTab';
import WorkspacesTab from './WorkspacesTab';
import './admin-panel.css';

export const ADMIN_TAB_STORAGE_KEY = 'cf-admin-tab';
const TABS: Array<{ id: AdminTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'health', label: 'Health' },
  { id: 'config', label: 'Config' },
  { id: 'security', label: 'Security' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'audit', label: 'Audit' },
];

function readTab(): AdminTab {
  try {
    const saved = window.localStorage.getItem(ADMIN_TAB_STORAGE_KEY);
    if (saved && TABS.some((t) => t.id === saved)) return saved as AdminTab;
  } catch {
    // storage blocked (private window, previews): default tab
  }
  return 'general';
}

interface Me {
  id: string;
  organisationId: string;
}

/**
 * Crewflow Platform Admin Panel — six tabs (owner design docs/design/crewflow-admin-panel-mockup.html v2):
 * General | Health | Config | Security | Workspaces | Audit. Platform administrators only (`PlatformAdminRoute`; every
 * route is PlatformAdminGuard + service re-check server-side). The selected tab is a presentation preference only,
 * remembered in localStorage (`cf-admin-tab`, try/catch). Every number on every tab comes from the server.
 * Organisation creation is NOT here (owner correction 2026-10-23): Settings → Members → Add (email-only CEO invitation).
 */
export default function AdminPanelPage() {
  const [tab, setTab] = useState<AdminTab>(readTab);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get<Me>('/auth/me')).data, staleTime: 5 * 60 * 1000 });
  const config = useQuery({ queryKey: ['admin', 'config'], queryFn: adminApi.config });
  const health = useQuery({ queryKey: ['admin', 'health'], queryFn: adminApi.health, refetchInterval: HEALTH_REFETCH_MS });
  const myOrg = useQuery({
    queryKey: ['admin', 'org-summary', me?.organisationId],
    queryFn: () => adminApi.organisationSummary(me!.organisationId),
    enabled: Boolean(me?.organisationId),
    staleTime: 60_000,
  });

  function select(id: AdminTab, focus = false) {
    setTab(id);
    try {
      window.localStorage.setItem(ADMIN_TAB_STORAGE_KEY, id);
    } catch {
      // presentation preference only
    }
    if (focus) tabRefs.current[id]?.focus();
  }

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    select(TABS[next]!.id, true);
  }

  const attention = typeof health.data?.attention === 'number' ? health.data.attention : 0;
  const maintenanceOn = config.data?.maintenanceMode?.enabled === true;

  return (
    <div className="ap-root">
      <div className="ap-page-header">
        <h1 className="ap-page-title">Admin panel</h1>
      </div>
      {maintenanceOn && (
        <div className="ap-maint" role="status">
          Maintenance mode is on for your organisation{myOrg.data ? ` (${myOrg.data.name})` : ''}. Non-admin users see a maintenance message.{' '}
          <button type="button" className="ap-btn ap-sm" onClick={() => select('config')}>Manage</button>
        </div>
      )}
      <div className="ap-viewbar" role="tablist" aria-label="Admin panel sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            id={`ap-tab-${t.id}`}
            type="button"
            role="tab"
            className="ap-tab"
            aria-selected={tab === t.id}
            aria-controls={tab === t.id ? `ap-panel-${t.id}` : undefined}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => select(t.id)}
            onKeyDown={onTabKey}
          >
            {t.label}
            {t.id === 'health' && attention > 0 && <span className="ap-count" aria-label={`${attention} need attention`}>{attention}</span>}
          </button>
        ))}
      </div>
      <div className="ap-content">
        <div className="ap-panel" role="tabpanel" id={`ap-panel-${tab}`} aria-labelledby={`ap-tab-${tab}`}>
          {tab === 'general' && <GeneralTab meId={me?.id} />}
          {tab === 'health' && <HealthTab />}
          {tab === 'config' && <ConfigTab organisationName={myOrg.data?.name} />}
          {tab === 'security' && <SecurityTab />}
          {tab === 'workspaces' && <WorkspacesTab />}
          {tab === 'audit' && <AuditTab />}
        </div>
      </div>
    </div>
  );
}
