import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  IconCalendarStats,
  IconChevronRight,
  IconHash,
  IconLetterA,
  IconListDetails,
  IconMessageQuestion,
  IconPencilPlus,
  IconSearch,
  IconTable,
  IconToggleLeft,
  IconTrash,
} from '@tabler/icons-react';
import type { AiToolCatalogueEntryView, AiToolParameterView } from '@rab/shared';

import { aiKeys } from '../../ai/aiApi';
import { useAiChat } from '../../ai/AiChatProvider';
import { NotAvailableYet } from './AiReasonDialog';
import AiSetCrumb from './AiSetCrumb';
import { AiAppBadge, AiStepsIllustration } from './AiSkillsTab';
import { aiSettingsApi } from './aiSettingsApi';

/** The mockup's Kind pill, from the server's `kind` (fixed text; tone is decoration, the words carry the meaning). */
const KIND: Record<AiToolCatalogueEntryView['kind'], { pill: string; tone: 'neutral' | 'warn'; text: string; Icon: typeof IconTable }> = {
  read: { pill: 'Read', tone: 'neutral', text: 'Reads records with the signed-in person’s own permissions', Icon: IconTable },
  write: { pill: 'Write · approval', tone: 'warn', text: 'Write tools only run after the person approves the card', Icon: IconPencilPlus },
  meta: { pill: 'Built-in', tone: 'neutral', text: 'An assistant helper with no data access of its own', Icon: IconListDetails },
  pause: { pill: 'Built-in · asks you', tone: 'neutral', text: 'Pauses the answer to ask the person', Icon: IconMessageQuestion },
};

/**
 * Settings → AI → Tools (TWENTY_UI_INVENTORY E1–E17; U4 settings mockup), READ-ONLY: what the assistant can use, the
 * permission each tool needs and whether YOU hold it (server-resolved). No toggles, no "create tool" (tools are reviewed
 * code), no delete: built-in tools can't be deleted, which the tool page says next to a disabled button. Writes exist
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
  const open = (name: string | null) => {
    const next = new URLSearchParams(params);
    if (name) next.set('tool', name);
    else next.delete('tool');
    setParams(next);
  };

  if (tools.isLoading) return <p className="ai-set-muted" role="status">Loading tools…</p>;
  if (tools.isError) return <p className="ai-set-notice" role="alert">The tools could not be loaded. Refresh the page to try again.</p>;

  const detail = selected ? list.find((t) => t.name === selected) : undefined;
  if (selected && detail) return <AiToolDetail tool={detail} onBack={() => open(null)} />;

  return (
    <>
      <AiStepsIllustration lines={['Checked unfilled shifts', 'Thought for 2 s', 'Checked the fill rate', 'Thought for 1 s']} />
      <section className="settings-section" aria-labelledby="ai-tools-title">
        <h3 id="ai-tools-title">Tools</h3>
        <p>What the assistant can use. Each tool runs as the signed-in person, with their permissions. Changes always need approval.</p>
        <div className="ai-set-search">
          <IconSearch size={14} aria-hidden="true" />
          <label htmlFor={searchId} className="visually-hidden">Search tools</label>
          <input id={searchId} type="search" placeholder="Search a tool…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="table-container">
          <table className="table ai-set-table ai-set-table--links">
            <caption className="visually-hidden">Assistant tools</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col">Needs permission</th>
                <th scope="col">App</th>
                <th scope="col"><span className="visually-hidden">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => {
                const k = KIND[t.kind];
                return (
                  <tr key={t.name} data-tool={t.name} data-held={t.held ? 'true' : 'false'} onClick={() => open(t.name)}>
                    <td><span className="ai-set-skill"><k.Icon size={14} aria-hidden="true" /><strong>{t.label}</strong></span></td>
                    <td><span className="ai-pill" data-tone={k.tone}>{k.pill}</span></td>
                    <td>
                      {t.permission === null ? (
                        <span className="ai-set-muted">None needed</span>
                      ) : (
                        <span className="ai-set-perm">
                          <span>{t.permissionLabel ?? t.permission}</span>
                          {t.held ? <span className="ai-set-muted">You have it</span> : <span className="ai-set-missing">You don’t have this</span>}
                        </span>
                      )}
                    </td>
                    <td><AiAppBadge standard /></td>
                    <td className="ai-set-cell-end">
                      <button type="button" className="btn-icon" aria-label={`Open ${t.label}`} onClick={(e) => { e.stopPropagation(); open(t.name); }}>
                        <IconChevronRight size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
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

/**
 * E11–E17 / U4 tool page ("Tools › Unfilled shifts"), read-only: Parameters (CD-9, once the server describes them),
 * Description, Access (kind, permission, row cap; output fields are not in the contract → "Not available yet"), and a
 * Danger zone whose Delete is disabled because built-in tools can't be deleted.
 */
