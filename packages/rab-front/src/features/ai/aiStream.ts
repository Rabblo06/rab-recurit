import { AI_PLAN_LIMITS, type AiErrorCodeType, type AiPlanStep, type AiStreamEvent, type AiStreamEventV2 } from '@rab/shared';

import { api } from '../../shared/api';
import { getAccessToken, getIdentitySnapshot, getSessionId } from '../../shared/lib/auth-session';

/**
 * The AI turn stream (`GET /rest/v1/ai/conversations/:id/stream?turnId=…`, Server-Sent Events) read with `fetch` + a
 * `ReadableStream` reader — the same choice as `shared/lib/realtime-client.ts`, for the same reason: `EventSource`
 * cannot send headers, and this app fences every authenticated request with `X-Crewflow-Expected-Session-Id`.
 *
 *  - Authentication is the session cookie (`credentials: 'include'`). No token ever goes in the URL; the only query
 *    parameter is the turn id.
 *  - Resume: every event's SSE `id` is remembered; a reconnect sends it as `Last-Event-ID`, so the server continues
 *    after it (or sends the persisted answer once the stream expired). The model is never re-run by a reconnect.
 *  - Reconnects only while the turn is not finished: a `done` or `error` event ends the stream for good.
 *  - Bounded: at most `maxFailures` consecutive failed attempts, exponential backoff with jitter.
 *  - A browser identity change (logout, another account) aborts at once and delivers nothing more.
 */

/**
 * What the chat consumes: the Phase 1 events plus the C1 (CD-7) `reasoning` (DURATION only) and `plan` events. Every
 * other V2 kind (keepalive, title, proposal, …) is dropped here until its phase's UI exists.
 */
export type AiChatStreamEvent = AiStreamEvent | Extract<AiStreamEventV2, { type: 'reasoning' | 'plan' }>;

export type AiStreamEnd =
  | { kind: 'done' }
  | { kind: 'error'; errorCode: AiErrorCodeType }
  | { kind: 'http'; status: number; code: string | null }
  | { kind: 'network' }
  | { kind: 'identity' };

export interface AiStreamOptions {
  conversationId: string;
  turnId: string;
  onEvent: (event: AiChatStreamEvent) => void;
  onEnd: (end: AiStreamEnd) => void;
  /** Called before each reconnect attempt (1, 2, …) so the UI can say "Reconnecting…". */
  onReconnecting?: (attempt: number) => void;
  /** Called once a (re)connection is open and streaming. */
  onOpen?: () => void;
  /** Resume after this SSE id (a manual reconnect continues where the previous stream stopped). */
  lastEventId?: string | null;
  fetchImpl?: typeof fetch;
  maxFailures?: number;
  backoffMs?: (attempt: number) => number;
}

export interface AiStreamHandle {
  stop: () => void;
  /** The last SSE id received (the resume cursor). Exposed for tests and diagnostics. */
  lastEventId: () => string | null;
}

const STREAM_ID = /^\d{1,20}-\d{1,20}$/;
const defaultBackoff = (attempt: number) => Math.min(8_000, 500 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);

interface Frame {
  id: string | null;
  event: string | null;
  data: string;
}

/** Parses one SSE frame (lines between blank lines). Comments (`:`) and unknown fields are ignored. */
export function parseSseFrame(raw: string): Frame | null {
  let id: string | null = null;
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  return { id, event, data: data.join('\n') };
}

function isStreamEvent(value: unknown, turnId: string): value is AiStreamEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown; turnId?: unknown };
  return v.turnId === turnId && (v.type === 'status' || v.type === 'delta' || v.type === 'tool' || v.type === 'done' || v.type === 'error');
}

const PLAN_STATUSES = new Set(['pending', 'in_progress', 'done']);

/**
 * Rebuilds a CD-7 event from its ALLOWED fields only, so nothing else a server (or an attacker in the middle) put on it can
 * reach React state: a `reasoning` event keeps its phase and a numeric duration — any `text` / `delta` / `signature` is
 * dropped (rule 11.2, TW-D7); a `plan` keeps at most 8 steps of plain-text labels (≤ 100 chars) and a known status.
 */
