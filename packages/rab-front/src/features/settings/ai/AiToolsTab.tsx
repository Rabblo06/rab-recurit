import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { IconArrowLeft, IconCalendarStats, IconChevronRight, IconHash, IconLetterA, IconSearch, IconToggleLeft } from '@tabler/icons-react';
import type { AiToolCatalogueEntryView, AiToolParameterView } from '@rab/shared';

import { aiKeys } from '../../ai/aiApi';
import { useAiChat } from '../../ai/AiChatProvider';
import { NotAvailableYet } from './AiReasonDialog';
import { AiStepsIllustration } from './AiSkillsTab';
import { aiSettingsApi } from './aiSettingsApi';

const KIND_TEXT: Record<AiToolCatalogueEntryView['kind'], string> = {
  read: 'Reads',
  write: 'Suggests a change (you approve)',
  meta: 'Assistant helper',
  pause: 'Asks you',
};

/**
 * Settings → AI → Tools (TWENTY_UI_INVENTORY E1–E17), READ-ONLY: what the assistant can read, the permission each tool
 * needs and whether YOU hold it (server-resolved). There is no write control here at all — no toggles, no "create
 * tool", no "see function", no delete: tools are reviewed code, and who can use one is a role's business. Writes exist
 * only as proposals a person approves (Phase 5). All text is server text rendered as plain text.
 */