export function AiToolDetail({ tool, onBack }: { tool: AiToolCatalogueEntryView; onBack: () => void }) {
  const [filter, setFilter] = useState('');
  const params = tool.parameters;
  const shown = params && params.length > 6 && filter.trim() ? params.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase())) : params;
  const k = KIND[tool.kind];
  return (
    <>
      <AiSetCrumb parent="Tools" current={tool.label} onParent={onBack} headingId="ai-tool-title" />
      <section className="settings-section" aria-labelledby="ai-tool-title">
        <h3 id="ai-tool-title">{tool.label}</h3>
        <p><code className="ai-set-code">{tool.name}</code> · defined in Crewflow’s reviewed code; it can’t be edited here.</p>
        <h4 className="ai-set-subhead">Parameters</h4>
        <p className="ai-set-muted">Input this tool accepts. Its answers never include anyone’s private details beyond your permissions.</p>
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
                <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Notes</th></tr></thead>
                <tbody>
                  {(shown ?? []).map((p) => {
                    const Icon = TYPE_ICON[p.type];
                    return (
                      <tr key={p.name}>
                        <td><code className="ai-set-code">{p.name}</code></td>
                        <td><span className="ai-set-type"><Icon size={13} aria-hidden="true" />{TYPE_TEXT[p.type]}</span></td>
                        <td>{p.required ? 'Yes' : 'No'}</td>
                        <td className="ai-set-cell-muted">{[p.description, p.limits ?? (p.enumValues?.length ? p.enumValues.join(', ') : null)].filter(Boolean).join(' · ') || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <section className="settings-section" aria-labelledby="ai-tool-desc">
        <h3 id="ai-tool-desc">Description</h3>
        <p className="ai-set-readonly">{tool.summary || 'No description.'}</p>
      </section>
      <section className="settings-section" aria-labelledby="ai-tool-who">
        <h3 id="ai-tool-who">Access</h3>
        <p>The assistant uses this tool only for people who hold the permission below. Remove the permission from a role to stop the assistant using it for that role.</p>
        <div className="ai-set-rows">
          <div className="ai-set-row">
            <div className="ai-set-row-text"><strong>Kind</strong><span>{k.text}</span></div>
            <span className="ai-pill" data-tone={k.tone}>{k.pill}</span>
          </div>
          <div className="ai-set-row">
            <div className="ai-set-row-text"><strong>Needs permission</strong><span>Checked when listed, on every call{tool.requiresApproval ? ' and on approval' : ''}</span></div>
            <span className="ai-set-perm ai-set-perm--end">
              <span>{tool.permissionLabel ?? tool.permission ?? 'None needed'}</span>
              {tool.permission !== null && (tool.held ? <span className="ai-set-muted">You have it</span> : <span className="ai-set-missing">You don’t have this</span>)}
            </span>
          </div>
          {tool.maxRows !== null && (
            <div className="ai-set-row">
              <div className="ai-set-row-text"><strong>Rows per answer</strong><span>The most records one call can return</span></div>
              <span>{`At most ${tool.maxRows.toLocaleString('en-GB')}`}</span>
            </div>
          )}
          <div className="ai-set-row">
            <div className="ai-set-row-text"><strong>Output fields</strong><span>Allowlisted; everything else is removed before the assistant sees it</span></div>
            <span className="ai-set-muted">Not available yet</span>
          </div>
        </div>
      </section>
      <section className="settings-section" aria-labelledby="ai-tool-danger">
        <h3 id="ai-tool-danger">Danger zone</h3>
        <div className="ai-set-danger">
          <button type="button" className="btn btn-outline btn-sm ai-set-danger-btn" disabled aria-describedby="ai-tool-nodelete"><IconTrash size={14} aria-hidden="true" />Delete</button>
          <span id="ai-tool-nodelete" className="ai-set-muted">Built-in tools can’t be deleted.</span>
        </div>
      </section>
    </>
  );
}
