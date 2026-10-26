import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { IconCheck, IconChevronLeft, IconChevronRight, IconPencil, IconPlayerPlay, IconRefresh } from '@tabler/icons-react';
import {
  AI_ASSISTANT_COLOURS,
  AI_ASSISTANT_FACES,
  AI_ASSISTANT_LIMITS,
  AI_ASSISTANT_PRESET_KEYS,
  AI_ASSISTANT_PRESETS,
  AI_ASSISTANT_SHAPES,
  type AiAssistantColour,
  type AiAssistantFace,
  type AiAssistantPreset,
  type AiAssistantProfileUpdateRequest,
  type AiAssistantProfileView,
  type AiAssistantShape,
} from '@rab/shared';

import Popover from '../../../shared/components/Popover';
import AiAssistantAvatar, { lookOf } from '../../ai/avatar/AiAssistantAvatar';
import { AI_FACE_LABEL } from '../../ai/avatar/faces';
import { AI_SHAPE_LABEL, type AvatarShape } from '../../ai/avatar/shapes';

export const AI_COLOUR_LABEL: Record<AiAssistantColour, string> = {
  orange: 'Orange',
  amber: 'Amber',
  green: 'Green',
  teal: 'Teal',
  sky: 'Sky',
  blue: 'Blue',
  violet: 'Violet',
  rose: 'Rose',
  red: 'Red',
  grey: 'Grey',
};

// No control, bidi-override or zero-width characters in a name (the server re-validates; this is the early message).
// eslint-disable-next-line no-control-regex
const BAD_NAME = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/;

export function validateAssistantName(raw: string): string | null {
  const name = raw.trim();
  if (name.length < AI_ASSISTANT_LIMITS.nameMinChars || name.length > AI_ASSISTANT_LIMITS.nameMaxChars) return `Use 1 to ${AI_ASSISTANT_LIMITS.nameMaxChars} characters.`;
  if (BAD_NAME.test(name)) return 'Use letters, numbers and ordinary punctuation only.';
  return null;
}

/**
 * B2–B20: the assistant's look (CD-3). A radio group of Crewflow's presets plus "Customise", and a customise menu (name,
 * shape, colour, face, animate, reset). Every value is an enum from the contract; the name is plain text, shown with
 * the "AI" badge and never sent to the model. Changes are cosmetic: saved at once (audited server-side), no reason.
 */
export default function AiAvatarPicker({ profile, busy, onChange, onReset }: { profile: AiAssistantProfileView; busy: boolean; onChange: (change: AiAssistantProfileUpdateRequest) => void; onReset: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const customRef = useRef<HTMLButtonElement | null>(null);
  const radios = useRef<Array<HTMLButtonElement | null>>([]);
  const selected: AiAssistantPreset | 'custom' = profile.preset ?? 'custom';
  const keys: Array<AiAssistantPreset | 'custom'> = [...AI_ASSISTANT_PRESET_KEYS, 'custom'];

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + keys.length) % keys.length;
    radios.current[next]?.focus();
  };

  return (
    <div className="ai-avatar-grid" role="radiogroup" aria-label="Assistant look">
      {AI_ASSISTANT_PRESET_KEYS.map((key, i) => {
        const p = AI_ASSISTANT_PRESETS[key];
        const checked = selected === key;
        return (
          <button
            key={key}
            ref={(el) => {
              radios.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (selected === 'custom' && i === 0) ? 0 : -1}
            className="ai-avatar-card"
            data-selected={checked ? 'true' : 'false'}
            disabled={busy}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => !checked && onChange({ preset: key })}
          >
            <span className="ai-avatar-radio" aria-hidden="true">{checked && <IconCheck size={11} />}</span>
            <AiAssistantAvatar look={{ shape: p.shape, colour: p.colour, face: p.face, animate: profile.animate }} size="xl" />
            <strong>{p.name}</strong>
            <span>{SHAPE_PICKER_ENABLED ? `${AI_SHAPE_LABEL[p.shape]} · ${AI_COLOUR_LABEL[p.colour]}` : AI_COLOUR_LABEL[p.colour]}</span>
          </button>
        );
      })}
      <button
        ref={(el) => {
          radios.current[keys.length - 1] = el;
          customRef.current = el;
        }}
        type="button"
        role="radio"
        aria-checked={selected === 'custom'}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        tabIndex={selected === 'custom' ? 0 : -1}
        className="ai-avatar-card ai-avatar-card--custom"
        data-selected={selected === 'custom' ? 'true' : 'false'}
        disabled={busy}
        onKeyDown={(e) => onKey(e, keys.length - 1)}
        onClick={() => setMenuOpen(true)}
      >
        <span className="ai-avatar-card-art">
          <AiAssistantAvatar look={lookOf(profile)} size="xl" />
          <span className="ai-avatar-pencil" aria-hidden="true"><IconPencil size={10} /></span>
        </span>
        {selected === 'custom' ? (
          <>
            <strong className="ai-avatar-name">{profile.name}</strong>
            <span>{SHAPE_PICKER_ENABLED ? `${AI_SHAPE_LABEL[profile.shape]} · ${AI_COLOUR_LABEL[profile.colour]}` : AI_COLOUR_LABEL[profile.colour]}</span>
          </>
        ) : (
          <>
            <strong>Customise</strong>
            <span>{SHAPE_PICKER_ENABLED ? 'Shape, colour, face' : 'Name, colour, face'}</span>
          </>
        )}
      </button>
      <Popover open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={customRef} align="end" minWidth={260} className="ai-popover">
        <AiAvatarCustomiseMenu profile={profile} busy={busy} onChange={onChange} onReset={onReset} onClose={() => { setMenuOpen(false); customRef.current?.focus(); }} />
      </Popover>
    </div>
  );
}

