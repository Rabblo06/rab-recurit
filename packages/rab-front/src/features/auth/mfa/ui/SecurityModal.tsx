import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import ModalFrame from '../../../../shared/components/ModalFrame';
import { AcsIcon, type AcsIconName } from './icons';
import { Emblem } from './primitives';
import { useFocusTrap } from './useFocusTrap';
import './account-security.css';

/**
 * The design's `webModal()` frame: 480px dialog, emblem + close, title + helper, body, right-aligned footer; a bottom
 * sheet at ≤ 640px. Built on `ModalFrame` (its motion is kept) and portalled to <body> so no transformed ancestor can
 * break `position: fixed`. Accessibility: `role="dialog"`, `aria-modal`, `aria-labelledby`/`aria-describedby`, a focus
 * trap, Escape (only when `onClose` is given — a step showing unsaved recovery codes passes none), and focus returns to
 * the opener (or `returnFocus()` when the opener no longer exists). The backdrop never closes it (as designed): a
 * half-typed password or unsaved codes are never lost to a stray click.
 */
export default function SecurityModal({
  open,
  titleId,
  descriptionId,
  icon = 'shield',
  title,
  description,
  onClose,
  returnFocus,
  footer,
  onSubmit,
  children,
}: {
  /** When given, the body and footer are one <form> (Enter submits; the footer's submit button is `type="submit"`). */
  onSubmit?: () => void;
  open: boolean;
  titleId: string;
  descriptionId: string;
  icon?: AcsIconName;
  title: ReactNode;
  description: ReactNode;
  /** Close button + Escape. Omit to make the step non-dismissable. */
  onClose?: () => void;
  returnFocus?: () => HTMLElement | null;
  footer: ReactNode;
  children: ReactNode;
}) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  // Read during the first render, i.e. before a field's `autoFocus` moves focus into the dialog.
  const [opener] = useState(() =>
    typeof document !== 'undefined' &&
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  useFocusTrap(innerRef, {
    active: open,
    onEscape: onClose,
    fallback: returnFocus,
    opener,
  });
  if (typeof document === 'undefined') return null;
  return createPortal(
    <ModalFrame
      open={open}
      overlayClassName="acs acs-modal-layer"
      dialogClassName="acs-modal"
      dialogProps={{
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        'aria-describedby': descriptionId,
      }}
    >
      <div ref={innerRef} className="acs-modal-inner">
        <div className="acs-modal-top">
          <Emblem icon={icon} />
          {onClose && (
            <button
              type="button"
              className="acs-icon-btn"
              aria-label="Close"
              onClick={onClose}
            >
              <AcsIcon name="close" />
            </button>
          )}
        </div>
        <div>
          <h2 id={titleId} className="acs-modal-title">
            {title}
          </h2>
          <p id={descriptionId} className="acs-helper">
            {description}
          </p>
        </div>
        {onSubmit ? (
          <form
            className="acs-modal-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            <div className="acs-modal-body">{children}</div>
            <div className="acs-modal-footer">{footer}</div>
          </form>
        ) : (
          <>
            <div className="acs-modal-body">{children}</div>
            <div className="acs-modal-footer">{footer}</div>
          </>
        )}
      </div>
    </ModalFrame>,
    document.body,
  );
}
