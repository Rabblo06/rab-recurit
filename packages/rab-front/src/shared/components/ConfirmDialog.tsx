import { useEffect } from 'react';
import ModalFrame from './ModalFrame';

/**
 * Small centred confirmation modal — distinct from `Drawer` (a side panel
 * for forms/details). Built on the existing `.modal-overlay`/`.modal`
 * classes (already used elsewhere), not a new visual system.
 */
export default function ConfirmDialog({
  open,
  dialogClassName,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  loading = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  dialogClassName?: string;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, loading, onCancel]);

  return (
    <ModalFrame
      open={open}
      dialogClassName={dialogClassName}
      onBackdropMouseDown={(e) => { if (e.target === e.currentTarget && !loading) onCancel(); }}
      dialogProps={{ role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-dialog-title' }}
    >
        <h3 id="confirm-dialog-title">{title}</h3>
        {description && <p style={{ fontSize: 13, color: 'var(--font-secondary)' }}>{description}</p>}
        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </button>
          <button
            className={`btn btn-dark${destructive ? '' : ' flow-button'}`}
            aria-busy={loading || undefined}
            style={destructive ? { background: 'var(--color-red)', borderColor: 'var(--color-red)', color: '#fff' } : undefined}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? 'Please wait…' : confirmLabel}
          </button>
        </div>
    </ModalFrame>
  );
}
