import { useEffect, useRef } from 'react';
import { IconChevronRight } from '@tabler/icons-react';

/**
 * The breadcrumb of a Settings → AI sub-page ("Skills › Shift filling", "Overview › System prompt"; settings mockup). The
 * parent is a real button (keyboard + visible focus); the current page is plain text with `aria-current="page"`. Focus
 * moves to the page heading on open, so a keyboard or screen-reader user lands on the new page, not on the old row.
 */
export default function AiSetCrumb({ parent, current, onParent, headingId }: { parent: string; current: string; onParent: () => void; headingId?: string }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !headingId) return;
    done.current = true;
    const h = document.getElementById(headingId);
    if (h) {
      h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: true });
    }
  }, [headingId]);
  return (
    <nav className="ai-set-crumb" aria-label="Breadcrumb">
      <button type="button" className="ai-set-crumb-link" onClick={onParent}>{parent}</button>
      <IconChevronRight size={12} aria-hidden="true" />
      <span aria-current="page">{current}</span>
    </nav>
  );
}
