import { useRef, useState } from 'react';

import { toast } from '../../../../shared/lib/toast';
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
 * The proof a change to an ENROLLED factor needs (regenerate recovery codes, turn off): identity (password inline, or a
 * fresh SSO re-auth / sign-in grant for an account without one) AND a current code or recovery code — rab-server
 * `assertIdentityProof(…, { requireFactor: true, allowRecoveryCode: true })`. One request in flight at a time; on any
 * failure the typed values are kept, the field error goes under its field, and a red toast says what to do next.
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
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    if (inFlight.current || !canSubmit) return { ok: false };
    inFlight.current = true;
    setBusy(true);
    setPasswordError(undefined);
    setCodeError(undefined);
    setFormError(undefined);
    try {
      const value = await call({
        currentPassword: withPassword ? password : undefined,
        code: proof.value.trim(),
      });
      return { ok: true, value };
    } catch (err) {
      const failure = proofFailureOf(err, proof.mode === 'recovery');
      if (failure.kind === 'wrong-password') {
        setPasswordError(WRONG_PASSWORD);
        toast.error(WRONG_PASSWORD);
      } else if (failure.kind === 'needs-reauth') {
        setNeedsReauth(true);
        toast.error('Confirm it’s you to continue.');
      } else if (failure.kind === 'bad-code') {
        setCodeError(failure.message);
        toast.error(failure.message);
      } else {
        const message = mfaErrorMessage(err, fallbackMessage);
        setFormError(message);
        toast.error(message);
      }
      return { ok: false };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
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
