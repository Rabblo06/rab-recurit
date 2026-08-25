import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconX } from '@tabler/icons-react';
import RightSidePanel from './RightSidePanel';

const WIDTH: Record<'default' | 'wide', number> = { default: 408, wide: 640 };
const FOCUSABLE = 'input, select, textarea, button, [tabindex]:not([tabindex="-1"])';

/**
 * The one reusable right-side drawer for forms, requests, details and
 * approval workflows — wraps `RightSidePanel` (unchanged, still used
 * directly by `CommandPalette`/`GlobalSearch` for the Ctrl+K experience)
 * and adds the form-chrome + safety behaviours no single centred-modal form
 * had on its own: sticky header/footer with only the middle scrolling,
 * loading state, an unsaved-changes guard on Escape/backdrop-click, and
 * focus management (moves in on open, returns to the trigger on close).
 *
 * Usage:
 *   <Drawer open={open} onClose={close} title="New shift" footer={<>...</>}>
 *     <NewShiftForm />
 *   </Drawer>
 */
export default function Drawer({
  open,
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  loading = false,
  dirty = false,
  size = 'default',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  loading?: boolean;
  dirty?: boolean;
  size?: 'default' | 'wide';
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // Focus management: remember whatever had focus before opening (the
  // button that triggered this drawer), move focus into the drawer, and
  // give it back on close.
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      const toFocus = bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      toFocus?.focus();
    } else {
      triggerRef.current?.focus();
      triggerRef.current = null;
      setConfirmingDiscard(false);
    }
  }, [open]);

  const requestClose = (): boolean => {
    if (dirty && !confirmingDiscard) {
      setConfirmingDiscard(true);
      return false;
    }
    return true;
  };

  const close = () => {
    setConfirmingDiscard(false);
    onClose();
  };

  return (
    <RightSidePanel open={open} onClose={close} width={WIDTH[size]} requestClose={requestClose}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="drawer-header">
          <button className="btn-icon" onClick={() => { if (requestClose()) close(); }} title="Close" aria-label="Close">
            <IconX size={15} />
          </button>
          <div className="drawer-header-text">
            <span className="drawer-title">{title}</span>
            {description && <span className="drawer-description">{description}</span>}
          </div>
          {icon}
        </div>

        {confirmingDiscard ? (
          <div className="drawer-discard-confirm">
            <p>You have unsaved changes. Discard them?</p>
            <div className="modal-actions" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
              <button className="btn btn-outline" onClick={() => setConfirmingDiscard(false)}>Keep editing</button>
              <button
                className="btn btn-dark"
                style={{ background: 'var(--color-red)', borderColor: 'var(--color-red)' }}
                onClick={close}
              >
                Discard changes
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="drawer-body" ref={bodyRef}>
              {children}
            </div>
            {footer && (
              <div className="drawer-footer" aria-busy={loading}>
                {footer}
              </div>
            )}
          </>
        )}
      </div>
    </RightSidePanel>
  );
}