export default function AiToolsTab() {
  const { scope } = useAiChat();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const searchId = useId();
  const tools = useQuery({ queryKey: aiKeys.settingsArea(scope, 'tools'), queryFn: aiSettingsApi.tools, retry: false });
  const selected = params.get('tool');
  const list = tools.data?.tools ?? [];
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? list.filter((t) => `${t.label} ${t.name} ${t.permissionLabel ?? ''}`.toLowerCase().includes(q)) : list;
  }, [filter, list]);

  if (tools.isLoading) return <p className="ai-set-muted" role="status">Loading tools…</p>;
  if (tools.isError) return <p className="ai-set-notice" role="alert">The tools could not be loaded. Refresh the page to try again.</p>;

  const detail = selected ? list.find((t) => t.name === selected) : undefined;
  if (selected && detail) {
    return <AiToolDetail tool={detail} onBack={() => { const next = new URLSearchParams(params); next.delete('tool'); setParams(next); }} />;
  }

  return (
    <>
    <AiStepsIllustration lines={['Thought for 2 s', 'Checking unfilled shifts…', 'Found 12 unfilled shifts', 'Thought for 1 s']} />
    <section className="settings-section" aria-labelledby="ai-tools-title">
      <h3 id="ai-tools-title">Tools</h3>
      <p>What the assistant can read on your behalf, within your own permissions. Changes are only ever suggested for a person to approve.</p>
      <div className="ai-set-search">
        <IconSearch size={14} aria-hidden="true" />
        <label htmlFor={searchId} className="visually-hidden">Search tools</label>
        <input id={searchId} type="search" placeholder="Search tools…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="table-container">
        <table className="table ai-set-table">
          <caption className="visually-hidden">Assistant tools</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Permission needed</th>
              <th scope="col">You have it</th>
              <th scope="col"><span className="visually-hidden">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.name} data-tool={t.name} data-held={t.held ? 'true' : 'false'}>
                <td><strong>{t.label}</strong></td>
                <td><span className="badge ai-set-kind">{KIND_TEXT[t.kind]}</span></td>
                <td>{t.permissionLabel ?? t.permission ?? '—'}</td>
                <td>{t.permission === null ? '—' : t.held ? 'Yes' : <span className="ai-set-missing">You don’t have this</span>}</td>
                <td>
                  <button type="button" className="btn-icon" aria-label={`Open ${t.label}`} onClick={() => { const next = new URLSearchParams(params); next.set('tool', t.name); setParams(next); }}>
                    <IconChevronRight size={15} />
                  </button>
                </td>
              </tr>
            ))}
            {!shown.length && (
              <tr><td colSpan={5} className="ai-set-muted">{list.length ? 'No tool matches your search.' : 'No tools are available.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
    </>
  );
}

const TYPE_ICON: Record<AiToolParameterView['type'], typeof IconLetterA> = {
  string: IconLetterA,
  uuid: IconLetterA,
  enum: IconToggleLeft,
  boolean: IconToggleLeft,
  integer: IconHash,
  number: IconHash,
  date: IconCalendarStats,
  array: IconHash,
};
const TYPE_TEXT: Record<AiToolParameterView['type'], string> = { string: 'Text', uuid: 'Identifier', enum: 'Choice', boolean: 'Yes / no', integer: 'Whole number', number: 'Number', date: 'Date', array: 'List' };

/** E11–E17: one tool, read-only. Parameters (CD-9) appear once the server describes them. */
export function AiToolDetail({ tool, onBack }: { tool: AiToolCatalogueEntryView; onBack: () => void }) {
  const [filter, setFilter] = useState('');
  const params = tool.parameters;
  const shown = params && params.length > 6 && filter.trim() ? params.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase())) : params;
  return (
    <>
      <button type="button" className="ai-set-back" onClick={onBack}><IconArrowLeft size={14} aria-hidden="true" />All tools</button>
      <section className="settings-section" aria-labelledby="ai-tool-title">
        <h3 id="ai-tool-title">{tool.label}</h3>
        <p>{KIND_TEXT[tool.kind]}{tool.maxRows ? ` · at most ${tool.maxRows} rows per answer` : ''}</p>
        <h4 className="ai-set-subhead">Description</h4>
        <p className="ai-set-readonly">{tool.summary || 'No description.'}</p>
        <p className="ai-set-muted">Defined in Crewflow’s reviewed code. It can’t be edited here.</p>
      </section>
      <section className="settings-section" aria-labelledby="ai-tool-params">
        <h3 id="ai-tool-params">Parameters</h3>
        <p>What the assistant can ask this tool for. Its answers never include anyone’s private details beyond your permissions.</p>
        {!params ? (
          <NotAvailableYet>Parameter details arrive with the tools release.</NotAvailableYet>
        ) : (
          <>
            {params.length > 6 && (
              <div className="ai-set-search">
                <IconSearch size={14} aria-hidden="true" />
                <input type="search" aria-label="Search parameters" placeholder="Search parameters…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
            )}
            <div className="table-container">
              <table className="table ai-set-table">
                <caption className="visually-hidden">Parameters</caption>
                <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Limits</th></tr></thead>
                <tbody>
                  {(shown ?? []).map((p) => {
                    const Icon = TYPE_ICON[p.type];
                    return (
                      <tr key={p.name}>
                        <td title={p.description}>{p.name}</td>
                        <td><span className="ai-set-type"><Icon size={13} aria-hidden="true" />{TYPE_TEXT[p.type]}</span></td>
                        <td>{p.required ? 'Yes' : 'No'}</td>
                        <td>{p.limits ?? (p.enumValues?.length ? p.enumValues.join(', ') : '—')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <section className="settings-section" aria-labelledby="ai-tool-who">
        <h3 id="ai-tool-who">Who can use it</h3>
        <p>The assistant uses this tool only for people who hold the permission below. Remove the permission from a role to stop the assistant using it for that role.</p>
        <dl className="ai-set-facts">
          <div><dt>Permission</dt><dd>{tool.permissionLabel ?? tool.permission ?? 'None needed'}</dd></div>
          <div><dt>You have it</dt><dd>{tool.permission === null ? '—' : tool.held ? 'Yes' : 'No'}</dd></div>
          {tool.requiresApproval && <div><dt>Approval</dt><dd>Every change is a suggestion a person approves</dd></div>}
        </dl>
      </section>
    </>
  );
}
