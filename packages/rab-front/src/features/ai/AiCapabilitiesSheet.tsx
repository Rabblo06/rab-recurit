import { useEffect, useId, useRef } from 'react';
import { IconBook, IconPencil, IconTool, IconX } from '@tabler/icons-react';
import { AI_WRITE_TOOL_NAMES } from '@rab/shared';

import type { AiCapabilities } from './aiCardsApi';

import ModalFrame from '../../shared/components/ModalFrame';

/**
 * H5 "See what I can do" (CD-8): the caller's PERMITTED read tools and active skills, exactly as `GET /ai/capabilities`
 * returns them (server text, rendered as plain text). It lists; it never runs anything.
 */
const WRITE = new Set<string>(AI_WRITE_TOOL_NAMES);

export default function AiCapabilitiesSheet({ open, data, onClose }: { open: boolean; data: AiCapabilities | undefined; onClose: () => void }) {
  // `tools` are read tools; `writeTools` (S4) are the changes this person may have PROPOSED (Phase 5b), listed apart as
  // changes they approve on a card. A write name in `tools` is never presented as a read.
  const reads = data?.tools.filter((t) => !WRITE.has(t.name)) ?? [];
  const writes = data?.writeTools ?? [];
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <ModalFrame open={open} onBackdropMouseDown={(e) => e.target === e.currentTarget && onClose()} dialogClassName="ai-capabilities" dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }}>
      <div className="ai-capabilities-head">
        <h3 id={titleId}>What I can do</h3>
        <button ref={closeRef} type="button" className="btn-icon" aria-label="Close" onClick={onClose}><IconX size={16} /></button>
      </div>
      <p className="ai-muted">I can read the information below, within your own permissions. I can’t change anything: changes are only ever suggested for a person to approve.</p>
      <h4><IconTool size={14} aria-hidden="true" /> Information I can read</h4>
      {reads.length ? (
        <ul className="ai-capabilities-list">{reads.map((t) => <li key={t.name}><strong>{t.label}</strong><span>{t.summary}</span></li>)}</ul>
      ) : (
        <p className="ai-muted">None with your current permissions.</p>
      )}
      {writes.length > 0 && (
        <>
          <h4><IconPencil size={14} aria-hidden="true" /> Changes I can suggest</h4>
          <p className="ai-muted">Each one waits for you on a card. Nothing changes until you approve it.</p>
          <ul className="ai-capabilities-list">{writes.map((t) => <li key={t.name}><strong>{t.label}</strong><span>{t.summary}</span></li>)}</ul>
        </>
      )}
      <h4><IconBook size={14} aria-hidden="true" /> Skills</h4>
      {data?.skills.length ? (
        <ul className="ai-capabilities-list">{data.skills.map((s) => <li key={s.name}><strong>{s.label}</strong><span>{s.description}</span></li>)}</ul>
      ) : (
        <p className="ai-muted">No skills are switched on.</p>
      )}
    </ModalFrame>
  );
}
