import { useRef, type KeyboardEvent, type RefObject } from 'react';
import { IconBook, IconCheck, IconPlus, IconX } from '@tabler/icons-react';
import { AI_SKILL_LIMITS, type AiSkillSummaryView } from '@rab/shared';

import Popover from '../../shared/components/Popover';

/** 4w submit tagging: at most this many skill NAMES per question (the server checks each is active and readable). */
export const MAX_TAGGED_SKILLS = AI_SKILL_LIMITS.maxTaggedPerMessage;

/**
 * U3: the composer's "＋ Tag a skill" button and menu (also opened by typing "/" in an empty composer). It lists the
 * ACTIVE skills the server returns from `GET /ai/skills` (label + description, plain text; never content) and toggles up
 * to {@link MAX_TAGGED_SKILLS}. Tagging only asks the assistant to load that skill's instructions: a skill gives no
 * permission and no tool. Nothing is sent from here — the names travel with the question on submit.
 */
export function AiSkillTagButton({
  skills,
  selected,
  onToggle,
  open,
  onOpenChange,
  anchorRef,
  disabled = false,
}: {
  skills: AiSkillSummaryView[];
  selected: string[];
  onToggle: (name: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<HTMLButtonElement>;
  disabled?: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // The popover mounts its content in a portal (after its own positioning): focus the first item once the menu exists,
  // and never pull focus back while the person moves through it.
  const attachList = (el: HTMLDivElement | null) => {
    listRef.current = el;
    if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>('[role="menuitemcheckbox"]:not([aria-disabled="true"])')?.focus();
  };
  const full = selected.length >= MAX_TAGGED_SKILLS;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? []);
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]!.focus();
  };
  const close = () => {
    onOpenChange(false);
    anchorRef.current?.focus();
  };
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="ai-composer-chip"
        aria-label="Tag a skill"
        title="Tag a skill (or type /)"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        <IconPlus size={15} />
      </button>
      <Popover open={open} onClose={close} anchorRef={anchorRef} align="start" minWidth={280} className="ai-popover" role="presentation">
        <div ref={attachList} className="ai-skill-menu" role="menu" aria-label="Skills" onKeyDown={onKeyDown}>
          <p className="ai-skill-menu-note" role="presentation">{`Tag up to ${MAX_TAGGED_SKILLS} skills. A skill gives the assistant instructions, never permissions or tools.`}</p>
          {skills.length === 0 && <p className="ai-muted ai-skill-menu-note" role="presentation">No skills are switched on.</p>}
          {skills.map((s) => {
            const checked = selected.includes(s.name);
            const blocked = !checked && full;
            return (
              <div
                key={s.name}
                role="menuitemcheckbox"
                tabIndex={-1}
                aria-checked={checked}
                aria-disabled={blocked || undefined}
                className="ai-skill-item"
                onClick={() => !blocked && onToggle(s.name)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !blocked) {
                    e.preventDefault();
                    onToggle(s.name);
                  }
                }}
              >
                <span className="ai-skill-check" aria-hidden="true">{checked ? <IconCheck size={13} /> : <IconBook size={13} />}</span>
                <span className="ai-skill-text">
                  <strong>{s.label}</strong>
                  <span>{s.description}</span>
                </span>
              </div>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

/** The tagged skills above the composer text, each removable. Labels from the server list; unknown names show as names. */
export function AiSkillTagChips({ selected, labels, onRemove }: { selected: string[]; labels: Readonly<Record<string, string>>; onRemove: (name: string) => void }) {
  if (!selected.length) return null;
  return (
    <ul className="ai-skill-tags" aria-label="Tagged skills">
      {selected.map((name) => (
        <li key={name} className="ai-skill-tag">
          <IconBook size={12} aria-hidden="true" />
          <span>{labels[name] ?? name}</span>
          <button type="button" aria-label={`Remove skill: ${labels[name] ?? name}`} onClick={() => onRemove(name)}>
            <IconX size={11} />
          </button>
        </li>
      ))}
    </ul>
  );
}
