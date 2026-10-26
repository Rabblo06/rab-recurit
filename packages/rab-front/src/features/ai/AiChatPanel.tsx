import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconCalendarPlus, IconCalendarSearch, IconSparkles, IconTrash } from '@tabler/icons-react';
import type { AiModelLevel } from '@rab/shared';

import ConfirmDialog from '../../shared/components/ConfirmDialog';
import { getApiErrorStatus } from '../../shared/lib/apiError';
import { aiApi, aiKeys, isAiBlocked, type AiAvailability, type AiBlockedAvailability } from './aiApi';
import AiApprovalCard from './AiApprovalCard';
import AiCapabilitiesSheet from './AiCapabilitiesSheet';
import { aiCardKeys, aiCardsApi, type AiCapabilities } from './aiCardsApi';
import AiInputCard from './AiInputCard';
import { APPROVAL_CARDS_READY, DRAFT_ROTA_PROMPT, DRAFT_ROTA_TOOL } from './aiFeatures';
import { AiSkillTagButton, AiSkillTagChips, MAX_TAGGED_SKILLS } from './AiSkillTags';
import { useAiChat } from './AiChatProvider';
import { AiLevelPicker, AiUsageButton, type AiLevelFacts } from './AiComposerControls';
import { useDeleteConversation } from './AiConversationList';
import AiMessage, { type AiAssistantIdentity, type AiMessageContext } from './AiMessage';
import AiAssistantAvatar, { lookOf } from './avatar/AiAssistantAvatar';
import { useAvatarState } from './avatar/useAvatarState';
import type { ChatQuickAction } from './ChatBody';
import { AiBanner, aiBlockedMessage, AiErrorState, AiLoadingState, AiNotice, AiUnavailableState, AiUsageIndicator, bannerKindOf } from './AiStates';
import { api } from '../../shared/api';
import ChatBody from './ChatBody';
import { useAiAvailability } from './useAiAvailability';
import { useAiConversation } from './useAiConversation';

/** The assistant as configured (CD-3, from `GET /ai/availability`), or the default preset. The name is plain text. */
export function assistantIdentity(availability: Pick<AiAvailability, 'assistant'> | undefined): AiAssistantIdentity {
  const profile = availability?.assistant ?? null;
  return { name: profile?.name || 'Crewflow', look: lookOf(profile) };
}

/** TW-D12 / U1: "Find open shifts" pre-fills a read question (the user still presses send). */
export const COVERAGE_GAPS_PROMPT = 'Which shifts in the next 7 days still need staff?';

/**
 * The working AI chat (page and side-panel surfaces share it). Availability decides everything first: loading, an
 * unreachable service, "turned off" / "not available to you", or the conversation itself. Real API data only.
 */
export default function AiChatPanel({ surface }: { surface: 'page' | 'panel' }) {
  const availability = useAiAvailability();
  if (availability.isLoading) return <AiLoadingState />;
  if (availability.isError || !availability.data) {
    return <AiErrorState message="The AI assistant could not be reached. Check your connection and try again." onRetry={() => void availability.refetch()} busy={availability.isFetching} />;
  }
  if (isAiBlocked(availability.data)) return <AiBlockedView surface={surface} availability={availability.data} />;
  if (!availability.data.available) return <AiUnavailableState reason={availability.data.reason} />;
  return <AiConversationView surface={surface} availability={availability.data} />;
}

/**
 * Eligible, but AI is not set up (no provider key / no model) or limited to demo data (crewflow-ai-work-like-twenty.md
 * §1.4, §1.5): the chat opens, the input is DISABLED with the server's fixed text, and there is no send action at all —
 * nothing is sent, no tool runs and no usage is recorded. The draft stays local to this tab.
 */
function AiBlockedView({ surface, availability }: { surface: 'page' | 'panel'; availability: AiBlockedAvailability }) {
  const chat = useAiChat();
  const message = aiBlockedMessage(availability);
  const assistant = assistantIdentity(availability);
  const isCeo = useIsCeo();
  return (
    <ChatBody
      // U1 state 6: the sleepy avatar (neutral grey) while nothing can be asked.
      emptyAvatar={<AiAssistantAvatar look={{ ...assistant.look, colour: 'grey' }} state="sleepy" size={EMPTY_AVATAR_PX} />}
      emptyTitle={EMPTY_TITLE}
      examples={false}
      emptyExtra={<AiBanner kind={bannerKindOf(availability)} settingsLink={isCeo} />}
      surface={surface}
      value={chat.draft}
      onChange={chat.setDraft}
      disabled
      unavailable
      status={message}
      statusHidden
      note={<span />}
      placeholder="AI isn’t available right now"
      hasMessages={false}
      autoFocus={false}
      bottom={<AiNotice />}
    />
  );
}

