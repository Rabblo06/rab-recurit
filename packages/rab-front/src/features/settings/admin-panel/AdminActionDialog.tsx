import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import ModalFrame from '../../../shared/components/ModalFrame';
import { getApiErrorCode, getApiErrorMessage, getApiFieldErrors } from '../../../shared/lib/apiError';
import { isSilentError, notifyApiError } from '../../../shared/lib/mutationFeedback';

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
  /** What failed, in the user's words, when the server gives nothing safer (e.g. "Could not sign Sam out."). */
  failureText?: string;
  onConfirm: (input: AdminActionInput) => Promise<void>;
  onClose: () => void;
}

type Field = 'reason' | 'password' | 'code' | 'extra';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const REASON_TEXT = 'Give a reason of 3 to 500 characters. It is saved to the audit log.';
const CODE_FORMAT_TEXT = 'Enter the six-digit code from your authenticator app, or leave it empty if you don’t use 2FA.';
const CODE_INVALID_TEXT = 'That code didn’t work. Enter the current code from your authenticator app.';
/** Server codes that belong under one field (the field shows the text; no toast — it is not a failure to retry). */
const FIELD_CODES: Record<string, Field> = { ADMIN_REASON_REQUIRED: 'reason', STEP_UP_MFA_INVALID: 'code' };

