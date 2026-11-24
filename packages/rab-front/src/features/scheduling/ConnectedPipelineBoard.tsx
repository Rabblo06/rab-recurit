import { useEffect, useRef, type ReactNode } from 'react';
import { PIPELINE_TABS, type PipelineTab } from './VenueOfferPipelineStages';

/** One continuous board: URL tabs and horizontal scrolling stay in sync. */
export default function ConnectedPipelineBoard({ tab, scrollRequest, onTabChange, children }: {
  tab: PipelineTab;
  scrollRequest: number;
  onTabChange: (tab: PipelineTab) => void;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const scrollSelected = useRef<PipelineTab | null>(null);
  const navigatingUntil = useRef(0);
  const initialized = useRef(false);
  useEffect(() => {
    const board = viewport.current;
    if (!board) return;
    const wheel = (event: WheelEvent) => {
      // A mouse wheel advances the board; tall staff lists retain their own vertical scrolling.
      if (event.ctrlKey || event.deltaX || !event.deltaY || !window.matchMedia?.('(pointer: fine)').matches) return;
      const body = (event.target as Element).closest('.pipeline-column-body');
      if (body && body.scrollHeight > body.clientHeight) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? board.clientWidth : 1);
      const next = Math.max(0, Math.min(board.scrollWidth - board.clientWidth, board.scrollLeft + delta));
      if (next === board.scrollLeft) return;
      event.preventDefault();
      navigatingUntil.current = 0;
      board.scrollLeft = next;
    };
    board.addEventListener('wheel', wheel, { passive: false });
    return () => board.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    if (scrollSelected.current === tab) { scrollSelected.current = null; return; }
    const board = viewport.current;
    const section = board?.querySelector<HTMLElement>(`[data-pipeline-section="${tab}"]`);
    if (!board || !section) return;
    const left = section.offsetLeft;
    const smooth = initialized.current && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    initialized.current = true;
    navigatingUntil.current = smooth ? Date.now() + 700 : 0;
    board.scrollTo?.({ left, behavior: smooth ? 'smooth' : 'auto' });
  }, [tab, scrollRequest]);

  return <div ref={viewport} className="pipeline-board" aria-label="Staffing, attendance and closed stages" tabIndex={0}
    onWheel={() => { navigatingUntil.current = 0; }}
    onTouchStart={() => { navigatingUntil.current = 0; }}
    onPointerDown={() => { navigatingUntil.current = 0; }}
    onScroll={() => {
      const board = viewport.current;
      if (!board || Date.now() < navigatingUntil.current || !board.clientWidth) return;
      const marker = board.scrollLeft + Math.min(120, board.clientWidth / 3);
      let active: PipelineTab = 'staffing';
      for (const section of PIPELINE_TABS) {
        const element = board.querySelector<HTMLElement>(`[data-pipeline-section="${section.key}"]`);
        if (element && element.offsetLeft <= marker) active = section.key;
      }
      if (board.scrollWidth > board.clientWidth && board.scrollLeft >= board.scrollWidth - board.clientWidth - 2) active = 'closed';
      if (active !== tab && active !== scrollSelected.current) {
        scrollSelected.current = active;
        onTabChange(active);
      }
    }}>{children}</div>;
}
