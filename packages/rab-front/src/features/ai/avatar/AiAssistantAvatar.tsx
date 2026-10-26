import { AI_ASSISTANT_PRESETS, AI_DEFAULT_ASSISTANT_PRESET, type AiAssistantColour, type AiAssistantFace, type AiAssistantProfileView, type AiAssistantShape } from '@rab/shared';

import { AvatarFace, type AiAvatarState } from './faces';
import { shapePath } from './shapes';
import './avatar.css';

/** K13: the size scale (px). */
export const AI_AVATAR_SIZES = { xs: 12, sm: 16, md: 20, lg: 28, xl: 40, xxl: 64 } as const;
export type AiAvatarSize = keyof typeof AI_AVATAR_SIZES;

export interface AiAvatarLook {
  shape: AiAssistantShape;
  colour: AiAssistantColour;
  face: AiAssistantFace;
  animate: boolean;
}

const DEFAULT = AI_ASSISTANT_PRESETS[AI_DEFAULT_ASSISTANT_PRESET];

/** The default preset's look (no stored profile = the default, CD-3). */
export const DEFAULT_AVATAR_LOOK: AiAvatarLook = { shape: DEFAULT.shape, colour: DEFAULT.colour, face: DEFAULT.face, animate: true };

/** The look of a server profile, or the default preset when there is none. */
export function lookOf(profile: Pick<AiAssistantProfileView, 'shape' | 'colour' | 'face' | 'animate'> | null | undefined): AiAvatarLook {
  return profile ? { shape: profile.shape, colour: profile.colour, face: profile.face, animate: profile.animate } : DEFAULT_AVATAR_LOOK;
}

/**
 * The assistant's avatar (K12): `AiAssistantAvatar({shape, colour, face, state, size, animate})`. Pure SVG + CSS tokens
 * (`--ai-avatar-{colour}-body` / `-face`, light and dark). Always `aria-hidden`: the state is announced by the chat's own
 * status text, never by the picture. Animation is presentation only and is off under `prefers-reduced-motion`.
 */
export default function AiAssistantAvatar({ look = DEFAULT_AVATAR_LOOK, state = 'idle', size = 'md', className = '' }: { look?: AiAvatarLook; state?: AiAvatarState; size?: AiAvatarSize | number; className?: string }) {
  const px = typeof size === 'number' ? size : AI_AVATAR_SIZES[size];
  return (
    <span
      className={`ai-av ai-av--${look.colour}${className ? ` ${className}` : ''}`}
      data-state={state}
      data-animate={look.animate ? 'true' : 'false'}
      data-shape={look.shape}
      data-face={look.face}
      style={{ width: px, height: px }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 64 64" width={px} height={px} focusable="false">
        <path className="ai-av-body" d={shapePath(look.shape)} />
        <g className="ai-av-face">
          <AvatarFace face={look.face} state={state} />
        </g>
      </svg>
    </span>
  );
}
