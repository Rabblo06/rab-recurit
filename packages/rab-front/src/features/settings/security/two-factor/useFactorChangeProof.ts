import { useRef, useState } from 'react';

import { getApiErrorStatus } from '../../../../shared/lib/apiError';
import { notifyApiError } from '../../../../shared/lib/mutationFeedback';
import {
  mfaErrorMessage,
  proofFailureOf,
  type MfaStatus,
  type OptionalProof,
} from '../../../auth/mfa/mfaApi';
import { codeReady, EMPTY_CODE, type CodeProof } from './CodeProofField';
import { usesPassword } from './ConfirmIdentityFields';

const WRONG_PASSWORD = 'That password didn’t work. Check it and try again.';

/**
 * An expired session is the one failure these dialogs cannot show usefully inline: the persistent "Sign in again" toast
 * (shared `notifyApiError`) is its only announcement. Returns true when it handled the error.
 */
export function reportExpiredSession(err: unknown, fallback: string): boolean {
  if (getApiErrorStatus(err) !== 401) return false;
  notifyApiError(err, { fallback });
  return true;
}

/**
 * The proof a change to an ENROLLED factor needs (regenerate recovery codes, turn off): identity (password inline, or a
 * fresh SSO re-auth / sign-in grant for an account without one) AND a current code or recovery code — rab-server
 * `assertIdentityProof(…, { requireFactor: true, allowRecoveryCode: true })`. One request in flight at a time; on any
 * failure the typed values are kept and the error is shown ONCE, inside the dialog: under its field (password, code) or
 * as the dialog's alert. No toast on top of it (one announcement per error); only an expired session gets the
 * persistent "Sign in again" toast instead.
 *
 * `run(call, afterSuccess)` keeps the request "in flight" (busy, guarded) until `afterSuccess` has finished too, e.g.
 * re-reading the page's status, so the submit can't be pressed again during that refetch.
 */
export function useFactorChangeProof(
  status: MfaStatus,
  fallbackMessage: string,
) {
  const withPassword = usesPassword(status);
  const [password, setPasswordRaw] = useState('');
  const [passwordError, setPasswordError] = useState<string>();
  const [proof, setProofRaw] = useState<CodeProof>(EMPTY_CODE);
  const [codeError, setCodeError] = useState<string>();
  const [needsReauth, setNeedsReauth] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const canSubmit =
    !busy && codeReady(proof) && (!withPassword || password.length > 0);

  function setPassword(value: string): void {
    setPasswordRaw(value);
    setPasswordError(undefined);
  }

  function setProof(next: CodeProof): void {
    setProofRaw(next);
    setCodeError(undefined);
  }

  async function run<T>(
    call: (proof: OptionalProof) => Promise<T>,
    afterSuccess?: (value: T) => Promise<unknown> | unknown,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    if (inFlight.current || !canSubmit) return { ok: false };
    inFlight.current = true;
    setBusy(true);
    setPasswordError(undefined);
    setCodeError(undefined);
    setFormError(undefined);
    let value: T;
    try {
      value = await call({
        currentPassword: withPassword ? password : undefined,
        code: proof.value.trim(),
      });
    } catch (err) {
      const failure = proofFailureOf(err, proof.mode === 'recovery');
      if (failure.kind === 'wrong-password') setPasswordError(WRONG_PASSWORD);
      else if (failure.kind === 'needs-reauth') setNeedsReauth(true);
      else if (failure.kind === 'bad-code') setCodeError(failure.message);
      else if (!reportExpiredSession(err, fallbackMessage))
        setFormError(mfaErrorMessage(err, fallbackMessage));
      inFlight.current = false;
      setBusy(false);
      return { ok: false };
    }
    try {
      // The server already confirmed: a failed refresh here must not turn the success into an error.
      await afterSuccess?.(value);
    } catch {
      // The page re-reads its status on the next visit / its own refetch.
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    return { ok: true, value };
  }

  return {
    withPassword,
    password,
    setPassword,
    passwordError,
    proof,
    setProof,
    codeError,
    needsReauth,
    formError,
    busy,
    canSubmit,
    run,
  };
}