/** U1: the empty-state heading and avatar size of the owner's chat mockup. */
export const EMPTY_TITLE = 'How can I help you?';
export const EMPTY_AVATAR_PX = 44;

/** The CEO sees the "Open AI settings" link and the model facts (both CEO-only); `me` is the app's existing identity read. */
function useIsCeo(): boolean {
  const me = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get<{ roles?: string[] }>('/auth/me')).data, staleTime: 5 * 60_000, retry: false, meta: { silent: true } });
  return Boolean(me.data?.roles?.includes('ceo'));
}

/**
 * The CEO's model facts per level (C1 `GET /ai/settings/models`): model, verified effort, catalogue prices, context and
 * region for the tier picker's model card. Only the CEO may read that route, so it is fetched only for the CEO; everyone
 * else sees the server's level list and reasons without the facts.
 */
function useLevelFacts(): AiLevelFacts | null {
  const isCeo = useIsCeo();
  const { scope } = useAiChat();
  const models = useQuery({
    queryKey: aiKeys.settings(scope),
    queryFn: async () => (await api.get<Partial<AiLevelFacts> & { models: AiLevelFacts['models'] }>('/ai/settings/models')).data,
    enabled: isCeo,
    retry: false,
    staleTime: 60_000,
    meta: { silent: true },
  });
  return models.data?.levels ? { levels: models.data.levels, models: models.data.models } : null;
}

