import { useRef, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { IconBook, IconChartBar, IconCpu, IconLayoutDashboard, IconRobot, IconTerminal2, IconTool } from '@tabler/icons-react';
import type { AiSettingsOverview } from '@rab/shared';

import { aiKeys } from '../../ai/aiApi';
import { useAiChat } from '../../ai/AiChatProvider';
import { useAiAvailability } from '../../ai/useAiAvailability';
import AiAgentsTab from './agents/AiAgentsTab';
import AiModelsTab from './AiModelsTab';
import AiOverviewTab from './AiOverviewTab';
import AiPromptTab from './AiPromptTab';
import { aiSettingsApi } from './aiSettingsApi';
import AiSkillsTab from './AiSkillsTab';
import AiToolsTab from './AiToolsTab';
import AiUsageTab from './AiUsageTab';
import './ai-settings.css';

export type AiSettingsTab = 'overview' | 'models' | 'skills' | 'tools' | 'usage' | 'prompt' | 'agents';

const TAB_DEFS: Array<{ id: AiSettingsTab; label: string; Icon: typeof IconCpu; shown: (f: AiSettingsOverview['features']) => boolean }> = [
  { id: 'overview', label: 'Overview', Icon: IconLayoutDashboard, shown: () => true },
  { id: 'models', label: 'Models', Icon: IconCpu, shown: () => true },
  { id: 'skills', label: 'Skills', Icon: IconBook, shown: (f) => f.skills },
  { id: 'tools', label: 'Tools', Icon: IconTool, shown: (f) => f.tools },
  { id: 'usage', label: 'Usage', Icon: IconChartBar, shown: (f) => f.usage },
  { id: 'prompt', label: 'Prompt', Icon: IconTerminal2, shown: (f) => f.promptPreview },
  { id: 'agents', label: 'Agents', Icon: IconRobot, shown: (f) => f.agents },
];

/** The tabs this server serves (A1–A2): a tab whose API does not exist on the server is not rendered at all. */
export function visibleTabs(features: AiSettingsOverview['features']) {
  return TAB_DEFS.filter((t) => t.shown(features));
}

/**
 * Settings → AI (`/settings/ai?tab=…`; `CeoRoute` in App.tsx; docs/ai/PHASE8_TWENTY_PLAN.md §2.1, TWENTY_UI_INVENTORY A–J).
 * Shown only while the organisation's AI is on (D8-6: `useAiAvailability().eligible`); nothing is fetched otherwise. The
 * tab list comes from `GET /ai/settings` `features` — the browser never guesses which APIs exist and decides no
 * permission: it hides what the server would refuse. Tabs follow the Admin Panel pattern (`role="tablist"`, roving
 * tabindex, Left/Right/Home/End), and the selected tab lives in the URL so it can be linked.
 */
export default function AiSettingsPage() {
  const { scope } = useAiChat();
  const availability = useAiAvailability();
  const [params, setParams] = useSearchParams();
  const tabRefs = useRef<Partial<Record<AiSettingsTab, HTMLButtonElement | null>>>({});
  const overview = useQuery({ queryKey: aiKeys.settingsArea(scope, 'overview'), queryFn: aiSettingsApi.overview, enabled: availability.eligible, retry: false });

  if (availability.isLoading) return <div className="settings-page ai-settings"><p className="ai-set-muted" role="status">Loading AI settings…</p></div>;
  if (!availability.eligible) {
    return (
      <div className="settings-page ai-settings">
        <section className="settings-section">
          <h3>AI</h3>
          <p>The AI assistant is not available for your organisation, so there is nothing to set up here.</p>
        </section>
      </div>
    );
  }
  if (overview.isLoading) return <div className="settings-page ai-settings"><p className="ai-set-muted" role="status">Loading AI settings…</p></div>;
  if (overview.isError || !overview.data) {
    return (
      <div className="settings-page ai-settings">
        <section className="settings-section">
          <h3>AI</h3>
          <p role="alert">AI settings could not be loaded. Only your organisation’s CEO can open them. Refresh the page to try again.</p>
        </section>
      </div>
    );
  }

  const data = overview.data;
  const tabs = visibleTabs(data.features);
  const requested = params.get('tab') as AiSettingsTab | null;
  const tab: AiSettingsTab = requested && tabs.some((t) => t.id === requested) ? requested : 'overview';

  const select = (id: AiSettingsTab, focus = false) => {
    const next = new URLSearchParams(params);
    next.set('tab', id);
    next.delete('tool');
    next.delete('skill');
    next.delete('agent');
    setParams(next, { replace: false });
    if (focus) tabRefs.current[id]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    select(tabs[next]!.id, true);
  };

  return (
    <div className="ai-settings ai-settings-root">
      <div className="ai-set-tabs" role="tablist" aria-label="AI settings">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            id={`ai-tab-${id}`}
            type="button"
            role="tab"
            className="ai-set-tab"
            aria-selected={tab === id}
            aria-controls={tab === id ? `ai-panel-${id}` : undefined}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => select(id)}
            onKeyDown={onKey}
          >
            <Icon size={15} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      <div className="settings-page ai-set-panel" role="tabpanel" id={`ai-panel-${tab}`} aria-labelledby={`ai-tab-${tab}`}>
        {tab === 'overview' && <AiOverviewTab overview={data} onOpenPrompt={() => select('prompt')} />}
        {tab === 'models' && <AiModelsTab features={data.features} />}
        {tab === 'skills' && <AiSkillsTab />}
        {tab === 'tools' && <AiToolsTab />}
        {tab === 'usage' && <AiUsageTab />}
        {tab === 'prompt' && <AiPromptTab />}
        {tab === 'agents' && <AiAgentsTab features={data.features} />}
      </div>
    </div>
  );
}
