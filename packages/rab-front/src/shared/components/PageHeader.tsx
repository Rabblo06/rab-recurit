import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { PageSlot, usePageSlots } from '../page-slots';

/**
 * Page title, tabs and primary action. Inside the app shell they render in the TOP BAR (Crewflow reference: the page's
 * tabs sit on the left of the top bar, the primary action on the right) — the title becomes the active tab when a
 * page has no tabs of its own. Outside the shell (tests) or with `inline` (overlays such as Select Staff) the classic
 * in-page header renders instead.
 *
 * `tabs` is the page's own tab markup (`.tab-link` buttons / NavLinks with an `.active` class); behaviour stays in the
 * page, this only positions it and draws one shared sliding underline.
 */
export default function PageHeader({ title, subtitle, action, tabs, inline = false }: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  tabs?: ReactNode;
  inline?: boolean;
}) {
  const slots = usePageSlots();
  if (!slots || inline) {
    return (
      <>
        <div className="page-header">
          <div>
            <h1 className="page-header-title">{title}</h1>
            {subtitle && <p className="page-header-subtitle">{subtitle}</p>}
          </div>
          {action && <div className="page-header-action">{action}</div>}
        </div>
        {tabs && <div className="list-tabs-row">{tabs}</div>}
      </>
    );
  }
  return (
    <>
      <PageSlot name="tabs">
        <TabStrip>
          {tabs
            ? <><h1 className="page-header-title visually-hidden">{title}</h1>{tabs}</>
            : <h1 className="page-header-title tab-link active">{title}</h1>}
          {subtitle && <span className="topbar-title-meta">{subtitle}</span>}
        </TabStrip>
      </PageSlot>
      {action && <PageSlot name="actions"><div className="page-header-action">{action}</div></PageSlot>}
    </>
  );
}

/**
 * One underline that slides to whichever `.tab-link.active` is inside (works with any page's tab markup, buttons or
 * NavLinks). Transform/width only, 250ms (`--motion-indicator`); reduced motion snaps via motion.css.
 */
export function TabStrip({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    let placed = false;
    const place = () => {
      const active = host.querySelector<HTMLElement>('.tab-link.active');
      const el = bar.current;
      if (!el) return;
      if (!active) { el.style.opacity = '0'; return; }
      // The first placement must not animate in from x=0.
      if (!placed) el.style.transition = 'none';
      el.style.opacity = '1';
      el.style.width = `${active.offsetWidth}px`;
      el.style.transform = `translateX(${active.offsetLeft}px)`;
      if (!placed) { void el.offsetWidth; el.style.transition = ''; placed = true; }
    };
    place();
    const mo = new MutationObserver(place);
    mo.observe(host, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true, characterData: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    ro?.observe(host);
    return () => { mo.disconnect(); ro?.disconnect(); };
  }, []);
  return (
    <div ref={ref} className={`list-tabs-row tab-strip ${className}`.trim()}>
      {children}
      <span ref={bar} className="tab-strip-indicator" aria-hidden="true" />
    </div>
  );
}
