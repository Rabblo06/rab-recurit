import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBook, IconChevronRight, IconMessages, IconSparkles, IconTerminal2, IconTool } from '@tabler/icons-react';
import { AI_INSTRUCTIONS_LIMITS, type AiAssistantProfileUpdateRequest, type AiAssistantProfileView, type AiPromptPreviewView, type AiSettingsOverview, type AiWorkspaceInstructionsView } from '@rab/shared';

import { useFeedbackMutation } from '../../../shared/hooks/useFeedbackMutation';
import { aiKeys } from '../../ai/aiApi';
import { useAiChat } from '../../ai/AiChatProvider';
import AiAssistantAvatar, { DEFAULT_AVATAR_LOOK } from '../../ai/avatar/AiAssistantAvatar';
import AiAvatarPicker from './AiAvatarPicker';
import AiReasonDialog, { NotAvailableYet } from './AiReasonDialog';
import { aiSettingsApi } from './aiSettingsApi';

/** Refusal codes of a workspace-instructions write (the Phase 4 content rules), in the CEO's words. Never the matched text. */
const INSTRUCTION_REFUSAL_TEXT: Record<string, string> = {
  AI_SKILL_CONTENT_REFUSED: 'These instructions can’t be saved: they contain something the assistant may not be given (markup, hidden characters, personal data or something that looks like a secret). Remove it and try again.',
  // The server's own code for an instructions write (p4 merge); same rules, same words.
  AI_INSTRUCTIONS_CONTENT_REFUSED: 'These instructions can’t be saved: they contain something the assistant may not be given (markup, hidden characters, personal data or something that looks like a secret). Remove it and try again.',
};

/**
 * Settings → AI → Overview (TWENTY_UI_INVENTORY B1–B28): the assistant's look (CD-3), at-a-glance counts (CD-10), the
 * organisation's instructions (CD-4, rule 5.3) and the way to the prompt viewer. Each section renders its real server
 * data when that API exists (`features`), and an honest "Not available yet" otherwise — never placeholder values.
 * No MCP section (B25: rule 13.3 — data is reachable only through the in-app assistant).
 */
export default function AiOverviewTab({ overview, onOpenPrompt }: { overview: AiSettingsOverview; onOpenPrompt: () => void }) {
  const f = overview.features;
  return (
    <>
      <AssistantSection enabled={f.assistant === true} />
      <AtAGlance overview={overview} />
      <InstructionsSection enabled={f.instructions === true} />
      <PromptRow enabled={f.promptPreview} onOpen={onOpenPrompt} />
    </>
  );
}

function AssistantSection({ enabled }: { enabled: boolean }) {
  const { scope } = useAiChat();
  const qc = useQueryClient();
  const profile = useQuery({ queryKey: aiKeys.settingsArea(scope, 'assistant'), queryFn: aiSettingsApi.assistant, enabled, retry: false });
  const applied = (view: AiAssistantProfileView) => {
    qc.setQueryData(aiKeys.settingsArea(scope, 'assistant'), view);
    // The chat header and empty state read the profile from availability.
    void qc.invalidateQueries({ queryKey: aiKeys.availability(scope) });
  };
  const save = useFeedbackMutation<AiAssistantProfileView, AiAssistantProfileUpdateRequest>({
    mutationFn: (change) => aiSettingsApi.updateAssistant(change),
    successMessage: 'Assistant updated',
    errorFeedback: { fallback: 'The assistant could not be updated. Please try again.' },
    onSuccess: applied,
  });
  const reset = useFeedbackMutation<AiAssistantProfileView, void>({
    mutationFn: () => aiSettingsApi.resetAssistant(),
    successMessage: 'Assistant reset to the default',
    errorFeedback: { fallback: 'The assistant could not be reset. Please try again.' },
    onSuccess: applied,
  });
  return (
    <section className="settings-section" aria-labelledby="ai-assistant-title">
      <h3 id="ai-assistant-title">Assistant</h3>
      <p>Choose how the assistant appears to your team. It is always marked “AI”.</p>
      {!enabled ? (
        <>
          <div className="ai-avatar-current">
            <AiAssistantAvatar look={DEFAULT_AVATAR_LOOK} size="xl" />
            <span><strong>Crewflow</strong> <span className="ai-badge-ai">AI</span></span>
          </div>
          <NotAvailableYet>Choosing a different name and look arrives with the assistant profile setting.</NotAvailableYet>
        </>
      ) : profile.isLoading ? (
        <p className="ai-set-muted" role="status">Loading…</p>
      ) : profile.isError || !profile.data ? (
        <p className="ai-set-notice" role="alert">The assistant’s look could not be loaded.</p>
      ) : (
        <AiAvatarPicker profile={profile.data} busy={save.busy || reset.busy} onChange={(c) => save.submit(c)} onReset={() => reset.submit()} />
      )}
    </section>
  );
}