/**
 * The ONE reason + step-up dialog of the Admin panel (mockup v2 `#modalBack`), built on the shared `ModalFrame`.
 *
 * Proof handling is the caller's adapter (see `adminPanelApi.ts`): routes that verify a recent step-up get the password
 * and code through `POST /auth/step-up` first; routes whose contract takes them inline get them inline. If the admin
 * leaves the password empty, the action goes out alone and the shared `StepUpHost` asks when the server answers
 * `STEP_UP_REQUIRED` — the dialog never prompts twice. Nothing here grants anything; every rule is server-side.
 *
 * Feedback (owner rule, every admin mutation):
 *  - the confirm button shows "Please wait…" and is disabled while the request runs (no double submit), the form is
 *    `aria-busy` and a polite status line announces it;
 *  - success is reported by the CALLER, only after the server confirmed, from the confirmed response;
 *  - a failure keeps the dialog open with everything the admin typed (only a rejected one-time code is cleared);
 *  - field problems (reason, code format, slug, a server `ADMIN_REASON_REQUIRED` / `STEP_UP_MFA_INVALID`, a 400 naming
 *    `reason`) appear UNDER that field (`aria-invalid` + `aria-describedby`, announced as an alert);
 *  - anything else is a red toast through the shared `notifyApiError` (safe text only, never the raw server message;
 *    "Try again" when a retry can help) and the same text inside the dialog as an alert.
 *
 * a11y: role=dialog + aria-modal + labelled/described, focus moves in on open and is trapped (Tab / Shift+Tab), Escape
 * closes (unless a request is in flight), focus returns to the opener on close.
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
  failureText = 'That didn’t work. Please try again.',
  onConfirm,
  onClose,
}: AdminActionDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const fieldIds = { reason: useId(), password: useId(), code: useId(), extra: useId() };
  const [reason, setReason] = useState('');
  const [currentPassword, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [extra, setExtra] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const busyRef = useRef(false);
  const retryRef = useRef<() => void>(() => undefined);
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

  function validate(): Partial<Record<Field, string>> {
    const out: Partial<Record<Field, string>> = {};
    if (needsReason && (trimmedReason.length < 3 || trimmedReason.length > 500)) out.reason = REASON_TEXT;
    if (passwordRequired && currentPassword.length === 0) out.password = 'Enter your password to continue.';
    if (cleanCode !== '' && !/^\d{6}$/.test(cleanCode)) out.code = CODE_FORMAT_TEXT;
    if (extraField && (extraField.mustEqual !== undefined ? extra.trim() !== extraField.mustEqual : extra.trim().length === 0)) {
      out.extra = `Type ${extraField.mustEqual ?? 'the confirmation'} exactly to continue.`;
    }
    return out;
  }

  async function run(input: AdminActionInput): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      await onConfirm(input);
    } catch (err) {
      if (isSilentError(err)) return;
      const serverCode = getApiErrorCode(err) ?? '';
      const field = FIELD_CODES[serverCode] ?? (needsReason && getApiFieldErrors(err, { reason: REASON_TEXT }).reason ? 'reason' : undefined);
      if (field && (field !== 'code' || stepUp)) {
        setFieldErrors({ [field]: errorText[serverCode] ?? (field === 'reason' ? REASON_TEXT : CODE_INVALID_TEXT) });
        if (field === 'code') setCode(''); // a rejected one-time code is burned; everything else the admin typed stays
      } else {
        const options = { fallback: failureText, codes: errorText, retry: () => retryRef.current() };
        setError(errorText[serverCode] ?? getApiErrorMessage(err, options));
        notifyApiError(err, options);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busyRef.current) return;
    const problems = validate();
    if (Object.keys(problems).length > 0) {
      setError('');
      setFieldErrors(problems);
      const firstField = (['extra', 'reason', 'password', 'code'] as Field[]).find((f) => problems[f]);
      if (firstField) document.getElementById(fieldIds[firstField])?.focus();
      return;
    }
    const input = { reason: trimmedReason, currentPassword, code: cleanCode, extra: extra.trim() };
    retryRef.current = () => void run(input);
    await run(input);
  }

  // Exactly one alert is on screen at a time: the first field problem, or the general error.
  const firstFieldError = (['extra', 'reason', 'password', 'code'] as Field[]).find((f) => fieldErrors[f]);
  const fieldProps = (f: Field) => ({
    id: fieldIds[f],
    'aria-invalid': fieldErrors[f] ? true : undefined,
    'aria-describedby': fieldErrors[f] ? `${fieldIds[f]}-error` : undefined,
  });
  const fieldError = (f: Field) =>
    fieldErrors[f] ? (
      <span className="ap-field-error" id={`${fieldIds[f]}-error`} role={firstFieldError === f ? 'alert' : undefined}>
        {fieldErrors[f]}
      </span>
    ) : null;

  return (
    <ModalFrame
      open
      onBackdropMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      dialogClassName="ap-modal"
      dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': body ? bodyId : undefined }}
    >
      <form ref={formRef} onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 14 }} noValidate aria-busy={busy}>
        <h3 id={titleId}>{title}</h3>
        {body && (
          <p className="ap-sub" id={bodyId}>
            {body}
          </p>
        )}
        {notice && <p className="ap-notice ap-warn" role="note">{notice}</p>}
        {stepUp && (
          <div className="ap-stepup" style={stacked ? { gridTemplateColumns: '1fr' } : undefined}>
            <div className="ap-field">
              <label htmlFor={fieldIds.password}>{labels.password ?? 'Your password'}</label>
              <input
                className="ap-input"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                {...fieldProps('password')}
              />
              {fieldError('password')}
            </div>
            <div className="ap-field">
              <label htmlFor={fieldIds.code}>{labels.code ?? 'Your 2FA code (only if you use 2FA)'}</label>
              <input
                className="ap-input ap-mono"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, '').slice(0, 7))}
                disabled={busy}
                {...fieldProps('code')}
              />
              {fieldError('code')}
            </div>
          </div>
        )}
        {stepUp && labels.codeHint && <p className="ap-hint">{labels.codeHint}</p>}
        {extraField && (
          <div className="ap-field">
            <label htmlFor={fieldIds.extra}>{extraField.label}</label>
            <input className="ap-input ap-mono" value={extra} placeholder={extraField.placeholder} onChange={(e) => setExtra(e.target.value)} disabled={busy} autoComplete="off" {...fieldProps('extra')} />
            {fieldError('extra')}
          </div>
        )}
        {needsReason && (
          <div className="ap-field">
            <label htmlFor={fieldIds.reason}>{labels.reason ?? 'Reason (saved to the audit log)'}</label>
            <textarea
              className="ap-input"
              rows={2}
              maxLength={500}
              placeholder={labels.reasonPlaceholder ?? 'Why are you doing this?'}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              {...fieldProps('reason')}
            />
            {fieldError('reason')}
          </div>
        )}
        {error && !firstFieldError && (
          <p className="ap-error" role="alert">
            {error}
          </p>
        )}
        <span className="ap-sr-only" role="status" aria-live="polite">
          {busy ? 'Working on it, please wait.' : ''}
        </span>
        <div className="ap-actions">
          <button type="button" className="ap-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={`ap-btn ${tone === 'danger' ? (dangerOutline ? 'ap-danger-outline' : 'ap-danger-solid') : 'ap-primary'}`} disabled={busy} aria-disabled={busy}>
            {busy ? 'Please wait…' : confirmLabel}
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}
