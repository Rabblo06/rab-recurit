import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[inert]') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Keeps keyboard focus inside a modal while it is open (`shared/components/ModalFrame` has no trap):
 *  - on open, focuses `[data-autofocus]`, else the first text input, else the first control;
 *  - Tab / Shift+Tab cycle inside the container (focus that escapes, e.g. a click on the backdrop, is pulled back);
 *  - Escape calls `onEscape` when given (omit it for a step that must not be dismissed, e.g. unsaved recovery codes);
 *  - on close, focus returns to the element that opened it, or to `fallback()` when that element is gone (the button
 *    that opened "Turn on 2FA" no longer exists once 2FA is on).
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  {
    active,
    onEscape,
    fallback,
    opener: openerHint,
  }: {
    active: boolean;
    onEscape?: () => void;
    fallback?: () => HTMLElement | null;
    /** The element focused when the dialog was first RENDERED (read before React's `autoFocus` moves focus inside). */
    opener?: HTMLElement | null;
  },
): void {
  const openerHintRef = useRef(openerHint);
  openerHintRef.current = openerHint;
  const onEscapeRef = useRef(onEscape);
  const fallbackRef = useRef(fallback);
  onEscapeRef.current = onEscape;
  fallbackRef.current = fallback;

  useEffect(() => {
    if (!active) return;
    const container0 = containerRef.current;
    const active0 =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const opener =
      openerHintRef.current ??
      (active0 && !(container0 && container0.contains(active0))
        ? active0
        : null);
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container || container.contains(document.activeElement)) return;
      const preferred =
        container.querySelector<HTMLElement>('[data-autofocus]') ??
        focusables(container).find(
          (el) => el instanceof HTMLInputElement && el.type !== 'checkbox',
        ) ??
        focusables(container)[0];
      preferred?.focus();
    });

    function onKeyDown(e: KeyboardEvent): void {
      const container = containerRef.current;
      if (!container) return;
      if (e.key === 'Escape') {
        if (onEscapeRef.current) {
          e.preventDefault();
          e.stopPropagation();
          onEscapeRef.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(container);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement as HTMLElement | null;
      if (!current || !container.contains(current)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && current === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    }

    function onFocusIn(e: FocusEvent): void {
      const container = containerRef.current;
      if (
        container &&
        e.target instanceof Node &&
        !container.contains(e.target)
      ) {
        (focusables(container)[0] ?? container).focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      const target =
        opener && opener.isConnected
          ? opener
          : (fallbackRef.current?.() ?? null);
      // After React has committed the close (the opener may be re-rendered in the same commit).
      setTimeout(() => {
        const next =
          target && target.isConnected
            ? target
            : (fallbackRef.current?.() ?? null);
        next?.focus();
      }, 0);
    };
  }, [active, containerRef]);
}
