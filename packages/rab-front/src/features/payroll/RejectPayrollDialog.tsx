import { useEffect, useState } from 'react';
import ModalFrame from '../../shared/components/ModalFrame';

export const REJECT_REASON_MIN = 3;
export const REJECT_REASON_MAX = 500;

/** Asks for the (required) rejection reason. The server re-validates it (3–500 characters) and records it in the audit log. */
export default function RejectPayrollDialog({ open, staffName, loading, error, onConfirm, onCancel }: {
  open: boolean;
  staffName: string | null;
  loading: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  const trimmed = reason.trim();
  const valid = trimmed.length >= REJECT_REASON_MIN && trimmed.length <= REJECT_REASON_MAX;

  return (
    <ModalFrame
      open={open}
      onBackdropMouseDown={(e) => { if (e.target === e.currentTarget && !loading) onCancel(); }}
      dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'reject-payroll-title' }}
    >
      <h3 id="reject-payroll-title">Reject payroll</h3>
      {staffName && <p style={{ fontSize: 13, color: 'var(--font-secondary)' }}>{staffName} will not see this shift in their history. The reason is recorded in the audit log.</p>}
      <div className="field">
        <label htmlFor="reject-payroll-reason">Reason</label>
        <textarea id="reject-payroll-reason" rows={3} maxLength={REJECT_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Hours disputed by the venue" />
      </div>
      {error && <p role="alert" className="feedback-error" style={{ fontSize: 13 }}>{error}</p>}
      <div className="modal-actions">
        <button className="btn btn-outline" onClick={onCancel} disabled={loading}>Cancel</button>
        <button className="btn btn-danger" onClick={() => onConfirm(trimmed)} disabled={loading || !valid}>
          {loading ? 'Please wait…' : 'Reject payroll'}
        </button>
      </div>
    </ModalFrame>
  );
}
