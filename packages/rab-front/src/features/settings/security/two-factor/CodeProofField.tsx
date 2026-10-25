import OtpInput, { OTP_LENGTH } from '../../../auth/mfa/ui/OtpInput';
import { Notice, TextField } from '../../../auth/mfa/ui/primitives';

export interface CodeProof {
  mode: 'totp' | 'recovery';
  value: string;
}

export const EMPTY_CODE: CodeProof = { mode: 'totp', value: '' };

export function codeReady(proof: CodeProof): boolean {
  return proof.mode === 'totp'
    ? proof.value.length === OTP_LENGTH
    : proof.value.trim().length >= 6;
}

/**
 * The current code a change to an enrolled factor needs (regenerate / turn off): six digits from the authenticator, or
 * — "Use a recovery code instead" — one unused recovery code (the server accepts either for these two actions). A wrong
 * code is shown directly under the field and the typed value is kept.
 */
export default function CodeProofField({
  proof,
  onChange,
  error,
  errorId,
  disabled,
}: {
  proof: CodeProof;
  onChange: (proof: CodeProof) => void;
  error?: string;
  errorId: string;
  disabled?: boolean;
}) {
  return (
    <>
      {proof.mode === 'totp' ? (
        <>
          <OtpInput
            value={proof.value}
            onChange={(value) => onChange({ mode: 'totp', value })}
            invalid={Boolean(error)}
            describedBy={error ? errorId : undefined}
            disabled={disabled}
          />
          {error && (
            <Notice tone="error" live id={errorId}>
              {error}
            </Notice>
          )}
        </>
      ) : (
        <TextField
          label="Recovery code"
          value={proof.value}
          onChange={(value) => onChange({ mode: 'recovery', value })}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          error={error}
          disabled={disabled}
          autoFocus
        />
      )}
      <button
        type="button"
        className="acs-link acs-link--start"
        // Switching mid-request would clear the code being checked and change what the answer refers to.
        disabled={disabled}
        onClick={() =>
          onChange({
            mode: proof.mode === 'totp' ? 'recovery' : 'totp',
            value: '',
          })
        }
      >
        {proof.mode === 'totp'
          ? 'Use a recovery code instead'
          : 'Use an authenticator code instead'}
      </button>
    </>
  );
}
