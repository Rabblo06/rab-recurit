import { useEffect, useId, useRef, useState } from 'react';

import ModalFrame from '../../../shared/components/ModalFrame';
import { useFeedbackMutation } from '../../../shared/hooks/useFeedbackMutation';
import { getApiErrorCode } from '../../../shared/lib/apiError';

export const REASON_MIN = 3;
export const REASON_MAX = 500;

/**
 * The one "why are you changing this?" dialog of Settings → AI (model pins, level policy, workspace instructions, skills).
 * The reason (3–500 characters) is saved to the audit log server-side; a 403 STEP_UP_REQUIRED is answered by the shared
 * StepUpHost ("Confirm it's you") and the request is replayed once. Success is announced only after the server answered;
 * a refusal the server explains with a code is shown inside the dialog (one announcement, never a toast as well).
 */
export default function AiReasonDialog<T>({
  title,
  body,
  confirmLabel = 'Save',
  destructive = false,
  run,
  successMessage,
  inlineErrors = {},
  onDone,
  onClose,
  onRefused,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  destructive?: boolean;
  run: (reason: string) => Promise<T>;
  successMessage: string;
  /** Server error code → text shown inside the dialog (no toast). */
  inlineErrors?: Record<string, string>;
  onDone: (result: T) => void;
  onClose: () => void;
  /** Told the server's error code after a refusal (e.g. re-read a list the server says is stale). */
  onRefused?: (code: string | null) => void;
}) {
  const titleId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const save = useFeedbackMutation<T, { reason: string }>({
    mutationFn: ({ reason: r }) => run(r),
    successMessage,
    errorFeedback: (err) => {
      const code = getApiErrorCode(err);
      if (code === 'STEP_UP_REQUIRED' || (code && inlineErrors[code])) return false;
      return { fallback: 'The change could not be saved. Please try again.' };
    },
    onSuccess: (result) => onDone(result),
    onError: (err) => {
      const code = getApiErrorCode(err);
      onRefused?.(code);
      if (code === 'STEP_UP_REQUIRED') setError('The change was not saved because your identity was not confirmed.');
      else if (code && inlineErrors[code]) setError(inlineErrors[code]!);
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !save.busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [save.busy, onClose]);

  const submit = () => {
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
      setFieldError(`Give a reason of ${REASON_MIN} to ${REASON_MAX} characters. It is saved to the audit log.`);
      inputRef.current?.focus();
      return;
    }
    setFieldError('');
    setError('');
    save.submit({ reason: trimmed });
  };

  return (
    <ModalFrame
      open
      onBackdropMouseDown={(e) => {
        if (e.target === e.currentTarget && !save.busy) onClose();
      }}
      dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }}
    >
      <form noValidate aria-busy={save.busy || undefined} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h3 id={titleId}>{title}</h3>
        <p className="ai-set-dialog-body">{body}</p>
        <div className="field">
          <label htmlFor={reasonId}>Reason (saved to the audit log)</label>
          <textarea
            id={reasonId}
            ref={inputRef}
            rows={3}
            maxLength={REASON_MAX}
            value={reason}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${reasonId}-error` : undefined}
            onChange={(e) => setReason(e.target.value)}
          />
          {fieldError && <span id={`${reasonId}-error`} className="ai-set-field-error" role="alert">{fieldError}</span>}
        </div>
        {error && <p className="ai-set-notice" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={save.busy}>Cancel</button>
          <button type="submit" className={destructive ? 'btn btn-danger' : 'btn btn-dark'} disabled={save.busy}>{save.busy ? 'Please wait…' : confirmLabel}</button>
        </div>
      </form>
    </ModalFrame>
  );
}

/** "Not available yet": a section whose server API is not on this server. Honest text, never placeholder data. */
export function NotAvailableYet({ children }: { children: string }) {
  return <p className="ai-set-pending" role="note">Not available yet. {children}</p>;
}
