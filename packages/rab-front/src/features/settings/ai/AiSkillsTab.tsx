import { useId, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  IconBook,
  IconBrain,
  IconBuilding,
  IconCalendarWeek,
  IconChartBar,
  IconChevronRight,
  IconCircleCheck,
  IconCircleOff,
  IconClockHour4,
  IconHelpCircle,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTool,
  IconTrash,
  IconUsers,
} from '@tabler/icons-react';
import { AI_SKILL_LIMITS, AI_SKILL_NAME_PATTERN, type AiSkillView } from '@rab/shared';

import { aiKeys } from '../../ai/aiApi';
import { useAiChat } from '../../ai/AiChatProvider';
import SafeMarkdown from '../../ai/SafeMarkdown';
import AiReasonDialog, { NotAvailableYet } from './AiReasonDialog';
import AiSetCrumb from './AiSetCrumb';
import { aiSettingsApi } from './aiSettingsApi';

/** D1 / E1: a decorative, fixed-copy illustration of the assistant's step lines. No data, `aria-hidden`. */
export function AiStepsIllustration({ lines }: { lines: string[] }) {
  return (
    <div className="ai-illustration" aria-hidden="true">
      <ul>
        {lines.map((l, i) => (
          <li key={i}>{i % 2 ? <IconTool size={12} /> : <IconBrain size={12} />}{l}</li>
        ))}
      </ul>
    </div>
  );
}

/** "S Standard" / "C Custom" (the mockup's App column). The text carries the meaning; the glyph is decoration. */
export function AiAppBadge({ standard }: { standard: boolean }) {
  return (
    <span className="ai-app-badge" data-kind={standard ? 'standard' : 'custom'}>
      <i aria-hidden="true">{standard ? 'S' : 'C'}</i>
      {standard ? 'Standard' : 'Custom'}
    </span>
  );
}

/** Tabler icons for the built-in skills (the mockup's emoji); a custom skill gets the pencil. Decorative only. */
const SKILL_ICON: Record<string, typeof IconBook> = {
  'rota-building': IconCalendarWeek,
  'shift-filling': IconUsers,
  'timesheet-review': IconClockHour4,
  'coverage-report': IconChartBar,
  'venue-onboarding': IconBuilding,
  'crewflow-help': IconHelpCircle,
};
const skillIcon = (s: Pick<AiSkillView, 'name' | 'isSystem'>) => (s.isSystem ? SKILL_ICON[s.name] ?? IconBook : IconPencil);

const SKILL_REFUSAL_TEXT: Record<string, string> = {
  AI_SKILL_CONTENT_REFUSED: 'This skill can’t be saved: it contains something the assistant may not be given (markup, hidden characters, personal data or something that looks like a secret).',
  AI_SKILL_LIMIT_REACHED: `Your organisation already has ${AI_SKILL_LIMITS.maxCustomPerOrganisation} custom skills. Delete one first.`,
  AI_SKILL_NOT_AVAILABLE: 'That skill is not available any more. Refresh the page.',
  AI_SKILL_NAME_TAKEN: 'A skill with that name already exists (built-in names are taken too). Choose another name.',
};

/** "612 / 20,000": a counter against a SERVER limit (never a client-invented one). */
export const countText = (n: number, max: number) => `${n.toLocaleString('en-GB')} / ${max.toLocaleString('en-GB')}`;

/**
 * Settings → AI → Skills (Phase 4 API; TWENTY_UI_INVENTORY D1–D19; U4 settings mockup; rendered only when
 * `features.skills`). Skills are instructions only: they give the assistant no permission and no tool. Standard
 * (built-in) skills can ONLY be switched on or off; custom skills can be created, edited and deleted. Every write needs a
 * reason and a recent step-up (P4-D4). The counters use the server's limits (`AI_SKILL_LIMITS`: content 20,000,
 * description 300). Previews use `SafeMarkdown` (no HTML, no images, safe links only).
 */
