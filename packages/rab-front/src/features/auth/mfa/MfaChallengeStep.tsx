import { useRef, useState, type FormEvent, type ReactNode } from 'react';

import { api, withAuthLock } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import {
  challengeFailureOf,
  EnrolmentMaterial,
  minutesLabel,
  SecondFactorChallenge,
  triesLeftLabel,
  type ChallengeFailure,
} from './mfaApi';
import OtpInput, { OTP_LENGTH } from './ui/OtpInput';
import { Emblem, Notice, TextField } from './ui/primitives';
import RecoveryCodesPanel from './ui/RecoveryCodesPanel';
import ScanBlock from './ui/ScanBlock';
import type { AcsIconName } from './ui/icons';

/** What a completed challenge returns (same body as a successful /auth/login for the web). */
export interface SignedInBody {
  mustResetPassword: boolean;
  sessionExpiresAt?: string;
}

type View =
  | { kind: 'code' }
  | { kind: 'recovery' }
  | { kind: 'expired' }
  | { kind: 'locked' }
  | { kind: 'rate-limited'; minutes: number }
  | { kind: 'enrol-intro' }
  | { kind: 'enrol-scan'; material: EnrolmentMaterial }
  | { kind: 'enrol-codes'; codes: string[]; body: SignedInBody };

/** An inline problem on a still-usable view: a wrong code (with the server's own attempt count) or anything else. */
type InlineError =
  | { kind: 'invalid'; attemptsRemaining?: number }
  | { kind: 'message'; message: string }
  | null;

const SUPPORT_CAPTION = (
  <p className="acs-caption">
    Lost your phone and recovery codes?
    <br />
    Contact your workspace admin or Crewflow support.
  </p>
);

/**
 * The second step of a sign-in that answered 409 SECOND_FACTOR_REQUIRED (password, Google or Microsoft), in the
 * account-security design (sign-in states code / invalid / recovery / expired / locked). Every state comes from the
 * server's answer (`MfaLoginService` failure states): `MFA_CODE_INVALID` + `attemptsRemaining` → invalid ("N tries left"
 * only when the server sent it), `MFA_CHALLENGE_EXPIRED` → expired, `MFA_CHALLENGE_EXHAUSTED` → locked, 429
 * `MFA_RATE_LIMITED` → too many attempts with the server's retry time. The session cookies are set by the server only
 * when this step succeeds.
 *
 * `enroll` (an enforced role with no factor yet — dormant while every AUTH_MFA_ENFORCE_* flag is off): set it up right
 * here — QR + manual key, confirm with the first code, save the recovery codes — and the sign-in finishes.
 */
