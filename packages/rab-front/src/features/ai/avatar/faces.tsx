import type { ReactNode } from 'react';
import type { AiAssistantFace } from '@rab/shared';

/**
 * Crewflow assistant faces — ORIGINAL glyphs built from SVG primitives (`rect`, `circle`, `path`) in the same 64×64 box
 * as the silhouettes (TWENTY_UI_INVENTORY §3, K1–K8). No image files and no copied artwork. Motion is CSS only
 * (`avatar.css`: transform/opacity keyframes), switched off by `prefers-reduced-motion` and by `animate = false`.
 */

/** CD-12: the avatar's presentation states, driven only by server signals (see useAvatarState). */
export type AiAvatarState = 'idle' | 'thinking' | 'listening' | 'talking' | 'happy' | 'error' | 'waiting' | 'ack' | 'sleepy' | 'sleeping';
export const AI_AVATAR_STATES: readonly AiAvatarState[] = ['idle', 'thinking', 'listening', 'talking', 'happy', 'error', 'waiting', 'ack', 'sleepy', 'sleeping'];
/** The six states of the owner's U1 mockup ("Agent avatar / Dots"): idle, thinking, listening, happy, error, sleepy. */
export const AI_AVATAR_MOCKUP_STATES: readonly AiAvatarState[] = ['idle', 'thinking', 'listening', 'happy', 'error', 'sleepy'];

export const AI_FACE_LABEL: Record<AiAssistantFace, string> = {
  classic: 'Classic',
  smile: 'Smile',
  tall: 'Tall',
  round: 'Round',
  calm: 'Calm',
  warm: 'Warm',
};

const LEFT = 25;
const RIGHT = 39;
const EYE_Y = 32;
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 3.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

const arc = (x: number) => <path d={`M${x - 4.5} ${EYE_Y + 2} Q${x} ${EYE_Y - 5} ${x + 4.5} ${EYE_Y + 2}`} {...stroke} />;
const heart = (x: number) => (
  <path d={`M${x} ${EYE_Y + 4.6} C${x - 6.4} ${EYE_Y + 0.4} ${x - 5} ${EYE_Y - 5.2} ${x} ${EYE_Y - 2} C${x + 5} ${EYE_Y - 5.2} ${x + 6.4} ${EYE_Y + 0.4} ${x} ${EYE_Y + 4.6} Z`} fill="currentColor" />
);
const cross = (x: number) => <path d={`M${x - 3.6} ${EYE_Y - 3.6} L${x + 3.6} ${EYE_Y + 3.6} M${x + 3.6} ${EYE_Y - 3.6} L${x - 3.6} ${EYE_Y + 3.6}`} {...stroke} />;
const bar = (x: number, w: number, h: number) => <rect x={x - w / 2} y={EYE_Y - h / 2} width={w} height={h} rx={w / 2} fill="currentColor" />;
const line = (x: number) => <rect x={x - 4.5} y={EYE_Y - 1.5} width={9} height={3} rx={1.5} fill="currentColor" />;

/** The resting eyes of each face option (also the base of the blink). */
function eyes(face: AiAssistantFace, x: number): ReactNode {
  switch (face) {
    case 'smile':
      return arc(x);
    case 'tall':
      return bar(x, 4, 14);
    case 'round':
      return <circle cx={x} cy={EYE_Y} r={4} fill="currentColor" />;
    case 'calm':
      return line(x);
    case 'warm':
      return heart(x);
    case 'classic':
    default:
      return bar(x, 5, 11);
  }
}

/** The face for one state. Idle shows the chosen face; the other states are shared glyphs (with the face's colour). */
export function AvatarFace({ face, state }: { face: AiAssistantFace; state: AiAvatarState }) {
  switch (state) {
    case 'thinking':
      return (
        <g className="ai-av-thinking">
          {[22, 32, 42].map((x, i) => <circle key={x} className="ai-av-dot" style={{ animationDelay: `${i * 140}ms` }} cx={x} cy={EYE_Y + 1} r={3.1} fill="currentColor" />)}
        </g>
      );
    // `listening` (U1 mockup; voice later) and `talking` share the waveform glyph.
    case 'listening':
    case 'talking':
      return (
        <g className="ai-av-talking">
          {[[21, 6], [26.5, 12], [32, 16], [37.5, 10], [43, 6]].map(([x, h], i) => (
            <g key={x} className="ai-av-bar" style={{ animationDelay: `${i * 90}ms` }}>{bar(x!, 3.4, h!)}</g>
          ))}
        </g>
      );
    case 'happy':
      return <g className="ai-av-happy">{arc(LEFT)}{arc(RIGHT)}</g>;
    case 'error':
      return <g className="ai-av-error">{cross(LEFT)}{cross(RIGHT)}</g>;
    case 'waiting':
      return <g className="ai-av-waiting"><circle cx={LEFT} cy={EYE_Y} r={5} fill="currentColor" /><circle cx={RIGHT} cy={EYE_Y} r={5} fill="currentColor" /></g>;
    case 'ack':
      return <g className="ai-av-ack">{eyes(face, LEFT)}{arc(RIGHT)}</g>;
    // `sleepy` (U1 mockup name) = `sleeping`: shown when the assistant is unavailable.
    case 'sleepy':
    case 'sleeping':
      return (
        <g className="ai-av-sleeping">
          {line(LEFT)}
          {line(RIGHT)}
          <path className="ai-av-z" d="M44 16 L50 16 L44 23 L50 23" {...stroke} strokeWidth={2.2} />
        </g>
      );
    case 'idle':
    default:
      return <g className="ai-av-eyes">{eyes(face, LEFT)}{eyes(face, RIGHT)}</g>;
  }
}