export default function AiSkillsTab() {
  const { scope } = useAiChat();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const searchId = useId();
  const skills = useQuery({ queryKey: aiKeys.settingsArea(scope, 'skills'), queryFn: aiSettingsApi.skills, retry: false });
  const selected = params.get('skill');
  const list = skills.data?.skills ?? [];
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? list.filter((s) => `${s.label} ${s.name} ${s.description}`.toLowerCase().includes(q)) : list;
  }, [filter, list]);
  const go = (skill: string | null) => {
    const next = new URLSearchParams(params);
    if (skill) next.set('skill', skill);
    else next.delete('skill');
    setParams(next);
  };

  if (skills.isLoading) return <p className="ai-set-muted" role="status">Loading skills…</p>;
  if (skills.isError || !skills.data) return <p className="ai-set-notice" role="alert">Skills could not be loaded. Refresh the page to try again.</p>;
  const atLimit = skills.data.customCount >= AI_SKILL_LIMITS.maxCustomPerOrganisation;
  if (selected) {
    const skill = selected === 'new' ? null : list.find((s) => s.name === selected);
    if (selected === 'new' || skill) return <AiSkillDetail skill={skill ?? null} onBack={() => go(null)} />;
  }

  return (
    <>
      <AiStepsIllustration lines={['Thought for 2 s', 'Loaded skill: Shift filling', 'Checked unfilled shifts', 'Loaded skill: Coverage report']} />
      <section className="settings-section" aria-labelledby="ai-skills-title">
        <h3 id="ai-skills-title">Skills</h3>
        <p>Instructions the assistant loads when a task needs them. Skills teach; they never give extra permissions or tools.</p>
        {atLimit && <p className="ai-set-notice" role="note">{SKILL_REFUSAL_TEXT.AI_SKILL_LIMIT_REACHED}</p>}
        <div className="ai-set-search">
          <IconSearch size={14} aria-hidden="true" />
          <label htmlFor={searchId} className="visually-hidden">Search skills</label>
          <input id={searchId} type="search" placeholder="Search a skill…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="table-container">
          <table className="table ai-set-table ai-set-table--links">
            <caption className="visually-hidden">Skills</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Description</th><th scope="col">App</th><th scope="col"><span className="visually-hidden">Open</span></th></tr></thead>
            <tbody>
              {shown.map((s) => {
                const Icon = skillIcon(s);
                return (
                  <tr key={s.name} data-skill={s.name} onClick={() => go(s.name)}>
                    <td>
                      <span className="ai-set-skill">
                        <Icon size={14} aria-hidden="true" />
                        <strong>{s.label}</strong>
                        {!s.isActive && <span className="ai-pill" data-tone="neutral">Off</span>}
                      </span>
                    </td>
                    <td className="ai-set-cell-muted">{s.description}</td>
                    <td><AiAppBadge standard={s.isSystem} /></td>
                    <td className="ai-set-cell-end">
                      <button type="button" className="btn-icon" aria-label={`Open ${s.label}`} onClick={(e) => { e.stopPropagation(); go(s.name); }}><IconChevronRight size={15} /></button>
                    </td>
                  </tr>
                );
              })}
              {!shown.length && <tr><td colSpan={4} className="ai-set-muted">No skill matches your search.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="ai-set-actions ai-set-actions--end">
          <button type="button" className="btn btn-outline btn-sm" disabled={atLimit} title={atLimit ? SKILL_REFUSAL_TEXT.AI_SKILL_LIMIT_REACHED : undefined} onClick={() => go('new')}><IconPlus size={14} aria-hidden="true" />Create skill</button>
        </div>
      </section>
    </>
  );
}

type Pending = { kind: 'save' } | { kind: 'toggle'; active: boolean } | { kind: 'delete' };

/**
 * D13–D18 / U4 skill page ("Skills › Shift filling"): Name, Instructions (Markdown, counter / 20,000), Description
 * (counter / 300), Danger zone. A STANDARD skill: every field read-only ("Standard skill: only on/off can change"), Delete
 * disabled with its reason. Its instruction text is Crewflow code: shown read-only when the server sends it (R-U3), and
 * "Not available yet" while `content` is null — never anything made up.
 */