export function sanitiseCd7Event(value: unknown, turnId: string): Extract<AiStreamEventV2, { type: 'reasoning' | 'plan' }> | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { type?: unknown; turnId?: unknown; phase?: unknown; durationMs?: unknown; steps?: unknown };
  if (v.turnId !== turnId) return null;
  if (v.type === 'reasoning') {
    if (v.phase !== 'started' && v.phase !== 'finished') return null;
    const duration = typeof v.durationMs === 'number' && Number.isFinite(v.durationMs) && v.durationMs >= 0 ? Math.round(v.durationMs) : undefined;
    return duration === undefined ? { type: 'reasoning', turnId, phase: v.phase } : { type: 'reasoning', turnId, phase: v.phase, durationMs: duration };
  }
  if (v.type === 'plan' && Array.isArray(v.steps)) {
    const steps: AiPlanStep[] = [];
    for (const raw of v.steps.slice(0, AI_PLAN_LIMITS.maxSteps)) {
      const step = raw as { label?: unknown; status?: unknown };
      if (typeof step?.label !== 'string' || typeof step.status !== 'string' || !PLAN_STATUSES.has(step.status)) continue;
      steps.push({ label: step.label.slice(0, AI_PLAN_LIMITS.labelMaxChars), status: step.status as AiPlanStep['status'] });
    }
    return { type: 'plan', turnId, steps };
  }
  return null;
}

export function openAiStream(opts: AiStreamOptions): AiStreamHandle {
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const maxFailures = opts.maxFailures ?? 6;
  const backoff = opts.backoffMs ?? defaultBackoff;
  const generation = getIdentitySnapshot().generation;
  let lastEventId: string | null = opts.lastEventId && STREAM_ID.test(opts.lastEventId) ? opts.lastEventId : null;
  let stopped = false;
  let finished = false;
  let failures = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = (end: AiStreamEnd) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    controller?.abort();
    if (!stopped) opts.onEnd(end);
  };
  const identityMoved = () => getIdentitySnapshot().generation !== generation;

  const retry = () => {
    if (stopped || finished) return;
    failures += 1;
    if (failures > maxFailures) return finish({ kind: 'network' });
    opts.onReconnecting?.(failures);
    timer = setTimeout(() => void connect(), backoff(failures));
  };

  async function connect(): Promise<void> {
    if (stopped || finished) return;
    if (identityMoved()) return finish({ kind: 'identity' });
    controller = new AbortController();
    const headers: Record<string, string> = { Accept: 'text/event-stream', 'X-Application-Target': 'manager_web' };
    const sid = getSessionId();
    if (sid) headers['X-Crewflow-Expected-Session-Id'] = sid;
    const token = getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;
    const url = `${api.defaults.baseURL}/ai/conversations/${encodeURIComponent(opts.conversationId)}/stream?turnId=${encodeURIComponent(opts.turnId)}`;
    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'GET', credentials: 'include', headers, signal: controller.signal, cache: 'no-store' });
    } catch {
      if (stopped || finished) return;
      return retry();
    }
    if (stopped || finished) return;
    if (identityMoved()) return finish({ kind: 'identity' });
    if (!response.ok || !response.body) {
      let code: string | null = null;
      try {
        const body = (await response.json()) as { code?: unknown };
        code = typeof body?.code === 'string' ? body.code : null;
      } catch {
        /* not JSON */
      }
      // 429 = this browser already holds the per-user number of open streams; a short wait usually frees one.
      // 5xx = a transient API problem. Everything else (401/403/404) is final: the hook decides what it means.
      if (response.status === 429 || response.status >= 500) return retry();
      return finish({ kind: 'http', status: response.status, code });
    }

    opts.onOpen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (stopped || finished) return;
        if (identityMoved()) return finish({ kind: 'identity' });
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let match: RegExpExecArray | null;
        // eslint-disable-next-line no-cond-assign
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const raw = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const frame = parseSseFrame(raw);
          if (!frame) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(frame.data);
          } catch {
            continue; // malformed frame: dropped, never rendered
          }
          const cd7 = isStreamEvent(parsed, opts.turnId) ? null : sanitiseCd7Event(parsed, opts.turnId);
          if (!cd7 && !isStreamEvent(parsed, opts.turnId)) continue; // never anything that is not this turn's
          if (frame.id && STREAM_ID.test(frame.id)) lastEventId = frame.id;
          failures = 0; // this connection delivered: the next drop starts the backoff again from the beginning
          if (cd7) {
            opts.onEvent(cd7);
            continue;
          }
          opts.onEvent(parsed as AiStreamEvent);
          const event = parsed as AiStreamEvent;
          if (event.type === 'done') return finish({ kind: 'done' });
          if (event.type === 'error') return finish({ kind: 'error', errorCode: event.errorCode });
        }
      }
    } catch {
      if (stopped || finished) return;
    }
    // The stream closed before the turn finished (server's 10-minute cap, a proxy, a network drop): resume.
    retry();
  }

  void connect();
  return {
    stop: () => {
      stopped = true;
      finished = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    },
    lastEventId: () => lastEventId,
  };
}
