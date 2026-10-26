import { useId, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { IconArrowLeft, IconBook, IconBrain, IconChevronRight, IconPlus, IconSearch, IconTool } from '@tabler/icons-react';
import { AI_SKILL_LIMITS, AI_SKILL_NAME_PATTERN, type AiSkillView } from '@rab/shared';

import { aiKeys } from '../../ai/aiApi';
import { useAiChat } from '../../ai/AiChatProvider';
import SafeMarkdown from '../../ai/SafeMarkdown';
import AiReasonDialog from './AiReasonDialog';
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

const SKILL_REFUSAL_TEXT: Record<string, string> = {
  AI_SKILL_CONTENT_REFUSED: 'This skill can’t be saved: it contains something the assistant may not be given (markup, hidden characters, personal data or something that looks like a secret).',
  AI_SKILL_LIMIT_REACHED: `Your organisation already has ${AI_SKILL_LIMITS.maxCustomPerOrganisation} custom skills. Delete one first.`,
  AI_SKILL_NOT_AVAILABLE: 'That skill is not available any more. Refresh the page.',
  AI_SKILL_NAME_TAKEN: 'A skill with that name already exists (built-in names are taken too). Choose another name.',
};

/**
 * Settings → AI → Skills (Phase 4 API; TWENTY_UI_INVENTORY D1–D19; rendered only when `features.skills`). Skills are
 * instructions only: they give the assistant no permission and no tool. Built-ins can be switched on or off; custom
 * skills can be created, edited and deleted. Every write needs a reason and a recent step-up (P4-D4). Previews use
 * `SafeMarkdown` (no HTML, no images, safe links only). No code-interpreter, file or web skills exist (rule 13.3).
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
      <AiStepsIllustration lines={['Thought for 2 s', 'Loaded skill: Coverage report', 'Checked coverage gaps', 'Thought for 1 s']} />
      <section className="settings-section" aria-labelledby="ai-skills-title">
        <h3 id="ai-skills-title">Skills</h3>
        <p>Instructions the assistant can load. They give no permissions or tools.</p>
        {atLimit && <p className="ai-set-notice" role="note">{SKILL_REFUSAL_TEXT.AI_SKILL_LIMIT_REACHED}</p>}
        <div className="ai-set-search">
          <IconSearch size={14} aria-hidden="true" />
          <label htmlFor={searchId} className="visually-hidden">Search skills</label>
          <input id={searchId} type="search" placeholder="Search skills…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="table-container">
          <table className="table ai-set-table">
            <caption className="visually-hidden">Skills</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">On</th><th scope="col"><span className="visually-hidden">Open</span></th></tr></thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.name} data-skill={s.name}>
                  <td><span className="ai-set-skill"><IconBook size={14} aria-hidden="true" /><strong>{s.label}</strong></span></td>
                  <td><span className="badge">{s.isSystem ? 'Built-in' : 'Custom'}</span></td>
                  <td>{s.isActive ? 'On' : 'Off'}</td>
                  <td><button type="button" className="btn-icon" aria-label={`Open ${s.label}`} onClick={() => go(s.name)}><IconChevronRight size={15} /></button></td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={4} className="ai-set-muted">No skill matches your search.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="ai-set-actions ai-set-actions--end">
          <button type="button" className="btn btn-outline btn-sm" disabled={atLimit} onClick={() => go('new')}><IconPlus size={14} aria-hidden="true" />New skill</button>
        </div>
      </section>
    </>
  );
}

type Pending = { kind: 'save' } | { kind: 'toggle'; active: boolean } | { kind: 'delete' };

/** D13–D18: one skill. Built-ins: on/off only. Custom: label, description, content (≤ 20,000) with a safe preview. */
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
  const editable = isNew || !skill.isSystem;
  const tooLong = content.length > AI_SKILL_LIMITS.maxContentChars;
  const nameOk = !isNew || AI_SKILL_NAME_PATTERN.test(name);
  const valid = nameOk && label.trim().length > 0 && label.length <= AI_SKILL_LIMITS.maxLabelChars && description.trim().length > 0 && description.length <= AI_SKILL_LIMITS.maxDescriptionChars && content.trim().length > 0 && !tooLong;
  const done = () => {
    void qc.invalidateQueries({ queryKey: aiKeys.settingsArea(scope, 'skills') });
    void qc.invalidateQueries({ queryKey: aiKeys.settingsArea(scope, 'prompt') });
    setPending(null);
    if (isNew) onBack();
  };

  return (
    <>
      <button type="button" className="ai-set-back" onClick={onBack}><IconArrowLeft size={14} aria-hidden="true" />All skills</button>
      <section className="settings-section" aria-labelledby="ai-skill-title">
        <h3 id="ai-skill-title">{isNew ? 'New skill' : skill.label}</h3>
        <p>{isNew ? 'Write instructions the assistant can load when they help. They give no permissions or tools.' : skill.isSystem ? 'A built-in skill. Its text is part of Crewflow and can’t be edited.' : 'A custom skill written by your organisation.'}</p>
        {editable ? (
          <form className="ai-skill-form" onSubmit={(e) => { e.preventDefault(); if (valid) setPending({ kind: 'save' }); }}>
            {isNew && (
              <div className="field">
                <label htmlFor={ids.name}>Name</label>
                <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={name && !nameOk ? true : undefined} aria-describedby={`${ids.name}-hint`} />
                <span id={`${ids.name}-hint`} className="ai-set-muted">Lower-case letters, numbers and hyphens, e.g. house-style.</span>
              </div>
            )}
            <div className="field">
              <label htmlFor={ids.label}>Label</label>
              <input id={ids.label} value={label} maxLength={AI_SKILL_LIMITS.maxLabelChars} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={ids.description}>Description</label>
              <textarea id={ids.description} rows={2} value={description} maxLength={AI_SKILL_LIMITS.maxDescriptionChars} onChange={(e) => setDescription(e.target.value)} />
              <span className="ai-set-muted">The purpose of this skill. Shown to the assistant in its skill list.</span>
            </div>
            <div className="field">
              <div className="ai-set-headrow"><label htmlFor={ids.content}>Instructions</label><button type="button" className="btn btn-outline btn-sm" aria-pressed={preview} onClick={() => setPreview((v) => !v)}>{preview ? 'Edit' : 'Preview'}</button></div>
              {preview ? <div className="ai-skill-preview ai-markdown"><SafeMarkdown text={content} /></div> : <textarea id={ids.content} rows={12} value={content} aria-invalid={tooLong || undefined} aria-describedby={`${ids.content}-count`} onChange={(e) => setContent(e.target.value)} />}
              <span id={`${ids.content}-count`} className={tooLong ? 'ai-set-field-error' : 'ai-set-muted'}>{`${content.length.toLocaleString('en-GB')} / ${AI_SKILL_LIMITS.maxContentChars.toLocaleString('en-GB')}`}</span>
            </div>
            <div className="ai-set-actions"><button type="submit" className="btn btn-dark btn-sm" disabled={!valid}>Save</button></div>
          </form>
        ) : (
          <p className="ai-set-readonly">{skill.description}</p>
        )}
      </section>
      {!isNew && (
        <section className="settings-section" aria-labelledby="ai-skill-danger">
          <h3 id="ai-skill-danger">Turn off or delete</h3>
          <p>{skill.isSystem ? 'A built-in skill can be turned off for your organisation.' : 'Turn this skill off, or delete it for good.'}</p>
          <div className="ai-set-actions">
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setPending({ kind: 'toggle', active: !skill.isActive })}>{skill.isActive ? 'Turn off' : 'Turn on'}</button>
            {!skill.isSystem && <button type="button" className="btn btn-danger btn-sm" onClick={() => setPending({ kind: 'delete' })}>Delete</button>}
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
      {pending?.kind === 'delete' && skill && (
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
