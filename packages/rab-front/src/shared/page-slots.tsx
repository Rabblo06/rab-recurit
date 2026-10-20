import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Top-bar areas the app shell lends to the routed page (title, actions, breadcrumb suffix). The shell publishes the
 * CURRENT element of each slot through callback refs, so a page always portals into the live node — it never caches a
 * DOM node found once at mount (which went stale when the top bar re-rendered and left the page's header rendered
 * inline, pushed down into the content).
 */
export interface PageSlots {
  /** Left of the top bar: the page title rendered as the active tab, or the page's own tabs (`PageHeader`). */
  tabs: HTMLElement | null;
  /** Centre of the top bar (the Venue Offers pipeline heading). */
  title: HTMLElement | null;
  actions: HTMLElement | null;
  breadcrumbSuffix: HTMLElement | null;
}

const PageSlotsContext = createContext<PageSlots | null>(null);

export const PageSlotsProvider = PageSlotsContext.Provider;

/** The shell's slots, or null when the page renders outside the shell (tests, overlays). */
export function usePageSlots(): PageSlots | null {
  return useContext(PageSlotsContext);
}

/**
 * Renders `children` into a shell slot. With no shell at all (a page rendered on its own, e.g. in tests) it renders
 * `fallback` inline; inside the shell it renders nothing for the one commit in which a slot is (re)attaching, never a
 * displaced inline copy.
 */
export function PageSlot({
  name,
  children,
  fallback = null,
}: {
  name: keyof PageSlots;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const slots = useContext(PageSlotsContext);
  if (!slots) return <>{fallback}</>;
  const host = slots[name];
  return host ? createPortal(children, host) : null;
}