function AtAGlance({ overview }: { overview: AiSettingsOverview }) {
  const c = overview.counts;
  const cells = [
    { label: 'Your conversations', Icon: IconMessages, value: c ? c.myConversations : null },
    { label: 'Questions this month', Icon: IconSparkles, value: c ? c.orgQuestionsThisMonth : null },
    { label: 'Skills on', Icon: IconBook, value: c && overview.features.skills ? c.activeSkills : null },
    { label: 'Tools you can use', Icon: IconTool, value: c && overview.features.tools ? c.tools : null },
  ];
  return (
    <section className="settings-section" aria-labelledby="ai-glance-title">
      <h3 id="ai-glance-title">At a glance</h3>
      <p>What is set up and being used in your organisation. Counts only, never content.</p>
      <dl className="ai-glance">
        {cells.map(({ label, Icon, value }) => (
          <div key={label}>
            <dt><Icon size={14} aria-hidden="true" />{label}</dt>
            <dd>{value === null ? <span className="ai-set-muted" title="Not available yet">—<span className="visually-hidden">Not available yet</span></span> : value.toLocaleString('en-GB')}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function InstructionsSection({ enabled }: { enabled: boolean }) {
  const { scope } = useAiChat();
  const qc = useQueryClient();
  const fieldId = useId();
  const current = useQuery({ queryKey: aiKeys.settingsArea(scope, 'instructions'), queryFn: aiSettingsApi.instructions, enabled, retry: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<'save' | 'remove' | null>(null);
  const max = AI_INSTRUCTIONS_LIMITS.maxChars;
  const value = draft ?? current.data?.content ?? '';
  const over = value.length > max;
  const changed = draft !== null && draft !== (current.data?.content ?? '');
  const done = (view: AiWorkspaceInstructionsView) => {
    qc.setQueryData(aiKeys.settingsArea(scope, 'instructions'), view);
    setDraft(null);
    setPending(null);
    // The prompt preview shows them in their own section.
    void qc.invalidateQueries({ queryKey: aiKeys.settingsArea(scope, 'prompt') });
  };
  return (
    <section className="settings-section" aria-labelledby="ai-instructions-title">
      <h3 id="ai-instructions-title">Organisation instructions</h3>
      <p>Added after Crewflow’s own rules in every question. They can’t give the assistant permissions or tools.</p>
      {!enabled ? (
        <NotAvailableYet>Organisation instructions arrive with the skills release.</NotAvailableYet>
      ) : current.isLoading ? (
        <p className="ai-set-muted" role="status">Loading…</p>
      ) : current.isError ? (
        <p className="ai-set-notice" role="alert">The instructions could not be loaded.</p>
      ) : (
        <>
          <label htmlFor={fieldId} className="visually-hidden">Instructions text</label>
          <textarea
            id={fieldId}
            className="ai-instructions"
            rows={4}
            value={value}
            placeholder="E.g. ‘We staff hospitality venues in Leeds. Use British English.’"
            aria-invalid={over || undefined}
            aria-describedby={`${fieldId}-count`}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="ai-instructions-foot">
            <span id={`${fieldId}-count`} className={over ? 'ai-set-field-error' : 'ai-set-muted'}>{`${value.length.toLocaleString('en-GB')} / ${max.toLocaleString('en-GB')}`}</span>
            <div className="ai-set-actions">
              {current.data?.content && <button type="button" className="btn btn-outline btn-sm" onClick={() => setPending('remove')}>Remove</button>}
              <button type="button" className="btn btn-dark btn-sm" disabled={!changed || over || !value.trim()} onClick={() => setPending('save')}>Save</button>
            </div>
          </div>
        </>
      )}
      {pending === 'save' && (
        <AiReasonDialog
          title="Save the organisation instructions?"
          body="They are added to every question your team asks the assistant. You may be asked to confirm it’s you."
          run={(reason) => aiSettingsApi.saveInstructions(value.trim(), reason)}
          successMessage="Organisation instructions saved"
          inlineErrors={INSTRUCTION_REFUSAL_TEXT}
          onDone={done}
          onClose={() => setPending(null)}
        />
      )}
      {pending === 'remove' && (
        <AiReasonDialog
          title="Remove the organisation instructions?"
          body="The assistant will use Crewflow’s own rules only. You may be asked to confirm it’s you."
          confirmLabel="Remove"
          destructive
          run={(reason) => aiSettingsApi.removeInstructions(reason)}
          successMessage="Organisation instructions removed"
          onDone={done}
          onClose={() => setPending(null)}
        />
      )}
    </section>
  );
}

function PromptRow({ enabled, onOpen }: { enabled: boolean; onOpen: () => void }) {
  const { scope } = useAiChat();
  const qc = useQueryClient();
  // Only an already-loaded preview gives the token figure: opening the preview is audited, so it is never fetched here.
  const cached = qc.getQueryData<AiPromptPreviewView>(aiKeys.settingsArea(scope, 'prompt'));
  const tokens = cached ? (cached.totalTokenEstimate ?? cached.tokenEstimate).estimate : null;
  return (
    <section className="settings-section" aria-labelledby="ai-prompt-title">
      <h3 id="ai-prompt-title">System prompt</h3>
      <p>Read exactly what the assistant is told before every question{tokens !== null ? ` (about ${tokens.toLocaleString('en-GB')} tokens)` : ''}.</p>
      {enabled ? (
        <button type="button" className="ai-set-row-link" onClick={onOpen}>
          <IconTerminal2 size={15} aria-hidden="true" />
          <span>Read the system prompt</span>
          <IconChevronRight size={15} aria-hidden="true" />
        </button>
      ) : (
        <NotAvailableYet>The prompt viewer is not on this server.</NotAvailableYet>
      )}
    </section>
  );
}