function AiConversationView({ surface, availability }: { surface: 'page' | 'panel'; availability: Extract<AiAvailability, { available: true }> }) {
  const chat = useAiChat();
  const max = availability.limits.maxInputChars;
  const conv = useAiConversation({ available: true, maxInputChars: max });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useDeleteConversation(() => setConfirmDelete(false));
  const detail = conv.detail;
  const messages = detail.data?.messages ?? [];
  const title = detail.data?.conversation.title;
  const length = chat.draft.trim().length;
  const over = length > max;
  const limited = conv.limitSecondsLeft > 0;
  // U2: while an answer runs, ONE more question may be sent (queued); a second one waits (owner decision 6).
  const queueable = conv.activeTurn && !conv.queuedTurnId && !conv.sending;
  const blocked = conv.sending || (conv.activeTurn && !queueable) || limited || over;
  const assistant = assistantIdentity(availability);
  const levels = availability.levels ?? null;
  const [level, setLevel] = useState<AiModelLevel | null>(null);
  const chosenLevel = levels ? (level && levels.options.some((o) => o.level === level && o.available) ? level : levels.chatLevel) : null;
  const submitAcceptsLevel = (levels as { submitAcceptsLevel?: boolean } | null)?.submitAcceptsLevel === true;
  // FROM-AGENT9-LEVELS: only a level the server lists as AVAILABLE ever travels (never a client fallback); an unavailable
  // organisation level sends none and the server applies its own.
  const sendLevel = submitAcceptsLevel && chosenLevel && levels?.options.some((o) => o.level === chosenLevel && o.available) ? chosenLevel : undefined;
  const levelFacts = useLevelFacts();
  const [showCapabilities, setShowCapabilities] = useState(false);
  // U3: skill tags for the NEXT question (names only; cleared once the server accepted the question).
  const [tags, setTags] = useState<string[]>([]);
  const [tagMenu, setTagMenu] = useState(false);
  const tagAnchor = useRef<HTMLButtonElement>(null);
  useEffect(() => setTags([]), [chat.conversationId]);
  // CD-8: "See what I can do" appears only when the server serves the capabilities route (one quiet probe per session).
  const capabilities = useQuery({ queryKey: aiKeys.capabilities(chat.scope), queryFn: aiApi.capabilities, retry: false, staleTime: 10 * 60_000, meta: { silent: true } });
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  // U5: approval and question/form cards, attached to their answer by turn id (the server emits no card parts in Batch 3).
  const proposals = useQuery({
    queryKey: aiCardKeys.proposals(chat.scope, chat.conversationId ?? 'none'),
    queryFn: () => aiCardsApi.proposals(chat.conversationId!),
    enabled: !!chat.conversationId,
    retry: false,
    staleTime: 15_000,
    meta: { silent: true },
  });
  const inputs = useQuery({
    queryKey: aiCardKeys.inputs(chat.scope, chat.conversationId ?? 'none'),
    queryFn: () => aiCardsApi.inputs(chat.conversationId!),
    enabled: !!chat.conversationId,
    retry: false,
    staleTime: 15_000,
    meta: { silent: true },
  });
  // A 404 means "no such route / nothing for you here": no cards. Any other failure is shown, never an empty list.
  const cardsFailed = (proposals.isError && getApiErrorStatus(proposals.error) !== 404) || (inputs.isError && getApiErrorStatus(inputs.error) !== 404);
  const cardsFor = (turnId: string) => {
    const mine = (proposals.data ?? []).filter((p) => p.turnId === turnId);
    const asks = (inputs.data ?? []).filter((r) => r.turnId === turnId);
    if (!mine.length && !asks.length) return undefined;
    return (
      <div className="ai-cards">
        {mine.map((p) => <AiApprovalCard key={p.id} proposal={p} receivedAt={proposals.dataUpdatedAt} assistantName={assistant.name} />)}
        {asks.map((r) => <AiInputCard key={r.requestId} request={r} conversationId={chat.conversationId!} maxChars={max} />)}
      </div>
    );
  };
  // "Draft a rota" (owner rule): only when the server lists the draft-shift tool among THIS person's write tools AND the
  // organisation's approvals feature is on. U8: the flag comes from `GET /ai/availability` (`approvals`, every eligible
  // user, including the Initial Manager). Until the server sends that field, the CEO-only `/ai/settings` flag is the
  // fallback and anyone else does not get the chip (fail closed).
  const availabilityApprovals = (availability as { approvals?: unknown }).approvals;
  const approvalsField = typeof availabilityApprovals === 'boolean' ? availabilityApprovals : null;
  const isCeo = useIsCeo();
  const overview = useQuery({
    queryKey: [...aiKeys.all(chat.scope), 'chat-features'],
    queryFn: async () => (await api.get<{ features?: { approvals?: boolean } }>('/ai/settings')).data,
    enabled: isCeo && approvalsField === null,
    retry: false,
    staleTime: 5 * 60_000,
    meta: { silent: true },
  });
  const approvalsOn = approvalsField ?? overview.data?.features?.approvals === true;
  // S1: the ring's context figure is the latest OWN answer that has a ledger row (a running or queued one has none yet).
  const lastUsage = [...messages].reverse().find((m) => m.role === 'assistant' && m.usage)?.usage ?? null;
  // Step labels: skill names → labels from the server's active list (never content); quiet when unavailable.
  const skills = useQuery({ queryKey: aiKeys.skills(chat.scope), queryFn: aiApi.skills, retry: false, staleTime: 5 * 60_000, meta: { silent: true } });
  const messageContext = useMemo<AiMessageContext>(() => {
    const modelLabels: Record<string, string> = {};
    for (const m of levelFacts?.models ?? []) modelLabels[m.id] = m.label;
    if (availability.model) modelLabels[availability.model.id] = availability.model.label;
    return {
      skillLabels: Object.fromEntries((Array.isArray(skills.data) ? skills.data : []).map((s) => [s.name, s.label])),
      levelLabels: Object.fromEntries((levels?.options ?? []).map((o) => [o.level, o.label])),
      modelLabels,
    };
  }, [availability.model, levelFacts, levels, skills.data]);
  const live = conv.live;
  const avatarState = useAvatarState({
    usable: true,
    status: live?.status ?? null,
    reasoning: live?.reasoning?.phase === 'started',
    toolRunning: Boolean(live?.tools.some((t) => t.phase === 'started')),
    lastDeltaAt: live?.lastDeltaAt ?? null,
    // U8: a one-off "happy" wink when one of this conversation's proposals is applied (CD-12 ack).
    ackCount: (proposals.data ?? []).filter((p) => p.status === 'EXECUTED').length,
  });
  // U8: ONE polite announcement per outcome of the followed answer (the streamed text itself is not a live region).
  const [outcome, setOutcome] = useState('');
  const liveStatus = live?.status ?? null;
  useEffect(() => {
    const text: Record<string, string> = {
      completed: 'Answer complete.',
      cancelled: 'Answer stopped.',
      failed: 'The answer could not be completed.',
      waiting_for_input: 'The assistant is waiting for your answer.',
    };
    setOutcome(liveStatus ? text[liveStatus] ?? '' : '');
  }, [liveStatus]);
  // Only skills the server lists as active can stay tagged (a skill switched off meanwhile drops out of the tags).
  const activeSkills = useMemo(() => (Array.isArray(skills.data) ? skills.data : []), [skills.data]);
  useEffect(() => {
    if (skills.isSuccess) setTags((prev) => prev.filter((name) => activeSkills.some((s) => s.name === name)));
  }, [activeSkills, skills.isSuccess]);
  const toggleTag = (name: string) => setTags((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : prev.length >= MAX_TAGGED_SKILLS ? prev : [...prev, name]));
  const quickActions = useMemo<ChatQuickAction[]>(() => {
    const actions: ChatQuickAction[] = [{ label: 'Find open shifts', Icon: IconCalendarSearch, prompt: COVERAGE_GAPS_PROMPT }];
    // "Draft a rota" only when a write proposal can really complete: the server lists the draft-shift tool for this person
    // (GET /ai/capabilities) AND this UI can show and decide the approval card (U5). It pre-fills; it never sends.
    if (APPROVAL_CARDS_READY && approvalsOn && (capabilities.data as AiCapabilities | undefined)?.writeTools?.some((t) => t.name === DRAFT_ROTA_TOOL)) actions.push({ label: 'Draft a rota', Icon: IconCalendarPlus, prompt: DRAFT_ROTA_PROMPT });
    if (capabilities.isSuccess) actions.push({ label: 'See what I can do', Icon: IconSparkles, onClick: () => setShowCapabilities(true) });
    return actions;
  }, [approvalsOn, capabilities.data, capabilities.isSuccess]);

  if (chat.conversationId && detail.isLoading) return <AiLoadingState label="Loading the conversation…" />;
  if (chat.conversationId && detail.isError) {
    return getApiErrorStatus(detail.error) === 404 ? (
      <div className="ai-state" role="status">
        <p>This conversation is no longer available.</p>
        <button type="button" className="btn btn-outline" onClick={chat.newChat}>Start a new conversation</button>
      </div>
    ) : (
      <AiErrorState message="The conversation could not be loaded." onRetry={() => void detail.refetch()} busy={detail.isFetching} />
    );
  }

  const problem = conv.problem;
  const error = problem?.message ?? (over ? `Questions are limited to ${max.toLocaleString('en-GB')} characters. Shorten yours to send it.` : undefined);
  const statusAction = problem?.retry ? (
    <button type="button" className="ai-link-btn" onClick={problem.retry}>Try again</button>
  ) : problem?.startNew ? (
    <button type="button" className="ai-link-btn" onClick={() => { conv.clearProblem(); chat.newChat(); }}>Start a new conversation</button>
  ) : limited ? (
    <span className="ai-status-hint">You can ask again in {formatWait(conv.limitSecondsLeft)}.</span>
  ) : conv.live?.connection === 'lost' && conv.activeTurn ? (
    <button type="button" className="ai-link-btn" onClick={conv.reconnect}>Reconnect</button>
  ) : null;
  const status = conv.sending
    ? 'Sending your question…'
    : conv.live?.connection === 'lost' && conv.activeTurn
      ? 'Live updates stopped. The answer is still being prepared on the server.'
      : conv.activeTurn && conv.queuedTurnId
        ? 'One more question is queued. It is asked after the current answer.'
        : conv.activeTurn
          ? 'The assistant is answering. You can stop it, or send one more question to ask next.'
          : '';

  return (
    <>
      <ChatBody
        surface={surface}
        value={chat.draft}
        onChange={chat.setDraft}
        // A level travels ONLY when the server says the submit accepts it (Agent 9: `levels.submitAcceptsLevel`); otherwise the
        // body never carries one (an early `level` is a 400 under forbidNonWhitelisted).
        onSend={blocked ? undefined : () => conv.send(chat.draft, sendLevel, tags, () => setTags([]))}
        onSlash={activeSkills.length ? () => setTagMenu(true) : undefined}
        above={<AiSkillTagChips selected={tags} labels={messageContext.skillLabels ?? {}} onRemove={(name) => setTags((prev) => prev.filter((n) => n !== name))} />}
        onStop={conv.activeTurn && !conv.live?.cancelling ? () => void conv.cancel() : undefined}
        sending={conv.sending || conv.activeTurn}
        queueable={queueable}
        error={error}
        invalid={over}
        status={status}
        statusAction={statusAction}
        placeholder="Ask about shifts, fill rate, offers, attendance or payroll totals…"
        note={<span className={`ai-composer-note ai-counter${over ? ' ai-error' : ''}`} data-over={over ? 'true' : 'false'}>{`${length.toLocaleString('en-GB')} / ${max.toLocaleString('en-GB')}`}</span>}
        // The context ring appears only once the server reports the Phase 7 meters (U1 plan: hidden until U2/U7 data exists).
        leading={<>
          {activeSkills.length > 0 && <AiSkillTagButton skills={activeSkills} selected={tags} onToggle={toggleTag} open={tagMenu} onOpenChange={setTagMenu} anchorRef={tagAnchor} disabled={conv.sending} />}
          {availability.usage.resetsAt ? <AiUsageButton usage={availability.usage} tokenBudget={availability.limits.orgDailyTokenBudget} lastTurn={lastUsage} totals={detail.data?.usageTotals ?? null} /> : null}
        </>}
        trailing={levels && chosenLevel ? <AiLevelPicker levels={levels} value={chosenLevel} onChange={setLevel} model={availability.model} disabled={conv.sending} readOnly={!submitAcceptsLevel} facts={levelFacts} /> : null}
        emptyAvatar={<AiAssistantAvatar look={assistant.look} state={avatarState} size={EMPTY_AVATAR_PX} />}
        emptyTitle={EMPTY_TITLE}
        examples={false}
        quickActions={quickActions}
        hasMessages={messages.length > 0}
        messages={messages.map((m, i) => (
          <AiMessage
            key={m.id}
            message={m}
            assistant={assistant}
            context={messageContext}
            avatarState={m.id === (conv.live?.turnId ?? lastAssistant?.id) ? avatarState : undefined}
            live={conv.live?.turnId === m.id ? conv.live : null}
            // U1 "Try again" on a failed turn: puts the question back in the composer; the person sends it again.
            onRetry={m.id === lastAssistant?.id && i > 0 && messages[i - 1]!.role === 'user' ? () => chat.setDraft(messages[i - 1]!.content) : undefined}
            onStartNew={chat.newChat}
            // U2: the question whose answer is the queued turn (the next message) carries the "Queued" tag + Remove.
            cards={m.role === 'assistant' ? cardsFor(m.id) : undefined}
            queued={m.role === 'user' && conv.queuedTurnId && messages[i + 1]?.id === conv.queuedTurnId ? { onRemove: () => void conv.cancelQueued(), busy: conv.removingQueued } : undefined}
          />
        ))}
        top={
          <div className="ai-chat-head">
            {chat.conversationId ? <strong className="ai-chat-title" title={title ?? undefined}>{title || 'Untitled conversation'}</strong> : <span className="ai-chat-title ai-muted">New conversation</span>}
            <AiUsageIndicator availability={availability} />
            {chat.conversationId && (
              <button type="button" className="btn-icon" aria-label="Delete this conversation" title="Delete this conversation" onClick={() => setConfirmDelete(true)}>
                <IconTrash size={15} />
              </button>
            )}
          </div>
        }
        bottom={<>
          {cardsFailed && (
            <p className="ai-dcard-error" role="alert">
              Approval and question cards could not be loaded.{' '}
              <button type="button" className="ai-link-btn" onClick={() => { void proposals.refetch(); void inputs.refetch(); }}>Try again</button>
            </p>
          )}
          <AiNotice />
          <p className="visually-hidden" role="status" aria-live="polite" data-testid="ai-outcome">{outcome}</p>
        </>}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this conversation?"
        description="The questions and answers in it are deleted for good. This cannot be undone."
        confirmLabel="Delete"
        destructive
        loading={remove.busy}
        onConfirm={() => detail.data && remove.submit(detail.data.conversation)}
        onCancel={() => setConfirmDelete(false)}
      />
      <AiCapabilitiesSheet open={showCapabilities} data={capabilities.data} onClose={() => setShowCapabilities(false)} />
    </>
  );
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}