type View = 'main' | 'shape' | 'colour' | 'face';

/**
 * Owner decision 2026-10-26: the avatar is ROUND ONLY for now. The shape picker's code path stays (the component and the
 * contract keep the `shape` field so other shapes can return), but the menu row is not offered.
 */
export const SHAPE_PICKER_ENABLED = false;

/** B12–B18: the customise menu. Escape closes it and returns focus to the "Customise" card. */
export function AiAvatarCustomiseMenu({ profile, busy, onChange, onReset, onClose }: { profile: AiAssistantProfileView; busy: boolean; onChange: (change: AiAssistantProfileUpdateRequest) => void; onReset: () => void; onClose: () => void }) {
  const [view, setView] = useState<View>('main');
  const [name, setName] = useState(profile.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameId = useId();
  const firstRef = useRef<HTMLInputElement | HTMLButtonElement | null>(null);
  useEffect(() => setName(profile.name), [profile.name]);
  useEffect(() => {
    firstRef.current?.focus();
  }, [view]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (view !== 'main') setView('main');
      else onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [view, onClose]);

  // A custom profile always carries every field (the contract: all of name/shape/colour/face).
  const custom = (patch: Partial<Pick<AiAssistantProfileView, 'name' | 'shape' | 'colour' | 'face' | 'animate'>>) =>
    onChange({ name: patch.name ?? profile.name, shape: patch.shape ?? profile.shape, colour: patch.colour ?? profile.colour, face: patch.face ?? profile.face, animate: patch.animate ?? profile.animate });

  const saveName = () => {
    const problem = validateAssistantName(name);
    setNameError(problem);
    if (!problem && name.trim() !== profile.name) custom({ name: name.trim() });
  };

  if (view !== 'main') {
    const options: ReadonlyArray<string> = view === 'shape' ? AI_ASSISTANT_SHAPES : view === 'colour' ? AI_ASSISTANT_COLOURS : AI_ASSISTANT_FACES;
    const label = (o: string) => (view === 'shape' ? AI_SHAPE_LABEL[o as AvatarShape] : view === 'colour' ? AI_COLOUR_LABEL[o as AiAssistantColour] : AI_FACE_LABEL[o as AiAssistantFace]);
    const current = view === 'shape' ? profile.shape : view === 'colour' ? profile.colour : profile.face;
    return (
      <div className="ai-menu" role="menu" aria-label={view === 'shape' ? 'Shape' : view === 'colour' ? 'Colour' : 'Face'}>
        <button ref={(el) => { firstRef.current = el; }} type="button" role="menuitem" className="ai-menu-item ai-menu-back" onClick={() => setView('main')}>
          <IconChevronLeft size={14} aria-hidden="true" />
          {view === 'shape' ? 'Shape' : view === 'colour' ? 'Colour' : 'Face'}
        </button>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="menuitemradio"
            aria-checked={o === current}
            className="ai-menu-item"
            disabled={busy}
            onClick={() => {
              custom(view === 'shape' ? { shape: o as AiAssistantShape } : view === 'colour' ? { colour: o as AiAssistantColour } : { face: o as AiAssistantFace });
              setView('main');
            }}
          >
            <AiAssistantAvatar look={{ ...lookOf(profile), animate: false, ...(view === 'shape' ? { shape: o as AiAssistantShape } : view === 'colour' ? { colour: o as AiAssistantColour } : { face: o as AiAssistantFace }) }} size="sm" />
            <span>{label(o)}</span>
            {o === current && <IconCheck size={14} className="ai-menu-check" aria-hidden="true" />}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="ai-menu" role="menu" aria-label="Customise the assistant">
      <div className="ai-menu-name">
        <AiAssistantAvatar look={lookOf(profile)} size="sm" />
        <label htmlFor={nameId} className="visually-hidden">Assistant name</label>
        <input
          id={nameId}
          ref={(el) => { firstRef.current = el; }}
          value={name}
          maxLength={AI_ASSISTANT_LIMITS.nameMaxChars + 8}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={`${nameId}-hint`}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              saveName();
            }
          }}
        />
        <span className="ai-badge-ai" aria-hidden="true">AI</span>
      </div>
      <p id={`${nameId}-hint`} className={nameError ? 'ai-set-field-error ai-menu-hint' : 'ai-menu-hint'} role={nameError ? 'alert' : undefined}>
        {nameError ?? 'Shown with an “AI” badge. Never sent to the AI model.'}
      </p>
      {SHAPE_PICKER_ENABLED && <button type="button" role="menuitem" className="ai-menu-item" aria-haspopup="menu" onClick={() => setView('shape')}>
        <AiAssistantAvatar look={{ ...lookOf(profile), animate: false }} size="xs" />
        <span>Shape</span>
        <span className="ai-menu-value">{AI_SHAPE_LABEL[profile.shape]}</span>
        <IconChevronRight size={14} aria-hidden="true" />
      </button>}
      <button type="button" role="menuitem" className="ai-menu-item" aria-haspopup="menu" onClick={() => setView('colour')}>
        <span className={`ai-colour-dot ai-av--${profile.colour}`} aria-hidden="true" />
        <span>Colour</span>
        <span className="ai-menu-value">{AI_COLOUR_LABEL[profile.colour]}</span>
        <IconChevronRight size={14} aria-hidden="true" />
      </button>
      <button type="button" role="menuitem" className="ai-menu-item" aria-haspopup="menu" onClick={() => setView('face')}>
        <AiAssistantAvatar look={{ ...lookOf(profile), animate: false }} size="xs" />
        <span>Face</span>
        <span className="ai-menu-value">{AI_FACE_LABEL[profile.face]}</span>
        <IconChevronRight size={14} aria-hidden="true" />
      </button>
      <div className="ai-menu-sep" role="separator" />
      <button type="button" role="menuitemcheckbox" aria-checked={profile.animate} className="ai-menu-item" disabled={busy} onClick={() => custom({ animate: !profile.animate })}>
        <IconPlayerPlay size={14} aria-hidden="true" />
        <span>Animate</span>
        <span className="ai-switch" data-on={profile.animate ? 'true' : 'false'} aria-hidden="true"><i /></span>
      </button>
      <button type="button" role="menuitem" className="ai-menu-item" disabled={busy || profile.isDefault} onClick={onReset}>
        <IconRefresh size={14} aria-hidden="true" />
        <span>Reset to default</span>
      </button>
    </div>
  );
}
