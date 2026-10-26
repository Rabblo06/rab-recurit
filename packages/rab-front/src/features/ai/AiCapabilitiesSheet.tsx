import { useEffect, useId, useRef } from 'react';
import { IconBook, IconTool, IconX } from '@tabler/icons-react';
import type { AiCapabilitiesView } from '@rab/shared';

import ModalFrame from '../../shared/components/ModalFrame';

/**
 * H5 "See what I can do" (CD-8): the caller's PERMITTED read tools and active skills, exactly as `GET /ai/capabilities`
 * returns them (server text, rendered as plain text). It lists; it never runs anything.
 */
export default function AiCapabilitiesSheet({ open, data, onClose }: { open: boolean; data: AiCapabilitiesView | undefined; onClose: () => void }) {
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
      {data?.tools.length ? (
        <ul className="ai-capabilities-list">{data.tools.map((t) => <li key={t.name}><strong>{t.label}</strong><span>{t.summary}</span></li>)}</ul>
      ) : (
        <p className="ai-muted">None with your current permissions.</p>
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
