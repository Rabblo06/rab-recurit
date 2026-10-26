import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { AI_PROMPT_SECTION_KEYS, AI_PROMPT_SECTION_SEPARATOR, type AiPromptPreviewView, type AiPromptSectionKey } from '@rab/shared';

import { aiKeys } from '../../ai/aiApi';
import { useAiChat } from '../../ai/AiChatProvider';
import { NotAvailableYet } from './AiReasonDialog';
import AiSetCrumb from './AiSetCrumb';
import { aiSettingsApi } from './aiSettingsApi';

const about = (e: { estimate: number; upperBound: number }) => `about ${e.estimate.toLocaleString('en-GB')} tokens (at most ${e.upperBound.toLocaleString('en-GB')})`;

interface Block {
  key: string;
  title: string;
  note: string;
  text: string;
  /** Shown instead of `text` (a state, never prompt content). */
  empty?: 'none_on' | 'not_available';
}

const SKILLS_ORDER = AI_PROMPT_SECTION_KEYS.indexOf('skills');
const keyOrder = (k: string) => {
  const i = AI_PROMPT_SECTION_KEYS.indexOf(k as AiPromptSectionKey);
  return i < 0 ? AI_PROMPT_SECTION_KEYS.length : i;
};

/**
 * U4 / S9: the skill catalogue always has its own block. When the server's sections include it, that section IS the
 * block. Otherwise the `skillCatalogue` lines (S9 fills them from the live prompt's own builder) are shown; with none, the
 * block says why — no skill on (`activeSkills === 0`), or the server doesn't send the list yet. Never a made-up list.
 */
export function withSkillCatalogue(blocks: Block[], view: AiPromptPreviewView, activeSkills: number | null): Block[] {
  if (blocks.some((b) => b.key === 'skills')) return blocks;
  const lines = view.skillCatalogue ?? [];
  const block: Block = lines.length
    ? { key: 'skills', title: 'Skill catalogue', note: 'Read-only · active skills only', text: lines.join('\n') }
    : { key: 'skills', title: 'Skill catalogue', note: 'Read-only · active skills only', text: '', empty: activeSkills === 0 ? 'none_on' : 'not_available' };
  const at = blocks.findIndex((b) => keyOrder(b.key) > SKILLS_ORDER);
  return at < 0 ? [...blocks, block] : [...blocks.slice(0, at), block, ...blocks.slice(at)];
}

/** The blocks to show: the server's ordered sections (CD-5) when present, else the C0 fields as they are. */
export function promptBlocks(view: AiPromptPreviewView): Block[] {
  if (view.sections?.length) {
    return view.sections.map((s) => ({ key: s.key, title: s.title, note: `Read-only · ${about(s.tokenEstimate)}`, text: s.text }));
  }
  const blocks: Block[] = [{ key: 'rules', title: 'Crewflow rules', note: 'Read-only', text: view.systemPrompt }];
  if (view.skillCatalogue.length) blocks.push({ key: 'skills', title: 'Skill catalogue', note: 'Read-only · active skills only', text: view.skillCatalogue.join('\n') });
  if (view.toolCatalogue.length) blocks.push({ key: 'tools', title: 'Tools you’d be offered', note: 'Read-only', text: view.toolCatalogue.map((t) => `${t.name}: ${t.summary}`).join('\n') });
  return blocks;
}

/**
 * Settings → AI → Overview › System prompt (TWENTY_UI_INVENTORY F1–F12, D8-3; U4: a page under Overview with a
 * breadcrumb, as in the settings mockup): exactly what the assistant is told before YOUR next question, built by the
 * server from the same functions the model call uses. PLAIN TEXT ONLY — never Markdown, never HTML: a `<script>` or a
 * fake instruction in it is shown as the characters it is. Read-only: no send, no "try it" (rule 10.5). The token
 * figures are local estimates. Opening this page is audited.
 */
export default function AiPromptTab({ activeSkills = null, onBack }: { activeSkills?: number | null; onBack?: () => void }) {
  const { scope } = useAiChat();
  const preview = useQuery({ queryKey: aiKeys.settingsArea(scope, 'prompt'), queryFn: aiSettingsApi.promptPreview, retry: false, staleTime: 5 * 60_000 });
  const [copied, setCopied] = useState<'' | 'Copied' | 'Could not copy'>('');

  const crumb = onBack ? <AiSetCrumb parent="Overview" current="System prompt" onParent={onBack} headingId={preview.data ? 'ai-prompt-head' : undefined} /> : null;
  if (preview.isLoading) return <>{crumb}<p className="ai-set-muted" role="status">Loading the system prompt…</p></>;
  if (preview.isError || !preview.data) return <>{crumb}<p className="ai-set-notice" role="alert">The system prompt could not be shown. Refresh the page to try again.</p></>;
  const view = preview.data;
  const blocks = withSkillCatalogue(promptBlocks(view), view, activeSkills);
  const total = view.totalTokenEstimate ?? view.tokenEstimate;
  const fullText = view.sections?.length ? view.sections.map((s) => s.text).join(AI_PROMPT_SECTION_SEPARATOR) : blocks.filter((b) => !b.empty).map((b) => b.text).join('\n\n');

  return (
    <>
      {crumb}
      <section className="settings-section" aria-labelledby="ai-prompt-head">
        <div className="ai-set-headrow">
          <div>
            <h3 id="ai-prompt-head">System prompt</h3>
            <p>What the assistant is told before every question you ask — {about(total)}. Personal details, your conversations and records are never part of it.</p>
          </div>
          <div className="ai-set-actions">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(fullText);
                  setCopied('Copied');
                } catch {
                  setCopied('Could not copy');
                }
              }}
            >
              {copied === 'Copied' ? <IconCheck size={14} aria-hidden="true" /> : <IconCopy size={14} aria-hidden="true" />} Copy
            </button>
            <span role="status" className={copied === 'Copied' ? 'feedback-success' : copied ? 'feedback-error' : undefined}>{copied}</span>
          </div>
        </div>
        <dl className="ai-set-facts">
          <div><dt>Prompt version</dt><dd>{view.promptVersion}</dd></div>
          <div><dt>Prompt caching</dt><dd>{view.promptCache === 'none' ? 'Off' : 'On (demo data only)'}</dd></div>
        </dl>
      </section>
      {blocks.map((b) => (
        <section key={b.key} className="settings-section" aria-labelledby={`ai-prompt-${b.key}`}>
          <h3 id={`ai-prompt-${b.key}`}>{b.title}</h3>
          <p>{b.note}</p>
          {b.empty === 'none_on' ? (
            <p className="ai-set-pending" role="note">No skill is switched on, so the assistant is given no skill list.</p>
          ) : b.empty === 'not_available' ? (
            <NotAvailableYet>This server doesn’t send the list of skills the assistant can load yet.</NotAvailableYet>
          ) : (
            <pre className="ai-prompt-text" data-section={b.key}>{b.text}</pre>
          )}
        </section>
      ))}
    </>
  );
}
