import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AI_SKILL_LIMITS, type AiModelLevel, type AiPlanStep } from '@rab/shared';

import { getApiErrorCode, getApiErrorStatus, normalizeApiError } from '../../shared/lib/apiError';
import { isSilentError, notifyApiError } from '../../shared/lib/mutationFeedback';
import { AI_ERROR_TEXT, aiApi, aiKeys, conversationTitleFrom, type AiConversationDetail, type AiMessage } from './aiApi';
import { useAiChat } from './AiChatProvider';
import { aiCardKeys } from './aiCardsApi';
import { openAiStream, type AiChatStreamEvent, type AiStreamEnd, type AiStreamHandle } from './aiStream';

export type LiveTurnStatus = 'queued' | 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';

/** The turn currently followed on the stream. Text comes ONLY from server events; `done.content` replaces it. */
export interface LiveTurn {
  turnId: string;
  conversationId: string;
  status: LiveTurnStatus;
  text: string;
  tools: Array<{ name: string; phase: 'started' | 'finished'; outcome?: string }>;
  errorCode: string | null;
  cancelling: boolean;
  /** CD-7: the reasoning phase and its server-measured duration. Never any reasoning text (there is none to keep). */
  reasoning: { phase: 'started' | 'finished'; durationMs: number | null } | null;
  /** CD-7: the latest `update_plan` checklist (plain-text labels; information only, never an approval). */
  plan: AiPlanStep[] | null;
  /** When the last text delta arrived (ms epoch) — drives the avatar's `talking` hold only. */
  lastDeltaAt: number | null;
  /** 'live' while events flow; 'reconnecting' between attempts; 'lost' after the reconnect budget is spent. */
  connection: 'connecting' | 'live' | 'reconnecting' | 'lost';
  lastEventId: string | null;
}

export interface ComposerProblem {
  message: string;
  code: string | null;
  /** Usage limits: sending stays disabled until this time (ms epoch). */
  until?: number;
  /** "Try again" with the same input and the same idempotency key (connection lost, timeout, 5xx). */
  retry?: () => void;
  /** The conversation is full: offer "Start a new conversation". */
  startNew?: boolean;
}

const ACTIVE = new Set(['queued', 'running']);
const LIMIT_CODES = new Set(['AI_RATE_LIMITED', 'AI_ORG_BUSY', 'AI_BUDGET_EXHAUSTED', 'AI_USER_BUDGET_EXHAUSTED']);

function retryAfterOf(error: unknown): number | null {
  const data = (error as { response?: { data?: { retryAfterSeconds?: unknown } } })?.response?.data;
  const n = Number(data?.retryAfterSeconds);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 86_400) : null;
}

