import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';

type Role = 'staff' | 'manager';

interface BulkEmailTarget {
  role: Role;
  userIds: string[];
  names: string[];
}

interface BulkEmailResult {
  queued: number;
  skipped: number;
}

/**
 * Global bulk-email compose panel for the Users page's selection toolbar.
 * Opened via:
 *   document.dispatchEvent(new CustomEvent('open-bulk-email', { detail: { role, userIds, names } }))
 *
 * Sends through the exact same durable outbox every other email in this
 * app uses (`StaffService.bulkEmail`/`ManagerService.bulkEmail` →
 * `EmailOutboxService.enqueue` → dispatcher → `rab-worker` → provider) —
 * never a synchronous send from this request. Recipients are re-derived
 * server-side from the caller's own visible roster (never trusted as
 * authorization from this panel's `userIds`), so a request can come back
 * with fewer `queued` than `userIds.length` if some were outside the
 * caller's scope — reported honestly, not silently swallowed.
 */
export default function BulkEmailPanel() {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<BulkEmailTarget | null>(null);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<BulkEmailResult | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as BulkEmailTarget | undefined;
      if (!detail?.userIds?.length) return;
      setTarget(detail);
      setSubject('');
      setMessage('');
      setError('');
      setResult(null);
      setOpen(true);
    };
    document.addEventListener('open-bulk-email', handler);
    return () => document.removeEventListener('open-bulk-email', handler);
  }, []);

  // Same panel-exclusivity rule as UserDetailPanel/CreateUserModal.
  useEffect(() => {
    const closeOnOtherPanel = () => setOpen(false);
    document.addEventListener('open-user-detail', closeOnOtherPanel);
    document.addEventListener('open-create-user', closeOnOtherPanel);
    return () => {
      document.removeEventListener('open-user-detail', closeOnOtherPanel);
      document.removeEventListener('open-create-user', closeOnOtherPanel);
    };
  }, []);

  const send = useMutation({
    mutationFn: (): Promise<{ data: BulkEmailResult }> => {
      const endpoint = target?.role === 'manager' ? '/managers/bulk-email' : '/staff/bulk-email';
      return api.post(endpoint, { userIds: target?.userIds ?? [], subject, message });
    },
    onSuccess: ({ data }) => setResult(data),
    onError: (e: any) => {
      const msg = e?.response?.data?.message;
      setError(Array.isArray(msg) ? msg.join(', ') : msg ?? 'Failed to send.');
    },
  });

  const isDirty = Boolean((subject || message) && !result);
  const canSubmit = Boolean(subject.trim() && message.trim());
  const close = () => setOpen(false);

  const recipientLabel = useMemo(() => {
    if (!target) return '';
    if (target.names.length <= 3) return target.names.join(', ');
    return `${target.names.slice(0, 3).join(', ')} +${target.names.length - 3} more`;
  }, [target]);

  return (
    <Drawer
      open={open}
      onClose={close}
      title="Send email"
      description={target ? `${target.userIds.length} recipient${target.userIds.length === 1 ? '' : 's'}` : undefined}
      loading={send.isPending}
      dirty={isDirty}
      footer={
        result ? (
          <button className="btn btn-dark" onClick={close}>Done</button>
        ) : (
          <>
            <button className="btn btn-outline" onClick={close}>Cancel</button>
            <button className="btn btn-dark" disabled={!canSubmit || send.isPending} onClick={() => { setError(''); send.mutate(); }}>
              {send.isPending ? 'Sending…' : 'Send'}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 13 }}>
            Queued for delivery to {result.queued} recipient{result.queued === 1 ? '' : 's'}.
            {result.skipped > 0 && ` ${result.skipped} selected ${result.skipped === 1 ? 'user was' : 'users were'} skipped (outside your access).`}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>To</label>
            <input readOnly value={recipientLabel} style={{ background: 'var(--bg-secondary)', cursor: 'not-allowed' }} />
          </div>
          <div className="field">
            <label>Subject</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
          </div>
          <div className="field">
            <label>Message</label>
            <textarea rows={8} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Write your message…" />
          </div>
          <p className="field-hint">
            Sent through the same delivery queue as every other RAB email — recipients receive it shortly, not instantly.
          </p>
          {error && <p className="error" style={{ margin: '4px 0' }}>{error}</p>}
        </div>
      )}
    </Drawer>
  );
}
