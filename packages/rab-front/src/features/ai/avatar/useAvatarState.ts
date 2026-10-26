import { useEffect, useRef, useState } from 'react';

import type { AiAvatarState } from './faces';

/** The server signals the avatar reacts to (CD-12). Nothing here is a client timer implying progress. */
export interface AvatarSignals {
  /** False when AI is unavailable, not set up, or the allowance is used up (→ sleeping). */
  usable: boolean;
  /** The followed turn's server status, or null when there is no turn on screen. */
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting_for_input' | null;
  /** `reasoning: started` received and not yet finished. */
  reasoning: boolean;
  /** A tool `started` event is open. */
  toolRunning: boolean;
  /** Time of the last text delta received (ms epoch), or null. */
  lastDeltaAt: number | null;
  /** Bumped by the caller once per executed proposal (P5) — a one-off wink. */
  ackCount?: number;
}

const TALK_HOLD_MS = 1_000;
const HAPPY_HOLD_MS = 1_500;
const ACK_HOLD_MS = 1_200;

/** The CD-12 table as a pure function (the holds are applied by the hook). */
export function baseAvatarState(s: AvatarSignals, now: number): AiAvatarState {
  if (!s.usable) return 'sleepy';
  switch (s.status) {
    case 'queued':
      return 'thinking';
    case 'running':
      if (s.reasoning || s.toolRunning) return 'thinking';
      return s.lastDeltaAt !== null && now - s.lastDeltaAt < TALK_HOLD_MS ? 'talking' : 'thinking';
    case 'waiting_for_input':
      return 'waiting';
    case 'failed':
      return 'error';
    default:
      return 'idle';
  }
}

/**
 * CD-12 avatar state machine: server events → avatar state. `happy` lasts 1.5 s after a completed turn and `talking` 1 s
 * after the last delta — presentation-only holds; the avatar is `aria-hidden` and the chat's status text announces state.
 */
export function useAvatarState(s: AvatarSignals): AiAvatarState {
  const [now, setNow] = useState(() => Date.now());
  const [happyUntil, setHappyUntil] = useState(0);
  const [ackUntil, setAckUntil] = useState(0);
  const prevStatus = useRef(s.status);
  const prevAck = useRef(s.ackCount ?? 0);

  useEffect(() => {
    if (prevStatus.current !== 'completed' && s.status === 'completed' && prevStatus.current !== null) setHappyUntil(Date.now() + HAPPY_HOLD_MS);
    prevStatus.current = s.status;
  }, [s.status]);
  useEffect(() => {
    if ((s.ackCount ?? 0) > prevAck.current) setAckUntil(Date.now() + ACK_HOLD_MS);
    prevAck.current = s.ackCount ?? 0;
  }, [s.ackCount]);

  // Re-evaluate when a hold expires (one timeout, not a ticking clock).
  const nextExpiry = Math.min(
    ...[happyUntil, ackUntil, s.lastDeltaAt !== null ? s.lastDeltaAt + TALK_HOLD_MS : 0].filter((t) => t > now),
  );
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - Date.now()) + 10);
    return () => clearTimeout(t);
  }, [nextExpiry]);
  useEffect(() => setNow(Date.now()), [s.lastDeltaAt, s.status, s.reasoning, s.toolRunning, s.usable]);

  const base = baseAvatarState(s, now);
  if (base === 'idle' && ackUntil > now) return 'ack';
  if (base === 'idle' && happyUntil > now) return 'happy';
  return base;
}
