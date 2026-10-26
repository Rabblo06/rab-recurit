import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { AI_PROMPT_SECTION_SEPARATOR, type AiPromptPreviewView } from '@rab/shared';

import { aiKeys } from '../../ai/aiApi';
import { useAiChat } from '../../ai/AiChatProvider';
import { aiSettingsApi } from './aiSettingsApi';

const about = (e: { estimate: number; upperBound: number }) => `about ${e.estimate.toLocaleString('en-GB')} tokens (at most ${e.upperBound.toLocaleString('en-GB')})`;

interface Block {
  key: string;
  title: string;
  note: string;
  text: string;
}

/** The blocks to show: the server's ordered sections (CD-5) when present, else the C0 fields as they are. */
export function promptBlocks(view: AiPromptPreviewView): Block[] {
  if (view.sections?.length) {
    return view.sections.map((s) => ({ key: s.key, title: s.title, note: `Read-only · ${about(s.tokenEstimate)}`, text: s.text }));
  }
  const blocks: Block[] = [{ key: 'system', title: 'Crewflow rules', note: 'Read-only', text: view.systemPrompt }];
  if (view.skillCatalogue.length) blocks.push({ key: 'skills', title: 'Skills the assistant can load', note: 'Read-only', text: view.skillCatalogue.join('\n') });
  if (view.toolCatalogue.length) blocks.push({ key: 'tools', title: 'Tools you’d be offered', note: 'Read-only', text: view.toolCatalogue.map((t) => `${t.name}: ${t.summary}`).join('\n') });
  return blocks;
}

/**
 * Settings → AI → Prompt (TWENTY_UI_INVENTORY F1–F12, D8-3): exactly what the assistant is told before YOUR next
 * question, built by the server from the same functions the model call uses. PLAIN TEXT ONLY — never Markdown, never
 * HTML: a `<script>` or a fake instruction in it is shown as the characters it is. Read-only: no send, no "try it"
 * (rule 10.5). The token figures are local estimates. Opening this tab is audited.
 */
export default function AiPromptTab() {
  const { scope } = useAiChat();
  const preview = useQuery({ queryKey: aiKeys.settingsArea(scope, 'prompt'), queryFn: aiSettingsApi.promptPreview, retry: false, staleTime: 5 * 60_000 });
  const [copied, setCopied] = useState<'' | 'Copied' | 'Could not copy'>('');

  if (preview.isLoading) return <p className="ai-set-muted" role="status">Loading the system prompt…</p>;
  if (preview.isError || !preview.data) return <p className="ai-set-notice" role="alert">The system prompt could not be shown. Refresh the page to try again.</p>;
  const view = preview.data;
  const blocks = promptBlocks(view);
  const total = view.totalTokenEstimate ?? view.tokenEstimate;
  const fullText = view.sections?.length ? view.sections.map((s) => s.text).join(AI_PROMPT_SECTION_SEPARATOR) : blocks.map((b) => b.text).join('\n\n');

  return (
    <>
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
          <pre className="ai-prompt-text" data-section={b.key}>{b.text}</pre>
        </section>
      ))}
    </>
  );
}