export default function MfaChallengeStep({
  challenge,
  email,
  onSignedIn,
  onRestart,
}: {
  challenge: SecondFactorChallenge;
  /** The email typed in the password step (the account chip). Unknown after Google/Microsoft → no chip. */
  email?: string;
  onSignedIn: (body: SignedInBody) => void | Promise<void>;
  onRestart: () => void;
}) {
  const [view, setView] = useState<View>(
    challenge.requirement === 'enroll'
      ? { kind: 'enrol-intro' }
      : { kind: 'code' },
  );
  const [code, setCode] = useState('');
  const [error, setError] = useState<InlineError>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const busyRef = useRef(false);

  function setBusyBoth(value: boolean): void {
    busyRef.current = value;
    setBusy(value);
  }

  /** Maps a failure to the next view (dead challenge) or an inline error (still usable). */
  function fail(err: unknown): void {
    const failure: ChallengeFailure = challengeFailureOf(err);
    // Same feedback system as every other mutation (a red toast), in addition to the design's inline notice / view.
    if (failure.kind === 'expired') {
      setView({ kind: 'expired' });
      toast.error('Your sign-in session expired. Sign in again to continue.');
    } else if (failure.kind === 'locked') {
      setView({ kind: 'locked' });
      toast.error('Too many incorrect codes. Sign in again to continue.');
    } else if (failure.kind === 'rate-limited') {
      setView({ kind: 'rate-limited', minutes: failure.minutes });
      toast.error(
        `Too many attempts. Try again in ${minutesLabel(failure.minutes)}.`,
      );
    } else if (failure.kind === 'invalid') {
      setError({
        kind: 'invalid',
        attemptsRemaining: failure.attemptsRemaining,
      });
      toast.error(
        `That code didn’t work. Check it and try again.${failure.attemptsRemaining !== undefined ? ` ${triesLeftLabel(failure.attemptsRemaining)}` : ''}`,
      );
    } else {
      setError({ kind: 'message', message: failure.message });
      toast.error(failure.message);
    }
    setBusyBoth(false);
  }

  async function verify(value: string): Promise<void> {
    const trimmed = value.trim();
    if (busyRef.current || !trimmed) return;
    setBusyBoth(true);
    setError(null);
    try {
      const { data } = await withAuthLock(() =>
        api.post<SignedInBody>('/auth/mfa/challenge/verify', {
          challengeToken: challenge.challengeToken,
          code: trimmed,
        }),
      );
      await onSignedIn(data);
    } catch (err) {
      fail(err);
    }
  }

  async function startEnrolment(): Promise<void> {
    setBusyBoth(true);
    setError(null);
    try {
      const { data } = await api.post<EnrolmentMaterial>(
        '/auth/mfa/challenge/enrolment',
        { challengeToken: challenge.challengeToken },
      );
      setView({ kind: 'enrol-scan', material: data });
      setBusyBoth(false);
    } catch (err) {
      fail(err);
    }
  }

  async function confirmEnrolment(): Promise<void> {
    if (busyRef.current || code.length < OTP_LENGTH) return;
    setBusyBoth(true);
    setError(null);
    try {
      const { data } = await withAuthLock(() =>
        api.post<SignedInBody & { recoveryCodes: string[] }>(
          '/auth/mfa/challenge/enrolment/confirm',
          { challengeToken: challenge.challengeToken, code },
        ),
      );
      const { recoveryCodes, ...body } = data;
      setCode('');
      setSaved(false);
      setView({ kind: 'enrol-codes', codes: recoveryCodes, body });
      setBusyBoth(false);
    } catch (err) {
      fail(err);
    }
  }

  async function cancel(): Promise<void> {
    try {
      await api.post('/auth/mfa/challenge/cancel', {
        challengeToken: challenge.challengeToken,
      });
    } catch {
      // Expired or already used — nothing to cancel.
    }
    onRestart();
  }

  function switchTo(next: 'code' | 'recovery'): void {
    setCode('');
    setError(null);
    setView({ kind: next });
  }

  const errorId = 'mfa-challenge-error';
  const errorNotice = (recovery: boolean) =>
    error && (
      <div id={errorId}>
        <Notice tone="error" live>
          {error.kind === 'invalid'
            ? `${recovery ? 'That recovery code didn’t work. Check it and try again.' : 'That code didn’t work. Check your app and try again.'}${
                error.attemptsRemaining !== undefined
                  ? ` ${triesLeftLabel(error.attemptsRemaining)}`
                  : ''
              }`
            : error.message}
        </Notice>
      </div>
    );

  if (
    view.kind === 'expired' ||
    view.kind === 'locked' ||
    view.kind === 'rate-limited'
  ) {
    const title =
      view.kind === 'expired'
        ? 'Your sign-in session expired'
        : view.kind === 'locked'
          ? 'Let’s start again'
          : 'Too many attempts';
    const description =
      view.kind === 'expired'
        ? 'For your security, this verification session has ended. Sign in again to request a new session.'
        : view.kind === 'locked'
          ? `Too many incorrect codes were entered. Sign in${email ? ' with your password' : ''} again to continue.`
          : `Too many verification attempts were made. Try again in ${minutesLabel(view.minutes)}.`;
    const note =
      view.kind === 'expired'
        ? 'Verification sessions expire after a few minutes.'
        : view.kind === 'locked'
          ? 'Verification is temporarily unavailable for this session.'
          : 'Verification is temporarily unavailable for this account.';
    return (
      <>
        <Head icon="shield" title={title} description={description} />
        <div className="acs-stack">
          <Notice tone="warning" live>
            {note}
          </Notice>
        </div>
        <div className="acs-auth-actions">
          <button
            type="button"
            className="acs-btn acs-btn--primary"
            autoFocus
            onClick={
              view.kind === 'rate-limited' ? () => void cancel() : onRestart
            }
          >
            Back to sign in
          </button>
          {SUPPORT_CAPTION}
        </div>
      </>
    );
  }

  if (view.kind === 'enrol-intro') {
    return (
      <>
        <Head
          icon="shield"
          title="Set up two-factor authentication"
          description="Your organisation requires a second step for this account. You’ll need an authenticator app such as Google Authenticator, Microsoft Authenticator or 1Password."
        />
        {error && <div className="acs-stack">{errorNotice(false)}</div>}
        <div className="acs-auth-actions">
          <button
            type="button"
            className="acs-btn acs-btn--primary"
            disabled={busy}
            onClick={() => void startEnrolment()}
          >
            {busy ? 'Preparing…' : 'Set up now'}
          </button>
          <button
            type="button"
            className="acs-link"
            onClick={() => void cancel()}
          >
            Back to sign in
          </button>
        </div>
      </>
    );
  }

  if (view.kind === 'enrol-scan') {
    return (
      <>
        <Head
          icon="shield"
          title="Connect your authenticator"
          description="Scan the QR code with your authenticator app, then enter the 6-digit code."
        />
        <Form onSubmit={() => void confirmEnrolment()}>
          <div className="acs-stack">
            <ScanBlock material={view.material} />
            <OtpInput
              value={code}
              onChange={(v) => {
                setCode(v);
                if (error) setError(null);
              }}
              invalid={error?.kind === 'invalid'}
              describedBy={error ? errorId : undefined}
              autoFocus
            />
            {errorNotice(false)}
          </div>
          <div className="acs-auth-actions">
            <button
              type="submit"
              className="acs-btn acs-btn--primary"
              disabled={busy || code.length < OTP_LENGTH}
            >
              {busy ? 'Checking…' : 'Turn on and sign in'}
            </button>
            <button
              type="button"
              className="acs-link"
              onClick={() => void cancel()}
            >
              Back to sign in
            </button>
          </div>
        </Form>
      </>
    );
  }

  if (view.kind === 'enrol-codes') {
    return (
      <>
        <Head
          icon="key"
          title="Save your recovery codes"
          description="Each code can be used once if you lose access to your authenticator. You won’t see these codes again."
        />
        <div className="acs-stack">
          <Notice tone="success" live>
            Two-factor authentication is on.
          </Notice>
          <RecoveryCodesPanel
            codes={view.codes}
            accountLabel={email}
            acknowledged={saved}
            onAcknowledgedChange={setSaved}
          />
        </div>
        <div className="acs-auth-actions">
          <button
            type="button"
            className="acs-btn acs-btn--primary"
            disabled={!saved}
            onClick={() => void onSignedIn(view.body)}
          >
            Continue
          </button>
        </div>
      </>
    );
  }

  const recovery = view.kind === 'recovery';
  const avatar = email?.trim().charAt(0).toUpperCase();
  return (
    <>
      <Head
        icon={recovery ? 'key' : 'shield'}
        title={recovery ? 'Use a recovery code' : 'Verify your sign-in'}
        description={
          recovery
            ? 'Enter one of the recovery codes you saved when you turned on two-factor authentication.'
            : 'Open your authenticator app and enter the 6-digit code for Crewflow.'
        }
      />
      <Form onSubmit={() => void verify(code)}>
        <div className="acs-stack">
          {recovery ? (
            <>
              <TextField
                label="Recovery code"
                value={code}
                onChange={(v) => {
                  setCode(v);
                  if (error) setError(null);
                }}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                invalid={error?.kind === 'invalid'}
                describedBy={error ? errorId : undefined}
                autoFocus
              />
              {errorNotice(true)}
              <Notice>
                Each recovery code works once. It will be used after you sign
                in.
              </Notice>
            </>
          ) : (
            <>
              {email && (
                <div className="acs-account-chip">
                  <span className="acs-avatar" aria-hidden="true">
                    {avatar}
                  </span>
                  <span>
                    <span className="acs-visually-hidden">Signing in as </span>
                    {email}
                  </span>
                </div>
              )}
              <OtpInput
                value={code}
                onChange={(v) => {
                  setCode(v);
                  if (error) setError(null);
                }}
                onComplete={(v) => void verify(v)}
                invalid={error?.kind === 'invalid'}
                describedBy={error ? errorId : undefined}
                disabled={busy}
                autoFocus
              />
              {errorNotice(false)}
            </>
          )}
        </div>
        <div className="acs-auth-actions">
          <button
            type="submit"
            className="acs-btn acs-btn--primary"
            disabled={
              busy ||
              (recovery ? code.trim().length < 6 : code.length < OTP_LENGTH)
            }
          >
            {busy ? 'Verifying…' : recovery ? 'Verify recovery code' : 'Verify'}
          </button>
          <button
            type="button"
            className="acs-link"
            onClick={() => switchTo(recovery ? 'code' : 'recovery')}
          >
            {recovery
              ? 'Use an authenticator code instead'
              : 'Use a recovery code'}
          </button>
          <button
            type="button"
            className="acs-link"
            onClick={() => void cancel()}
          >
            Back to sign in
          </button>
        </div>
      </Form>
    </>
  );
}

function Head({
  icon,
  title,
  description,
}: {
  icon: AcsIconName;
  title: string;
  description: string;
}) {
  return (
    <div className="acs-auth-head">
      <Emblem icon={icon} />
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}

function Form({
  onSubmit,
  children,
}: {
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <form
      className="acs-auth-form"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}
