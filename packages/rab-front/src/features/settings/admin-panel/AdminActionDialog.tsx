import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import ModalFrame from '../../../shared/components/ModalFrame';
import { getApiErrorCode, getApiErrorMessage } from '../../../shared/lib/apiError';

export interface AdminActionInput {
  reason: string;
  currentPassword: string;
  code: string;
  extra: string;
}

export interface AdminActionDialogProps {
  title: string;
  body?: ReactNode;
  /** A warning notice above the fields (e.g. the Reset 2FA design's "This removes their authenticator…"). */
  notice?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /** Danger confirm drawn as an outline (the account-security design's reset button) instead of solid. */
  dangerOutline?: boolean;
  /** Password and code stacked full width (account-security design) instead of side by side (Admin panel mockup). */
  stacked?: boolean;
  /** Collect a reason (3–500 characters). Default true. */
  reason?: boolean;
  /** Show "Your password" + "Your 2FA code (only if you use 2FA)". Default true. */
  stepUp?: boolean;
  /** The server needs the password inline on this route (legacy password-confirmed actions). */
  passwordRequired?: boolean;
  /** One extra typed confirmation (e.g. the organisation slug before a suspension). */
  extraField?: { label: string; placeholder?: string; mustEqual?: string };
  labels?: { password?: string; code?: string; codeHint?: string; reason?: string; reasonPlaceholder?: string };
  /** Server code → user text, for codes the shared normaliser does not phrase well. */
  errorText?: Record<string, string>;
  onConfirm: (input: AdminActionInput) => Promise<void>;
  onClose: () => void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * The ONE reason + step-up dialog of the Admin panel (mockup v2 `#modalBack`), built on the shared `ModalFrame`.
 *
 * Proof handling is the caller's adapter (see `adminPanelApi.ts`): routes that verify a recent step-up get the password
 * and code through `POST /auth/step-up` first; routes whose contract takes them inline get them inline. If the admin
 * leaves the password empty, the action goes out alone and the shared `StepUpHost` asks when the server answers
 * `STEP_UP_REQUIRED` — the dialog never prompts twice. Nothing here grants anything; every rule is server-side.
 *
 * a11y: role=dialog + aria-modal + labelled/described, focus moves in on open and is trapped (Tab / Shift+Tab), Escape
 * closes (unless a request is in flight), focus returns to the opener on close. The confirm button is disabled while a
 * request is pending (no double submit).
 */
export default function AdminActionDialog({
  title,
  body,
  notice,
  confirmLabel,
  tone = 'primary',
  dangerOutline = false,
  stacked = false,
  reason: needsReason = true,
  stepUp = true,
  passwordRequired = false,
  extraField,
  labels = {},
  errorText = {},
  onConfirm,
  onClose,
}: AdminActionDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const [reason, setReason] = useState('');
  const [currentPassword, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [extra, setExtra] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const opener = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);

  useEffect(() => {
    const first = formRef.current?.querySelector<HTMLElement>('textarea, input, button[type="submit"]');
    first?.focus();
    const back = opener.current;
    return () => {
      if (back instanceof HTMLElement && document.contains(back)) back.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !formRef.current) return;
      const nodes = Array.from(formRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const trimmedReason = reason.trim();
  const cleanCode = code.replace(/\s/g, '');
  const reasonOk = !needsReason || (trimmedReason.length >= 3 && trimmedReason.length <= 500);
  const codeOk = cleanCode === '' || /^\d{6}$/.test(cleanCode);
  const passwordOk = !passwordRequired || currentPassword.length > 0;
  const extraOk = !extraField || (extraField.mustEqual !== undefined ? extra.trim() === extraField.mustEqual : extra.trim().length > 0);
  const canSubmit = reasonOk && codeOk && passwordOk && extraOk && !busy;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) {
      if (!reasonOk) setError('Give a reason of 3 to 500 characters. It is saved to the audit log.');
      else if (!passwordOk) setError('Enter your password to continue.');
      else if (!codeOk) setError('Enter the six-digit code from your authenticator app, or leave it empty if you don’t use 2FA.');
      else if (!extraOk) setError(`Type ${extraField?.mustEqual ?? 'the confirmation'} exactly to continue.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onConfirm({ reason: trimmedReason, currentPassword, code: cleanCode, extra: extra.trim() });
    } catch (err) {
      const mapped = errorText[getApiErrorCode(err) ?? ''];
      setError(mapped ?? getApiErrorMessage(err, 'That didn’t work. Please try again.'));
      setCode('');
      setBusy(false);
    }
  }

  return (
    <ModalFrame
      open
      onBackdropMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      dialogClassName="ap-modal"
      dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': body ? bodyId : undefined }}
    >
      <form ref={formRef} onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 14 }} noValidate>
        <h3 id={titleId}>{title}</h3>
        {body && (
          <p className="ap-sub" id={bodyId}>
            {body}
          </p>
        )}
        {notice && <p className="ap-notice ap-warn" role="note">{notice}</p>}
        {stepUp && (
          <div className="ap-stepup" style={stacked ? { gridTemplateColumns: '1fr' } : undefined}>
            <label>
              {labels.password ?? 'Your password'}
              <input className="ap-input" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
            </label>
            <label>
              {labels.code ?? 'Your 2FA code (only if you use 2FA)'}
              <input
                className="ap-input ap-mono"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, '').slice(0, 7))}
                disabled={busy}
              />
            </label>
          </div>
        )}
        {stepUp && labels.codeHint && <p className="ap-hint">{labels.codeHint}</p>}
        {extraField && (
          <label>
            {extraField.label}
            <input className="ap-input ap-mono" value={extra} placeholder={extraField.placeholder} onChange={(e) => setExtra(e.target.value)} disabled={busy} autoComplete="off" />
          </label>
        )}
        {needsReason && (
          <label>
            {labels.reason ?? 'Reason (saved to the audit log)'}
            <textarea
              className="ap-input"
              rows={2}
              maxLength={500}
              placeholder={labels.reasonPlaceholder ?? 'Why are you doing this?'}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
            />
          </label>
        )}
        {error && (
          <p className="ap-error" role="alert">
            {error}
          </p>
        )}
        <div className="ap-actions">
          <button type="button" className="ap-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={`ap-btn ${tone === 'danger' ? (dangerOutline ? 'ap-danger-outline' : 'ap-danger-solid') : 'ap-primary'}`} disabled={busy} aria-disabled={!canSubmit}>
            {busy ? 'Please wait…' : confirmLabel}
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}