function maxCharsOf(error: unknown): number | null {
  const n = Number((error as { response?: { data?: { maxChars?: unknown } } })?.response?.data?.maxChars);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * One conversation, end to end: the persisted transcript (`GET /ai/conversations/:id`), sending a question (202 →
 * stream), following the answer over the authenticated SSE stream with resume, cancelling, and every refusal state.
 * Nothing is simulated: a message appears only with the ids the server returned, the answer only from stream events,
 * and the final text is the server's persisted `done.content`.
 */
export function useAiConversation({ available, maxInputChars }: { available: boolean; maxInputChars: number }) {
  const chat = useAiChat();
  const qc = useQueryClient();
  const { scope, conversationId } = chat;
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [problem, setProblem] = useState<ComposerProblem | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const stream = useRef<{ handle: AiStreamHandle; conversationId: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** The conversation this hook just created for a first question: opening it is not a "switch" (keep the problem line). */
  const adopted = useRef<string | null>(null);

  const detail = useQuery({
    queryKey: aiKeys.detail(scope, conversationId ?? 'none'),
    queryFn: () => aiApi.get(conversationId!),
    enabled: available && !!conversationId,
    staleTime: 30_000,
    retry: (count, error) => getApiErrorStatus(error) !== 404 && count < 1,
    meta: { silent: true },
  });

  const refreshAvailability = useCallback(() => void qc.invalidateQueries({ queryKey: aiKeys.availability(scope) }), [qc, scope]);
  const refreshList = useCallback(() => void qc.invalidateQueries({ queryKey: aiKeys.list(scope) }), [qc, scope]);

  /** Writes a server-confirmed change of one message into the cached transcript. */
  const patchMessage = useCallback(
    (convId: string, messageId: string, patch: Partial<AiMessage>) =>
      qc.setQueryData<AiConversationDetail>(aiKeys.detail(scope, convId), (prev) =>
        prev ? { ...prev, messages: prev.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)) } : prev,
      ),
    [qc, scope],
  );

  const stopStream = useCallback(() => {
    stream.current?.handle.stop();
    stream.current = null;
  }, []);

  const follow = useCallback(
    (convId: string, turnId: string, initial: LiveTurnStatus, resumeFrom: string | null = null, keepText = '') => {
      stopStream();
      setLive({ turnId, conversationId: convId, status: initial, text: keepText, tools: [], errorCode: null, cancelling: false, reasoning: null, plan: null, lastDeltaAt: null, connection: 'connecting', lastEventId: resumeFrom });
      const onEvent = (event: AiChatStreamEvent) => {
        setLive((prev) => {
          if (!prev || prev.turnId !== turnId) return prev;
          const next: LiveTurn = { ...prev, connection: 'live', lastEventId: handle.lastEventId() };
          if (event.type === 'status') next.status = event.status;
          else if (event.type === 'delta') {
            next.status = 'running';
            next.text = prev.text + event.text;
            next.lastDeltaAt = Date.now();
          } else if (event.type === 'reasoning') {
            next.status = 'running';
            next.reasoning = { phase: event.phase, durationMs: event.phase === 'finished' && typeof event.durationMs === 'number' ? event.durationMs : null };
          } else if (event.type === 'plan') {
            next.plan = event.steps;
          } else if (event.type === 'tool') {
            next.status = 'running';
            const others = prev.tools.filter((t) => t.name !== event.name);
            next.tools = [...others, { name: event.name, phase: event.phase, outcome: event.outcome }];
          } else if (event.type === 'waiting') {
            // 5c: paused for the person's answer (a question / form card). Not running, not finished.
            next.status = 'waiting_for_input';
          } else if (event.type === 'done') {
            next.status = event.status;
            next.text = event.content;
            next.errorCode = event.errorCode;
            next.cancelling = false;
          } else if (event.type === 'error') {
            next.status = 'failed';
            next.errorCode = event.errorCode;
          }
          return next;
        });
        if (event.type === 'done') {
          patchMessage(convId, turnId, { status: event.status, content: event.content, errorCode: event.errorCode, completedAt: new Date().toISOString() });
          // The persisted row (tool metadata, timestamps) and the history order / usage meter are refetched.
          void qc.invalidateQueries({ queryKey: aiKeys.detail(scope, convId) });
          refreshList();
          refreshAvailability();
        }
        if (event.type === 'error') {
          void qc.invalidateQueries({ queryKey: aiKeys.detail(scope, convId) });
          refreshAvailability();
        }
        // U5: a card appeared or the turn paused for an answer — re-read the cards (ids only came on the stream).
        if (event.type === 'proposal' || event.type === 'done') void qc.invalidateQueries({ queryKey: aiCardKeys.proposals(scope, convId) });
        if (event.type === 'input_request' || event.type === 'waiting' || event.type === 'done') void qc.invalidateQueries({ queryKey: aiCardKeys.inputs(scope, convId) });
        if (event.type === 'waiting') {
          patchMessage(convId, turnId, { status: 'waiting_for_input' });
          void qc.invalidateQueries({ queryKey: aiKeys.detail(scope, convId) });
        }
      };
      const onEnd = (end: AiStreamEnd) => {
        if (stream.current?.handle === handle) stream.current = null;
        if (end.kind === 'done' || end.kind === 'identity' || end.kind === 'waiting') return;
        if (end.kind === 'error') return; // handled by the event itself
        const resumeAt = handle.lastEventId();
        if (end.kind === 'http') {
          // 404: AI was switched off, access changed, or the conversation was deleted. 401: the session ended — the
          // availability refetch goes through the shared client, which refreshes or signs out. Either way: re-read.
          refreshAvailability();
          void qc.invalidateQueries({ queryKey: aiKeys.detail(scope, convId) });
          setLive((prev) => (prev && prev.turnId === turnId ? { ...prev, connection: 'lost', lastEventId: resumeAt ?? prev.lastEventId } : prev));
          return;
        }
        setLive((prev) => (prev && prev.turnId === turnId ? { ...prev, connection: 'lost', lastEventId: resumeAt ?? prev.lastEventId } : prev));
      };
      const handle = openAiStream({
        conversationId: convId,
        turnId,
        lastEventId: resumeFrom,
        onEvent,
        onEnd,
        onOpen: () => setLive((prev) => (prev && prev.turnId === turnId ? { ...prev, connection: 'live' } : prev)),
        onReconnecting: () => setLive((prev) => (prev && prev.turnId === turnId ? { ...prev, connection: 'reconnecting' } : prev)),
      });
      stream.current = { handle, conversationId: convId };
    },
    [patchMessage, qc, refreshAvailability, refreshList, scope, stopStream],
  );

  // Switching conversation (or leaving) stops following; the turn itself carries on server-side and is resumed on return.
  useEffect(() => {
    if (conversationId && adopted.current === conversationId) {
      adopted.current = null;
      return;
    }
    setProblem(null);
    setLive((prev) => (prev && prev.conversationId === conversationId ? prev : null));
    if (stream.current && stream.current.conversationId !== conversationId) stopStream();
  }, [conversationId, stopStream]);
  useEffect(() => () => stopStream(), [stopStream]);

  // Resume: a reopened conversation whose last answer is still queued/running is followed again (from the start of its
  // stream, so the text is rebuilt from server events; once expired, the server sends the persisted answer).
  const messages = detail.data?.messages;
  useEffect(() => {
    if (!available || !conversationId || !messages) return;
    // The FIRST active answer is followed: a queued one (U2) waits behind it and is picked up once that one ends.
    const next = messages.find((m) => m.role === 'assistant' && ACTIVE.has(m.status) && !(live && live.turnId === m.id && !ACTIVE.has(live.status)));
    if (!next) return;
    if (live && live.turnId === next.id) return;
    if (stream.current) return;
    follow(conversationId, next.id, next.status as LiveTurnStatus);
  }, [available, conversationId, messages, live, follow]);

  // Usage-limit countdown.
  useEffect(() => {
    if (!problem?.until) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [problem?.until]);
  useEffect(() => {
    if (problem?.until && now >= problem.until) setProblem(null);
  }, [now, problem?.until]);

  const activeTurn = Boolean(live && ACTIVE.has(live.status));
  /**
   * U2 (owner decision 6): ONE more question may wait behind the running answer (server: maxQueuedTurnsPerConversation).
   * It is the active assistant turn that is not the one being followed. Never invented: only ids the server returned.
   */
  const queuedTurnId =
    activeTurn && live && messages ? messages.find((m) => m.role === 'assistant' && m.id !== live.turnId && ACTIVE.has(m.status))?.id ?? null : null;

  const describeSubmitError = useCallback(
    (error: unknown, retry: () => void): ComposerProblem | null => {
      if (isSilentError(error)) return null;
      const status = getApiErrorStatus(error);
      const code = getApiErrorCode(error);
      if (status === 401) {
        // The one announcement for an ended session is the shared persistent "Sign in again" toast.
        notifyApiError(error, { fallback: 'Your session has expired. Please sign in again.' });
        return null;
      }
      if (status === 404) {
        // Uniform AI_NOT_AVAILABLE (switched off, permission removed) or a conversation that no longer exists.
        refreshAvailability();
        if (code !== 'AI_NOT_AVAILABLE' && conversationId) void qc.invalidateQueries({ queryKey: aiKeys.detail(scope, conversationId) });
        return { message: code === 'AI_NOT_AVAILABLE' ? AI_ERROR_TEXT.AI_NOT_AVAILABLE : 'This conversation is no longer available. Start a new conversation.', code, startNew: code !== 'AI_NOT_AVAILABLE' };
      }
      if (code === 'AI_NOT_CONFIGURED' || code === 'AI_DEMO_DATA_ONLY') {
        // The configuration changed under an open chat (key removed, organisation not synthetic): re-read availability,
        // which disables the composer with the server's fixed text. Never retried: nothing was sent.
        refreshAvailability();
        return { message: AI_ERROR_TEXT[code]!, code };
      }
      if (code === 'AI_INPUT_TOO_LONG') {
        const max = maxCharsOf(error) ?? maxInputChars;
        return { message: `Questions are limited to ${max.toLocaleString('en-GB')} characters. Shorten yours and try again.`, code };
      }
      if (code && LIMIT_CODES.has(code)) {
        const seconds = retryAfterOf(error);
        return { message: AI_ERROR_TEXT[code]!, code, until: seconds ? Date.now() + seconds * 1000 : undefined };
      }
      if (code === 'AI_CONVERSATION_FULL' || code === 'AI_CONTEXT_FULL') return { message: AI_ERROR_TEXT[code]!, code, startNew: true };
      if (code === 'AI_SKILL_NOT_AVAILABLE') {
        // A tagged skill was switched off or removed: re-read the active list (the person re-checks the tags).
        void qc.invalidateQueries({ queryKey: aiKeys.skills(scope) });
        return { message: AI_ERROR_TEXT[code]!, code };
      }
      if (code === 'AI_LEVEL_UNAVAILABLE') {
        refreshAvailability();
        return { message: AI_ERROR_TEXT[code]!, code };
      }
      if (code === 'AI_TURN_IN_PROGRESS') {
        if (conversationId) void qc.invalidateQueries({ queryKey: aiKeys.detail(scope, conversationId) });
        return { message: AI_ERROR_TEXT[code]!, code };
      }
      const normalized = normalizeApiError(error, { fallback: 'Your question could not be sent. Please try again.', codes: AI_ERROR_TEXT, messages: { server: AI_ERROR_TEXT.AI_SERVICE_UNAVAILABLE } });
      const canRetry = normalized.kind === 'offline' || normalized.kind === 'timeout' || normalized.kind === 'server';
      return { message: normalized.message, code, retry: canRetry ? retry : undefined };
    },
    [conversationId, maxInputChars, qc, refreshAvailability, scope],
  );

  const runSubmit = useCallback(
    async (input: { conversationId: string | null; content: string; clientRequestId: string; level?: AiModelLevel; skills?: string[]; onAccepted?: () => void }): Promise<void> => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      setSending(true);
      setProblem(null);
      let convId = input.conversationId;
      const retry = () => void runSubmit({ ...input, conversationId: convId });
      try {
        if (!convId) {
          const created = await aiApi.create(conversationTitleFrom(input.content));
          convId = created.id;
          qc.setQueryData<AiConversationDetail>(aiKeys.detail(scope, created.id), { conversation: created, messages: [] });
          adopted.current = created.id;
          chat.adoptNewDraft(created.id);
          refreshList();
        }
        const result = await aiApi.submit(convId, input.content, input.clientRequestId, input.level, input.skills);
        const at = new Date().toISOString();
        // Only now (the server accepted the question and returned its ids) does it appear in the transcript.
        qc.setQueryData<AiConversationDetail>(aiKeys.detail(scope, convId), (prev) => {
          if (!prev) return prev;
          if (prev.messages.some((m) => m.id === result.turnId)) return prev; // a replayed submit
          return {
            ...prev,
            messages: [
              ...prev.messages,
              { id: result.userMessageId, role: 'user', status: 'sent', content: input.content, errorCode: null, toolCalls: [], createdAt: at, completedAt: null, skills: input.skills ?? [] },
              { id: result.turnId, role: 'assistant', status: result.status, content: '', errorCode: null, toolCalls: [], createdAt: at, completedAt: null },
            ],
          };
        });
        chat.setDraftFor(convId, '');
        input.onAccepted?.();
        refreshList();
        // A question sent while another answer runs is QUEUED: keep following the running one; the resume effect picks the
        // queued turn up when that ends.
        const busyElsewhere = stream.current !== null && stream.current.conversationId === convId;
        if (ACTIVE.has(result.status) && !busyElsewhere) follow(convId, result.turnId, result.status as LiveTurnStatus);
        else void qc.invalidateQueries({ queryKey: aiKeys.detail(scope, convId) });
      } catch (error) {
        setProblem(describeSubmitError(error, retry));
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [chat, describeSubmitError, follow, qc, refreshList, scope],
  );

  const send = useCallback(
    (content: string, level?: AiModelLevel, skills?: string[], onAccepted?: () => void) => {
      const text = content.trim();
      if (!text || !available) return false;
      if (activeTurn && queuedTurnId) {
        // Local, before any request: the server would answer 409 AI_TURN_IN_PROGRESS.
        setProblem({ message: 'Wait for the current answer: one more question is already queued.', code: 'AI_TURN_IN_PROGRESS' });
        return false;
      }
      if (text.length > maxInputChars) {
        setProblem({ message: `Questions are limited to ${maxInputChars.toLocaleString('en-GB')} characters. Shorten yours and try again.`, code: 'AI_INPUT_TOO_LONG' });
        return false;
      }
      if (problem?.until && Date.now() < problem.until) return false;
      void runSubmit({ conversationId, content: text, clientRequestId: crypto.randomUUID(), level, skills: skills?.length ? skills.slice(0, AI_SKILL_LIMITS.maxTaggedPerMessage) : undefined, onAccepted });
      return true;
    },
    [activeTurn, available, conversationId, maxInputChars, problem?.until, queuedTurnId, runSubmit],
  );

  /** U2: remove the queued question (cancel its turn on the server: a queued turn is cancelled at once, reservation refunded). */
  const [removingQueued, setRemovingQueued] = useState(false);
  const cancelQueued = useCallback(async () => {
    if (!conversationId || !queuedTurnId || removingQueued) return;
    setRemovingQueued(true);
    try {
      const result = await aiApi.cancel(conversationId, queuedTurnId);
      if (result.status === 'cancelled') patchMessage(conversationId, queuedTurnId, { status: 'cancelled' });
      void qc.invalidateQueries({ queryKey: aiKeys.detail(scope, conversationId) });
      refreshAvailability();
    } catch (error) {
      setProblem(describeSubmitError(error, () => void cancelQueued()));
    } finally {
      setRemovingQueued(false);
    }
  }, [conversationId, describeSubmitError, patchMessage, qc, queuedTurnId, refreshAvailability, removingQueued, scope]);

  const [cancelBusy, setCancelBusy] = useState(false);
  const cancel = useCallback(async () => {
    if (!live || !ACTIVE.has(live.status) || cancelBusy) return;
    setCancelBusy(true);
    try {
      const result = await aiApi.cancel(live.conversationId, live.turnId);
      if (result.status === 'cancelled') {
        // Confirmed by the server: a queued turn is cancelled at once (its reservation refunded).
        stopStream();
        setLive((prev) => (prev && prev.turnId === live.turnId ? { ...prev, status: 'cancelled', cancelling: false } : prev));
        patchMessage(live.conversationId, live.turnId, { status: 'cancelled' });
        void qc.invalidateQueries({ queryKey: aiKeys.detail(scope, live.conversationId) });
        refreshAvailability();
      } else if (result.status === 'cancelling') {
        // Running: the Worker stops within about half a second and the stream ends with `done` (cancelled).
        setLive((prev) => (prev && prev.turnId === live.turnId ? { ...prev, cancelling: true } : prev));
      } else {
        void qc.invalidateQueries({ queryKey: aiKeys.detail(scope, live.conversationId) });
      }
    } catch (error) {
      setProblem(describeSubmitError(error, () => void cancel()));
    } finally {
      setCancelBusy(false);
    }
  }, [cancelBusy, describeSubmitError, live, patchMessage, qc, refreshAvailability, scope, stopStream]);

  /** Manual reconnect after the automatic budget ran out: continues after the last event received. */
  const reconnect = useCallback(() => {
    if (!live || !ACTIVE.has(live.status)) return;
    follow(live.conversationId, live.turnId, live.status, live.lastEventId, live.text);
  }, [follow, live]);

  return {
    conversationId,
    detail,
    live: live && live.conversationId === conversationId ? live : null,
    activeTurn,
    queuedTurnId,
    cancelQueued,
    removingQueued,
    sending,
    send,
    cancel,
    cancelBusy,
    reconnect,
    problem,
    clearProblem: () => setProblem(null),
    limitSecondsLeft: problem?.until ? Math.max(0, Math.ceil((problem.until - now) / 1000)) : 0,
  };
}