export function AiSkillDetail({ skill, onBack }: { skill: AiSkillView | null; onBack: () => void }) {
  const { scope } = useAiChat();
  const qc = useQueryClient();
  const ids = { name: useId(), label: useId(), description: useId(), content: useId() };
  const [name, setName] = useState('');
  const [label, setLabel] = useState(skill?.label ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [content, setContent] = useState(skill?.content ?? '');
  const [preview, setPreview] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const isNew = skill === null;
  const standard = !isNew && skill.isSystem;
  const tooLong = content.length > AI_SKILL_LIMITS.maxContentChars;
  const descTooLong = description.length > AI_SKILL_LIMITS.maxDescriptionChars;
  const nameOk = !isNew || AI_SKILL_NAME_PATTERN.test(name);
  const valid = nameOk && label.trim().length > 0 && label.length <= AI_SKILL_LIMITS.maxLabelChars && description.trim().length > 0 && !descTooLong && content.trim().length > 0 && !tooLong;
  const changed = isNew || label !== skill.label || description !== skill.description || content !== (skill.content ?? '');
  const title = isNew ? 'New skill' : skill.label;
  const done = () => {
    void qc.invalidateQueries({ queryKey: aiKeys.settingsArea(scope, 'skills') });
    void qc.invalidateQueries({ queryKey: aiKeys.settingsArea(scope, 'prompt') });
    setPending(null);
    if (isNew) onBack();
  };

  return (
    <>
      <AiSetCrumb parent="Skills" current={title} onParent={onBack} headingId="ai-skill-title" />
      <form className="ai-skill-page" noValidate onSubmit={(e) => { e.preventDefault(); if (!standard && valid && changed) setPending({ kind: 'save' }); }}>
        <section className="settings-section" aria-labelledby="ai-skill-title">
          <h3 id="ai-skill-title">Name</h3>
          {isNew && (
            <div className="field">
              <label htmlFor={ids.name}>Identifier</label>
              <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={name && !nameOk ? true : undefined} aria-describedby={`${ids.name}-hint`} />
              <span id={`${ids.name}-hint`} className="ai-set-muted">Lower-case letters, numbers and hyphens, e.g. house-style. It can’t change later.</span>
            </div>
          )}
          <label htmlFor={ids.label} className="visually-hidden">Skill name</label>
          <input id={ids.label} className="ai-set-input" value={label} maxLength={AI_SKILL_LIMITS.maxLabelChars} disabled={standard} onChange={(e) => setLabel(e.target.value)} aria-describedby={`${ids.label}-hint`} />
          <p id={`${ids.label}-hint`} className="ai-set-muted ai-set-hint">
            {standard ? 'Standard skill: only on/off can change.' : isNew ? 'Shown in the skill list and in the assistant’s steps.' : 'A custom skill written by your organisation.'}
          </p>
        </section>

        <section className="settings-section">
          <div className="ai-set-headrow">
            <div>
              <h3 id={`${ids.content}-title`}>Instructions</h3>
              <p>What this skill teaches the assistant (Markdown).</p>
            </div>
            {!standard && <button type="button" className="btn btn-outline btn-sm" aria-pressed={preview} onClick={() => setPreview((v) => !v)}>{preview ? 'Edit' : 'Preview'}</button>}
          </div>
          {standard && skill.content === null ? (
            <NotAvailableYet>A standard skill’s text is part of Crewflow’s reviewed code, and this server doesn’t send it.</NotAvailableYet>
          ) : standard ? (
            // R-U3 (Agent 10): the server sends a built-in's text read-only on GET /ai/settings/skills. Shown, never editable.
            <>
              <textarea id={ids.content} aria-labelledby={`${ids.content}-title`} className="ai-set-textarea ai-set-textarea--tall" value={skill.content ?? ''} disabled readOnly aria-describedby={`${ids.content}-count`} />
              <span id={`${ids.content}-count`} className="ai-set-count">{countText((skill.content ?? '').length, AI_SKILL_LIMITS.maxContentChars)}</span>
            </>
          ) : (
            <>
              {preview ? (
                <div className="ai-skill-preview ai-markdown"><SafeMarkdown text={content} /></div>
              ) : (
                <textarea id={ids.content} aria-labelledby={`${ids.content}-title`} className="ai-set-textarea ai-set-textarea--tall" rows={12} value={content} aria-invalid={tooLong || undefined} aria-describedby={`${ids.content}-count`} onChange={(e) => setContent(e.target.value)} />
              )}
              <span id={`${ids.content}-count`} className={`ai-set-count${tooLong ? ' ai-set-field-error' : ''}`}>{countText(content.length, AI_SKILL_LIMITS.maxContentChars)}</span>
            </>
          )}
        </section>

        <section className="settings-section">
          <h3 id={`${ids.description}-title`}>Description</h3>
          <p>When the assistant should load it (shown in the skill catalogue).</p>
          <textarea id={ids.description} aria-labelledby={`${ids.description}-title`} className="ai-set-textarea" rows={2} value={description} disabled={standard} aria-invalid={descTooLong || undefined} aria-describedby={`${ids.description}-count`} onChange={(e) => setDescription(e.target.value)} />
          <span id={`${ids.description}-count`} className={`ai-set-count${descTooLong ? ' ai-set-field-error' : ''}`}>{countText(description.length, AI_SKILL_LIMITS.maxDescriptionChars)}</span>
        </section>

        {!standard && (
          <div className="ai-set-actions ai-set-actions--end">
            <button type="submit" className="btn btn-dark btn-sm" disabled={!valid || !changed}>{isNew ? 'Create skill' : 'Save'}</button>
          </div>
        )}
      </form>

      {!isNew && (
        <section className="settings-section" aria-labelledby="ai-skill-danger">
          <h3 id="ai-skill-danger">Danger zone</h3>
          <p>{standard ? 'Turn this skill off for your organisation.' : 'Turn this skill off, or delete it for good.'}</p>
          <div className="ai-set-danger">
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setPending({ kind: 'toggle', active: !skill.isActive })}>
              {skill.isActive ? <IconCircleOff size={14} aria-hidden="true" /> : <IconCircleCheck size={14} aria-hidden="true" />}
              {skill.isActive ? 'Turn off' : 'Turn on'}
            </button>
            {standard ? (
              <>
                <button type="button" className="btn btn-outline btn-sm ai-set-danger-btn" disabled aria-describedby="ai-skill-nodelete"><IconTrash size={14} aria-hidden="true" />Delete</button>
                <span id="ai-skill-nodelete" className="ai-set-muted">Standard skills can’t be deleted.</span>
              </>
            ) : (
              <button type="button" className="btn btn-outline btn-sm ai-set-danger-btn" onClick={() => setPending({ kind: 'delete' })}><IconTrash size={14} aria-hidden="true" />Delete</button>
            )}
          </div>
        </section>
      )}

      {pending?.kind === 'save' && (
        <AiReasonDialog
          title={isNew ? 'Create this skill?' : 'Save this skill?'}
          body="The assistant can load it in your organisation’s conversations. You may be asked to confirm it’s you."
          run={(reason) => (isNew ? aiSettingsApi.createSkill({ name, label: label.trim(), description: description.trim(), content, reason }) : aiSettingsApi.updateSkill(skill.id!, { label: label.trim(), description: description.trim(), content, reason }))}
          successMessage={isNew ? 'Skill created' : 'Skill saved'}
          inlineErrors={SKILL_REFUSAL_TEXT}
          onDone={done}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === 'toggle' && skill && (
        <AiReasonDialog
          title={pending.active ? `Turn on ${skill.label}?` : `Turn off ${skill.label}?`}
          body={pending.active ? 'The assistant can load it again.' : 'The assistant stops loading it. You can turn it back on later.'}
          confirmLabel={pending.active ? 'Turn on' : 'Turn off'}
          run={(reason) => aiSettingsApi.setSkillActive(skill, pending.active, reason)}
          successMessage={pending.active ? 'Skill turned on' : 'Skill turned off'}
          inlineErrors={SKILL_REFUSAL_TEXT}
          onDone={done}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === 'delete' && skill && !skill.isSystem && (
        <AiReasonDialog
          title={`Delete ${skill.label}?`}
          body="It is deleted for good and can’t be loaded any more. This cannot be undone."
          confirmLabel="Delete"
          destructive
          run={(reason) => aiSettingsApi.deleteSkill(skill.id!, reason)}
          successMessage="Skill deleted"
          inlineErrors={SKILL_REFUSAL_TEXT}
          onDone={() => {
            done();
            onBack();
          }}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}
